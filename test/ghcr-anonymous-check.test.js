// Test del controllo bloccante di accesso anonimo a GHCR (scripts/check-ghcr-anonymous.mjs).
// Un finto registry HTTP locale riproduce le risposte reali di GHCR: token anonimo,
// indice multi-arch, manifest per piattaforma, blob di configurazione (con redirect
// come il CDN di GitHub). Nessuna credenziale e nessuna richiesta verso Internet.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAnonymousPull, main, CheckError } from '../scripts/check-ghcr-anonymous.mjs';

const REPO = 'owner/app';
const TAG = '1.0.0-rc.9';
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_IMAGE = 'application/vnd.oci.image.manifest.v1+json';

function buildImage(os, architecture) {
  const config = JSON.stringify({ os, architecture, config: {} });
  const layer = `layer-${architecture}`;
  const manifest = JSON.stringify({
    schemaVersion: 2, mediaType: OCI_IMAGE,
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha(config), size: config.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: sha(layer), size: layer.length }],
  });
  return { config, manifest, platform: { os, architecture } };
}

// Scenario di default: come la rc.2 reale (amd64, arm64 e due attestazioni).
function scenario(overrides = {}) {
  const images = overrides.images || [buildImage('linux', 'amd64'), buildImage('linux', 'arm64')];
  const entries = images.map((im) => ({ mediaType: OCI_IMAGE, digest: sha(im.manifest), size: im.manifest.length, platform: im.platform }));
  const att = JSON.stringify({ schemaVersion: 2, mediaType: OCI_IMAGE, config: {}, layers: [] });
  for (const im of images) {
    entries.push({
      mediaType: OCI_IMAGE, digest: sha(att + im.platform.architecture), size: 1,
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': sha(im.manifest) },
    });
  }
  const index = overrides.index ?? JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: entries });
  return {
    tokenStatus: 200, tokenBody: JSON.stringify({ token: 'anon-test-token' }),
    indexStatus: 200, index, indexDigest: sha(index), images,
    ...overrides,
  };
}

let server, base, current, requests;
function handler(req, res) {
  const s = current;
  const url = new URL(req.url, base);
  requests.push({ path: url.pathname, auth: req.headers.authorization || null });
  if (s.hang?.(url.pathname)) return; // nessuna risposta: deve scattare il timeout
  if (s.drop?.(url.pathname)) { req.socket.destroy(); return; }
  if (url.pathname === '/token') {
    if (url.searchParams.get('scope') !== `repository:${REPO}:pull`) { res.writeHead(400).end(); return; }
    res.writeHead(s.tokenStatus, { 'Content-Type': 'application/json' }).end(s.tokenBody);
    return;
  }
  const authed = req.headers.authorization === 'Bearer anon-test-token';
  if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"errors":[{"code":"UNAUTHORIZED"}]}'); return; }
  const m = url.pathname.match(/^\/v2\/owner\/app\/(manifests|blobs)\/(.+)$/);
  if (m && m[1] === 'manifests' && m[2] === TAG) {
    if (s.indexStatus !== 200) { res.writeHead(s.indexStatus).end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}'); return; }
    const h = { 'Content-Type': OCI_INDEX };
    if (s.indexDigest !== null) h['Docker-Content-Digest'] = s.indexDigest;
    res.writeHead(200, h).end(s.index);
    return;
  }
  for (const im of s.images) {
    if (m && m[1] === 'manifests' && m[2] === sha(im.manifest)) {
      if (s.imageStatus) { res.writeHead(s.imageStatus).end(); return; }
      res.writeHead(200, { 'Content-Type': OCI_IMAGE, 'Docker-Content-Digest': sha(im.manifest) }).end(im.manifest);
      return;
    }
    if (m && m[1] === 'blobs' && m[2] === sha(im.config)) {
      // GHCR risponde 307 verso il CDN: il controllo deve seguire il redirect.
      res.writeHead(307, { Location: `/cdn/${m[2]}` }).end();
      return;
    }
  }
  const cdn = url.pathname.match(/^\/cdn\/(.+)$/);
  if (cdn) {
    const im = s.images.find((i) => sha(i.config) === cdn[1]);
    if (im) { res.writeHead(200).end(s.configOverride?.(im) ?? im.config); return; }
  }
  res.writeHead(404).end();
}

const run = (over = {}, opts = {}) => {
  current = scenario(over);
  requests = [];
  return checkAnonymousPull({ repository: REPO, tag: TAG, registry: base, timeoutMs: 1000, ...opts });
};
const fails = (promise, re) => assert.rejects(promise, (e) => e instanceof CheckError && re.test(e.message));

