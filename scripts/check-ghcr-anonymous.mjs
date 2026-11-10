#!/usr/bin/env node
// Verifica che un'immagine pubblicata su GHCR sia scaricabile SENZA credenziali,
// come fa Umbrel. Usato dalla CI dopo il push (passo bloccante) e a mano.
//
// Controlli, tutti obbligatori (qualunque errore → exit 1):
//   1. token anonimo di pull: HTTP 200 e campo "token" non vuoto
//      (401 = pacchetto privato, 403 = nome inesistente o accesso negato);
//   2. manifest del tag, senza credenziali dell'utente: HTTP 200, deve essere un
//      indice multi-architettura (OCI image index o Docker manifest list);
//   3. digest dell'indice: header Docker-Content-Digest presente, formato
//      sha256:<64 hex>, uguale allo sha256 del contenuto ricevuto e, se indicato
//      con --expect-digest, uguale al digest prodotto dalla build;
//   4. piattaforme richieste (default linux/amd64 e linux/arm64) presenti
//      nell'indice; per ognuna il manifest e il blob di configurazione si
//      scaricano (HTTP 200) e la configurazione dichiara la stessa architettura.
// Timeout ed errori di rete sono errori, non avvisi. Nessuna dipendenza esterna.
//
// Uso:
//   node scripts/check-ghcr-anonymous.mjs --repository michaelpiu/pokemon-twitch-catch \
//     --tag 1.0.0-rc.3 [--expect-digest sha256:…] [--platforms linux/amd64,linux/arm64] \
//     [--timeout-ms 20000]
// In GitHub Actions scrive anche nel riepilogo del job (GITHUB_STEP_SUMMARY) e
// l'output "digest" (GITHUB_OUTPUT). --registry serve solo ai test (http consentito
// solo verso 127.0.0.1/localhost).
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const IMAGE_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const ACCEPT_INDEX = [...INDEX_TYPES].join(', ');
const ACCEPT_IMAGE = [...IMAGE_TYPES].join(', ');

export class CheckError extends Error {}

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

async function request(fetchImpl, url, { headers = {}, timeoutMs, what }) {
  let res;
  try {
    res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `timeout dopo ${timeoutMs} ms`
      : `errore di rete: ${e?.cause?.code || e?.cause?.message || e?.message || e}`;
    throw new CheckError(`${what}: ${reason}`);
  }
  let body;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new CheckError(`${what}: risposta interrotta (${e?.name === 'TimeoutError' ? `timeout dopo ${timeoutMs} ms` : e?.message || e})`);
  }
  return { status: res.status, headers: res.headers, body };
}

function parseJson(buf, what) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new CheckError(`${what}: risposta non è JSON valido`);
  }
}

function explainStatus(status) {
  if (status === 401) return 'il pacchetto non è pubblico (serve autenticazione)';
  if (status === 403) return 'accesso negato o pacchetto inesistente';
  if (status === 404) return 'non trovato';
  if (status === 429) return 'troppe richieste';
  if (status >= 500) return 'errore del registry';
  return 'risposta inattesa';
}

export async function checkAnonymousPull({
  repository,
  tag,
  expectDigest,
  platforms = ['linux/amd64', 'linux/arm64'],
  registry = 'https://ghcr.io',
  timeoutMs = 20000,
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(repository)) {
    throw new CheckError(`repository non valido: "${repository ?? ''}" (deve essere minuscolo, es. owner/nome)`);
  }
  if (!tag || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    throw new CheckError(`tag non valido: "${tag ?? ''}"`);
  }
  if (expectDigest !== undefined && !DIGEST_RE.test(expectDigest)) {
    throw new CheckError(`digest atteso mancante o malformato: "${expectDigest}"`);
  }
  if (!platforms.length) throw new CheckError('nessuna piattaforma da verificare');
  const base = new URL(registry);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) {
    throw new CheckError(`registry non ammesso: ${registry}`);
  }
  const origin = base.origin;
  const opts = { timeoutMs };

  // 1. Token anonimo: nessuna credenziale, come Umbrel.
  const tokenUrl = `${origin}/token?scope=${encodeURIComponent(`repository:${repository}:pull`)}&service=${encodeURIComponent(base.host)}`;
  const tok = await request(fetchImpl, tokenUrl, { ...opts, what: 'token anonimo' });
  if (tok.status !== 200) {
    throw new CheckError(`token anonimo: HTTP ${tok.status}, ${explainStatus(tok.status)}`);
  }
  const token = parseJson(tok.body, 'token anonimo').token;
  if (typeof token !== 'string' || !token) throw new CheckError('token anonimo: campo "token" assente o vuoto');
  const auth = { Authorization: `Bearer ${token}` };

  // 2–3. Indice multi-arch del tag e suo digest.
  const idx = await request(fetchImpl, `${origin}/v2/${repository}/manifests/${tag}`, {
    ...opts, what: `manifest ${tag}`, headers: { ...auth, Accept: ACCEPT_INDEX },
  });
  if (idx.status !== 200) throw new CheckError(`manifest ${tag}: HTTP ${idx.status}, ${explainStatus(idx.status)}`);
  const digest = idx.headers.get('docker-content-digest');
  if (!digest) throw new CheckError(`manifest ${tag}: header Docker-Content-Digest assente`);
  if (!DIGEST_RE.test(digest)) throw new CheckError(`manifest ${tag}: digest malformato "${digest}"`);
  const bodyDigest = sha256(idx.body);
  if (bodyDigest !== digest) {
    throw new CheckError(`manifest ${tag}: il contenuto ricevuto (${bodyDigest}) non corrisponde al digest dichiarato (${digest})`);
  }
  if (expectDigest && digest !== expectDigest) {
    throw new CheckError(`manifest ${tag}: digest ${digest} diverso da quello della build ${expectDigest}`);
  }
  const index = parseJson(idx.body, `manifest ${tag}`);
  const mediaType = index.mediaType || idx.headers.get('content-type')?.split(';')[0].trim();
  if (!INDEX_TYPES.has(mediaType) || !Array.isArray(index.manifests)) {
    throw new CheckError(`manifest ${tag}: non è un indice multi-architettura (mediaType ${mediaType || 'assente'})`);
  }

  // 4. Piattaforme: presenti nell'indice, manifest e configurazione scaricabili.
  const found = {};
  for (const wanted of platforms) {
    const [os, architecture, variant] = wanted.split('/');
    const entry = index.manifests.find((m) =>
      m?.platform?.os === os && m.platform.architecture === architecture &&
      (variant === undefined || m.platform.variant === variant) &&
      m.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
    if (!entry) throw new CheckError(`manifest ${tag}: piattaforma ${wanted} assente`);
    if (!DIGEST_RE.test(entry.digest || '')) {
      throw new CheckError(`manifest ${tag}: digest di ${wanted} mancante o malformato "${entry.digest ?? ''}"`);
    }
    const pm = await request(fetchImpl, `${origin}/v2/${repository}/manifests/${entry.digest}`, {
      ...opts, what: `immagine ${wanted}`, headers: { ...auth, Accept: ACCEPT_IMAGE },
    });
    if (pm.status !== 200) throw new CheckError(`immagine ${wanted}: HTTP ${pm.status}, ${explainStatus(pm.status)}`);
    if (sha256(pm.body) !== entry.digest) throw new CheckError(`immagine ${wanted}: contenuto non corrispondente al digest ${entry.digest}`);
    const image = parseJson(pm.body, `immagine ${wanted}`);
    const cfgDigest = image?.config?.digest;
    if (!DIGEST_RE.test(cfgDigest || '') || !Array.isArray(image.layers) || !image.layers.length) {
      throw new CheckError(`immagine ${wanted}: manifest senza configurazione o layer validi`);
    }
    const cfg = await request(fetchImpl, `${origin}/v2/${repository}/blobs/${cfgDigest}`, {
      ...opts, what: `configurazione ${wanted}`, headers: auth,
    });
    if (cfg.status !== 200) throw new CheckError(`configurazione ${wanted}: HTTP ${cfg.status}, ${explainStatus(cfg.status)}`);
    if (sha256(cfg.body) !== cfgDigest) throw new CheckError(`configurazione ${wanted}: contenuto non corrispondente al digest`);
    const config = parseJson(cfg.body, `configurazione ${wanted}`);
    if (config.os !== os || config.architecture !== architecture) {
      throw new CheckError(`configurazione ${wanted}: dichiara ${config.os}/${config.architecture}`);
    }
    found[wanted] = entry.digest;
  }
  return { repository, tag, digest, platforms: found };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new CheckError(`argomento inatteso: ${k}`);
    const v = argv[++i];
    if (v === undefined) throw new CheckError(`valore mancante per ${k}`);
    out[k.slice(2)] = v;
  }
  return out;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const summary = (line) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + '\n'); };
  try {
    const a = parseArgs(argv);
    const known = new Set(['repository', 'tag', 'expect-digest', 'platforms', 'registry', 'timeout-ms']);
    for (const k of Object.keys(a)) if (!known.has(k)) throw new CheckError(`opzione sconosciuta: --${k}`);
    const timeoutMs = a['timeout-ms'] === undefined ? 20000 : Number(a['timeout-ms']);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new CheckError(`--timeout-ms non valido: ${a['timeout-ms']}`);
    const r = await checkAnonymousPull({
      repository: a.repository,
      tag: a.tag,
      expectDigest: 'expect-digest' in a ? a['expect-digest'] : undefined,
      platforms: a.platforms ? a.platforms.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      registry: a.registry,
      timeoutMs,
    });
    console.log(`OK: ${r.repository}:${r.tag} scaricabile senza autenticazione`);
    console.log(`Digest multi-arch: ${r.digest}`);
    for (const [p, d] of Object.entries(r.platforms)) console.log(`  ${p}: ${d}`);
    summary(`✅ \`${r.repository}:${r.tag}\` scaricabile senza autenticazione (token, indice, ${Object.keys(r.platforms).join(', ')} e configurazioni verificati)`);
    summary(`Digest multi-arch verificato senza credenziali: \`${r.digest}\``);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `digest=${r.digest}\n`);
    return 0;
  } catch (e) {
    const msg = e instanceof CheckError ? e.message : `errore inatteso: ${e?.stack || e}`;
    console.error(`ERRORE: ${msg}`);
    summary(`❌ Verifica dell'accesso anonimo fallita: ${msg}. Umbrel non potrà scaricare l'immagine.`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main();
}