describe('Controllo anonimo GHCR (scripts/check-ghcr-anonymous.mjs)', () => {
  before(async () => {
    server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

  test('1/9. token 200, indice corretto con amd64 e arm64: successo con digest e piattaforme', async () => {
    const s = scenario();
    const r = await run({}, { expectDigest: s.indexDigest });
    assert.equal(r.digest, s.indexDigest);
    assert.deepEqual(Object.keys(r.platforms), ['linux/amd64', 'linux/arm64']);
    assert.equal(r.platforms['linux/amd64'], sha(s.images[0].manifest));
    assert.equal(r.platforms['linux/arm64'], sha(s.images[1].manifest));
    // Il token è chiesto senza credenziali; manifest e configurazioni di entrambe le piattaforme sono scaricati.
    assert.equal(requests[0].path, '/token');
    assert.equal(requests[0].auth, null);
    for (const im of s.images) {
      assert.ok(requests.some((q) => q.path.endsWith(`/manifests/${sha(im.manifest)}`)));
      assert.ok(requests.some((q) => q.path === `/cdn/${sha(im.config)}`), 'redirect del blob seguito');
    }
  });

  test('9b. successo anche senza --expect-digest (digest comunque verificato sul contenuto)', async () => {
    const r = await run();
    assert.match(r.digest, /^sha256:[a-f0-9]{64}$/);
  });

  test('2. token anonimo HTTP 401 (pacchetto privato): fallimento', async () => {
    await fails(run({ tokenStatus: 401, tokenBody: '{"errors":[{"code":"UNAUTHORIZED"}]}' }), /token anonimo: HTTP 401, il pacchetto non è pubblico/);
  });

  test('3. token anonimo HTTP 403: fallimento', async () => {
    await fails(run({ tokenStatus: 403, tokenBody: '{"errors":[{"code":"DENIED"}]}' }), /token anonimo: HTTP 403/);
  });

  test('token 200 ma senza campo token o con corpo non JSON: fallimento', async () => {
    await fails(run({ tokenBody: '{}' }), /campo "token" assente/);
    await fails(run({ tokenBody: '{"token":""}' }), /campo "token" assente/);
    await fails(run({ tokenBody: '<html>' }), /non è JSON valido/);
  });

  test('4. manifest del tag HTTP 404: fallimento', async () => {
    await fails(run({ indexStatus: 404 }), new RegExp(`manifest ${TAG.replace(/\./g, '\\.')}: HTTP 404`));
  });

  test('manifest del tag HTTP 401 o 500: fallimento', async () => {
    await fails(run({ indexStatus: 401 }), /HTTP 401/);
    await fails(run({ indexStatus: 500 }), /HTTP 500, errore del registry/);
  });

  test('5. indice senza amd64: fallimento', async () => {
    await fails(run({ images: [buildImage('linux', 'arm64')] }), /piattaforma linux\/amd64 assente/);
  });

  test('6. indice senza arm64: fallimento', async () => {
    await fails(run({ images: [buildImage('linux', 'amd64')] }), /piattaforma linux\/arm64 assente/);
  });

  test('le attestazioni non contano come piattaforme', async () => {
    const index = JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [
      { mediaType: OCI_IMAGE, digest: sha('x'), size: 1, platform: { os: 'linux', architecture: 'amd64' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
    ] });
    await fails(run({ index }), /linux\/amd64 assente/);
  });

  test('manifest a singola architettura (non indice): fallimento', async () => {
    const im = buildImage('linux', 'amd64');
    await fails(run({ index: im.manifest, images: [im] }), /non è un indice multi-architettura/);
  });

  test('7. digest mancante o malformato: fallimento', async () => {
    await fails(run({ indexDigest: null }), /Docker-Content-Digest assente/);
    await fails(run({ indexDigest: 'sha256:abc' }), /digest malformato/);
    await fails(run({ indexDigest: 'md5:' + 'a'.repeat(32) }), /digest malformato/);
    await fails(run({}, { expectDigest: '' }), /digest atteso mancante o malformato/);
    await fails(run({}, { expectDigest: 'sha256:XYZ' }), /digest atteso mancante o malformato/);
  });

  test('digest dichiarato diverso dal contenuto o da quello della build: fallimento', async () => {
    await fails(run({ indexDigest: sha('altro') }), /non corrisponde al digest dichiarato/);
    await fails(run({}, { expectDigest: sha('altra build') }), /diverso da quello della build/);
  });

  test('digest di piattaforma malformato nell\'indice: fallimento', async () => {
    const index = JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [
      { mediaType: OCI_IMAGE, digest: 'sha256:corto', platform: { os: 'linux', architecture: 'amd64' } },
    ] });
    await fails(run({ index }), /digest di linux\/amd64 mancante o malformato/);
  });

  test('manifest di piattaforma non scaricabile o configurazione incoerente: fallimento', async () => {
    await fails(run({ imageStatus: 401 }), /immagine linux\/amd64: HTTP 401/);
    await fails(run({ configOverride: () => '{"os":"linux","architecture":"amd64"}tampered' }), /configurazione linux\/amd64: contenuto non corrispondente/);
    const liar = buildImage('linux', 'arm64');
    const fake = { ...liar, platform: { os: 'linux', architecture: 'amd64' } };
    await fails(run({ images: [fake, buildImage('linux', 'arm64')] }), /configurazione linux\/amd64: dichiara linux\/arm64/);
  });

  test('8. timeout: fallimento (anche sul manifest)', async () => {
    await fails(run({ hang: (p) => p === '/token' }, { timeoutMs: 200 }), /token anonimo: timeout dopo 200 ms/);
    await fails(run({ hang: (p) => p.includes('/manifests/') }, { timeoutMs: 200 }), /manifest .*timeout dopo 200 ms/);
  });

  test('8. errore di rete (connessione chiusa o porta senza server): fallimento', async () => {
    await fails(run({ drop: (p) => p === '/token' }), /token anonimo: errore di rete/);
    const tmp = http.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const closed = `http://127.0.0.1:${tmp.address().port}`;
    await new Promise((r) => tmp.close(r));
    await fails(checkAnonymousPull({ repository: REPO, tag: TAG, registry: closed, timeoutMs: 1000 }), /errore di rete: ECONNREFUSED/);
  });

  test('parametri non validi e registry non https: fallimento prima di qualsiasi richiesta', async () => {
    await fails(run({}, { repository: 'Owner/App' }), /repository non valido/);
    await fails(run({}, { tag: '' }), /tag non valido/);
    await fails(run({}, { platforms: [] }), /nessuna piattaforma/);
    await fails(checkAnonymousPull({ repository: REPO, tag: TAG, registry: 'http://example.com' }), /registry non ammesso/);
  });

  test('CLI: exit 0 con riepilogo e output "digest", exit 1 con messaggio di errore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghcr-check-'));
    try {
      const env = { GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_OUTPUT: join(dir, 'out.txt') };
      current = scenario(); requests = [];
      const ok = await main(['--repository', REPO, '--tag', TAG, '--registry', base, '--expect-digest', current.indexDigest], env);
      assert.equal(ok, 0);
      assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), `digest=${current.indexDigest}\n`);
      assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), new RegExp(`✅.*\\n.*${current.indexDigest}`));
      current = scenario({ tokenStatus: 401 });
      assert.equal(await main(['--repository', REPO, '--tag', TAG, '--registry', base], env), 1);
      assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /❌ Verifica dell'accesso anonimo fallita: token anonimo: HTTP 401/);
      assert.equal(await main(['--repository', REPO], env), 1, 'tag obbligatorio');
      assert.equal(await main(['--repository', REPO, '--tag', TAG, '--expect-digest'], env), 1, 'valore mancante');
      assert.equal(await main(['--repository', REPO, '--tag', TAG, '--bogus', 'x'], env), 1, 'opzione sconosciuta');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('CLI eseguita come processo: il codice di uscita riflette l\'esito', async () => {
    const exec = (args) => new Promise((resolve) => {
      execFile(process.execPath, ['scripts/check-ghcr-anonymous.mjs', ...args], { env: { PATH: process.env.PATH } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    current = scenario(); requests = [];
    const ok = await exec(['--repository', REPO, '--tag', TAG, '--registry', base]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /OK: owner\/app:1\.0\.0-rc\.9 scaricabile senza autenticazione/);
    current = scenario({ indexStatus: 404 });
    const ko = await exec(['--repository', REPO, '--tag', TAG, '--registry', base]);
    assert.equal(ko.code, 1);
    assert.match(ko.stderr, /ERRORE: manifest 1\.0\.0-rc\.9: HTTP 404/);
  });
});

describe('Workflow CI: il controllo anonimo è bloccante', () => {
  const wf = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const docker = wf.slice(wf.indexOf('\n  docker:'));

  test('nessun continue-on-error nel job di pubblicazione', () => {
    assert.ok(docker.length > 20, 'job docker presente');
    assert.doesNotMatch(docker, /^\s*continue-on-error\s*:/m);
  });

  test('il passo usa lo script con tag e digest della build appena pubblicata', () => {
    assert.match(docker, /node scripts\/check-ghcr-anonymous\.mjs/);
    assert.match(docker, /--tag "\$\{\{ steps\.meta\.outputs\.version \}\}"/);
    assert.match(docker, /--expect-digest "\$\{\{ steps\.build\.outputs\.digest \}\}"/);
    assert.match(docker, /--platforms linux\/amd64,linux\/arm64/);
    // Il controllo viene dopo il push.
    assert.ok(docker.indexOf('check-ghcr-anonymous') > docker.indexOf('push: true'));
  });

  test('nessuna credenziale passata al controllo anonimo', () => {
    const start = docker.indexOf("- name: Verifica accesso anonimo all'immagine");
    assert.ok(start > 0, 'passo presente');
    const next = docker.indexOf('\n      - ', start + 1);
    const step = docker.slice(start, next === -1 ? undefined : next);
    assert.doesNotMatch(step, /GITHUB_TOKEN|secrets\.|continue-on-error|\|\| *true|set \+e/);
  });

  test('lo script non legge credenziali dall\'ambiente o da Docker', () => {
    const src = readFileSync(new URL('../scripts/check-ghcr-anonymous.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /GITHUB_TOKEN|\.docker\/config|DOCKER_AUTH|process\.env\.(?!GITHUB_STEP_SUMMARY|GITHUB_OUTPUT)/);
  });
});
