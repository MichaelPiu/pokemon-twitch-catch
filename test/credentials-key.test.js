// Backup ripristinato su un'installazione con secret.key diversa (reinstallazione,
// nuovo server, disco cambiato). La chiave non è nei backup per scelta: le
// credenziali Twitch cifrate non sono leggibili, quindi Twitch deve risultare
// scollegato con un avviso, senza errori nella dashboard e senza perdere nulla.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeApp, cleanup, tempDir, adminClient, seedPokemon, FakeTwitch, FakeEventSub, CLIENT_ID,
} from './helpers.js';
import { TwitchCredentials } from '../src/twitch/credentials.js';
import { SecretBox } from '../src/security/crypto.js';
import { randomBytes } from 'node:crypto';

const PASSWORD = 'NuovaPassword2026';
const creds = (app) => app.db.get("SELECT value FROM admin_settings WHERE key = 'twitch_credentials'")?.value;

describe('Ripristino su un\'installazione con secret.key diversa', () => {
  let root, A, original, networkFile, localFile;

  before(async () => {
    root = tempDir();
    mkdirSync(root, { recursive: true });
    // Installazione originale: Twitch collegato (canale e bot), dati di gioco, backup.
    A = await makeApp({ env: { BACKUP_TARGET_ROOT: root } });
    A.app.credentials.setToken('bot', { accessToken: 'botaccess', refreshToken: 'botrefresh', expiresAt: Date.now() + 3600e3, scopes: ['user:write:chat'], userId: '1001', login: 'ilbot', displayName: 'IlBot' });
    seedPokemon(A.app.db);
    A.app.db.run("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('2001', 'mario', 'Mario')");
    await adminClient(A.app, { password: PASSWORD });
    original = creds(A.app);
    assert.ok(original && original.includes('v1:'), 'credenziali cifrate nel database originale');
    networkFile = (await A.app.networkBackups.create('manual')).file;
    localFile = A.app.backups.create('manual', 'prima del trasloco').filename;
    await A.app.close();
  });

  after(() => { cleanup(A.dir); cleanup(root); });

  // Nuova installazione (secret.key generata da zero) sullo stesso disco di rete.
  const freshInstall = async () => {
    const tw = new FakeTwitch();
    const es = await new FakeEventSub().start();
    const B = await makeApp({ twitch: tw, eventsub: es, configureTwitch: false, env: { BACKUP_TARGET_ROOT: root } });
    assert.notDeepEqual(readFileSync(join(B.dir, 'secret.key')), readFileSync(join(A.dir, 'secret.key')), 'chiave diversa');
    const client = await adminClient(B.app, { password: 'PasswordNuovoServer1' });
    return { ...B, tw, es, client };
  };
  const close = async (B) => { await B.app.close(); await B.es.stop(); cleanup(B.dir); };

  // Dopo il ripristino la sessione di chi ha ripristinato resta valida.
  const pagesWork = async (B) => {
    for (const p of ['/api/admin/overview', '/api/admin/twitch', '/api/admin/system', '/api/admin/game', '/api/admin/leaderboard']) {
      const r = await B.client.req('GET', p);
      assert.equal(r.status, 200, `${p} risponde 200 (ricevuto ${r.status}: ${JSON.stringify(r.data).slice(0, 120)})`);
    }
    assert.doesNotThrow(() => B.app.liveStatus(), 'stato per la barra superiore e la Panoramica');
  };

  const showsDisconnected = async (B) => {
    const t = (await B.client.req('GET', '/api/admin/twitch')).data;
    assert.equal(t.credentials.clientId, CLIENT_ID, 'Client ID (non segreto) ancora presente');
    assert.equal(t.credentials.clientSecretSet, false);
    assert.equal(t.credentials.clientSecretUnreadable, true);
    assert.equal(t.credentials.broadcaster.connected, false, 'canale scollegato');
    assert.equal(t.credentials.broadcaster.unreadable, true);
    assert.equal(t.credentials.broadcaster.login, 'streamer', 'il nome dell\'account resta visibile nell\'avviso');
    assert.equal(t.credentials.bot.connected, false);
    assert.equal(t.credentials.bot.unreadable, true);
    assert.deepEqual(t.status.credentialsUnreadable, { clientSecret: true, broadcaster: true, bot: true }, 'avviso nella pagina Twitch');
    assert.deepEqual(B.app.liveStatus().twitch.credentialsUnreadable, { clientSecret: true, broadcaster: true, bot: true }, 'avviso in Panoramica');
    assert.ok(!JSON.stringify(t).includes('v1:'), 'nessun segreto cifrato inviato alla dashboard');
  };

  test('backup di rete: ripristino 200, dashboard funzionante, modalità manuale, avviso, credenziali intatte, ricollegamento', async () => {
    const B = await freshInstall();
    try {
      const v = await B.client.req('POST', `/api/admin/backups/network/${networkFile}/verify`, {});
      const r = await B.client.req('POST', `/api/admin/backups/network/${networkFile}/restore`, { confirm: 'RIPRISTINA', sha256: v.data.manifest.archive.sha256 });
      assert.equal(r.status, 200, `ripristino riuscito (ricevuto ${r.status}: ${JSON.stringify(r.data)})`);
      assert.ok(B.app.db.get("SELECT 1 FROM twitch_users WHERE login = 'mario'"), 'dati del backup ripristinati');
      assert.equal(B.app.db.integrityCheck(), true);

      await pagesWork(B);
      await showsDisconnected(B);
      assert.equal(creds(B.app), original, 'credenziali cifrate originali intatte nel database');

      // Modalità manuale con Twitch scollegato.
      const start = await B.client.req('POST', '/api/admin/game/manual/start', {});
      assert.equal(start.status, 200, JSON.stringify(start.data));
      assert.equal(start.data.engine.mode, 'manual');
      const stop = await B.client.req('POST', '/api/admin/game/manual/stop', {});
      assert.equal(stop.status, 200);
      assert.equal(creds(B.app), original, 'la modalità manuale non tocca le credenziali');

      // Ricollegamento: finché l'autorizzazione è in attesa le vecchie credenziali restano.
      const s = await B.client.req('POST', '/api/admin/twitch/auth/broadcaster/start', {});
      assert.equal(s.status, 200, JSON.stringify(s.data));
      const p1 = await B.client.req('POST', '/api/admin/twitch/auth/broadcaster/poll', {});
      assert.equal(p1.data.status, 'pending');
      assert.equal(creds(B.app), original, 'nessuna sostituzione prima di un collegamento riuscito');
      const p2 = await B.client.req('POST', '/api/admin/twitch/auth/broadcaster/poll', {});
      assert.equal(p2.data.status, 'authorized', JSON.stringify(p2.data));

      const tok = B.app.credentials.getToken('broadcaster');
      assert.equal(tok.accessToken, 'dev-broadcaster-access', 'nuovo token leggibile con la chiave attuale');
      assert.equal(tok.refreshToken, 'dev-broadcaster-refresh');
      const raw = JSON.parse(creds(B.app));
      const orig = JSON.parse(original);
      assert.notEqual(raw.broadcaster.accessToken, orig.broadcaster.accessToken, 'token del canale sostituito');
      assert.equal(raw.bot.accessToken, orig.bot.accessToken, 'bot non ricollegato: credenziali originali intatte');
      assert.equal(raw.clientSecret, orig.clientSecret, 'Client Secret non reinserito: valore originale intatto');

      let t = (await B.client.req('GET', '/api/admin/twitch')).data;
      assert.equal(t.credentials.broadcaster.connected, true);
      assert.equal(t.credentials.broadcaster.unreadable, undefined);
      assert.deepEqual(t.status.credentialsUnreadable, { clientSecret: true, broadcaster: false, bot: true }, 'l\'avviso resta per ciò che non è ancora ricollegato');

      // Client Secret reinserito: l'avviso resta solo per il bot.
      const put = await B.client.req('PUT', '/api/admin/twitch/app', { clientSecret: 'nuovosecret0000000' });
      assert.equal(put.status, 200);
      t = (await B.client.req('GET', '/api/admin/twitch')).data;
      assert.equal(t.credentials.clientSecretSet, true);
      assert.deepEqual(t.status.credentialsUnreadable, { clientSecret: false, broadcaster: false, bot: true });
      assert.equal(B.app.credentials.clientSecret, 'nuovosecret0000000');
      await pagesWork(B);
    } finally {
      await close(B);
    }
  });

  test('backup locale copiato su una nuova installazione: ripristino 200 e Twitch scollegato con avviso', async () => {
    const B = await freshInstall();
    try {
      copyFileSync(join(A.dir, 'backups', localFile), join(B.dir, 'backups', localFile));
      const r = await B.client.req('POST', `/api/admin/backups/${localFile}/restore`, {});
      assert.equal(r.status, 200, `ripristino riuscito (ricevuto ${r.status}: ${JSON.stringify(r.data)})`);
      await pagesWork(B);
      await showsDisconnected(B);
      assert.equal(creds(B.app), original, 'credenziali cifrate originali intatte');
      const start = await B.client.req('POST', '/api/admin/game/manual/start', {});
      assert.equal(start.status, 200, JSON.stringify(start.data));
      await B.client.req('POST', '/api/admin/game/manual/stop', {});
      // Riavvio dell'app: lo stato resta coerente (nessun errore, credenziali intatte).
      await B.app.close();
      const again = await makeApp({ dir: B.dir, twitch: B.tw, eventsub: B.es, configureTwitch: false, env: { BACKUP_TARGET_ROOT: root } });
      B.app = again.app;
      assert.equal(creds(B.app), original);
      assert.deepEqual(B.app.monitor.status().credentialsUnreadable, { clientSecret: true, broadcaster: true, bot: true });
    } finally {
      await close(B);
    }
  });
});

describe('TwitchCredentials con una chiave diversa', () => {
  const store = () => {
    let v = null;
    return { get: () => v, set: (_k, x) => { v = JSON.parse(JSON.stringify(x)); } };
  };

  test('segreti illeggibili trattati come assenti, senza eccezioni e senza modificare i valori salvati', () => {
    const s = store();
    const a = new TwitchCredentials({ adminSettings: s, box: new SecretBox(randomBytes(32)) });
    a.setApp({ clientId: 'clientid00000000', clientSecret: 'secret0000000000' });
    a.setToken('broadcaster', { accessToken: 'acc', refreshToken: 'ref', expiresAt: 1, scopes: [], userId: '1', login: 'canale' });
    const saved = JSON.stringify(s.get());
    assert.deepEqual(a.unreadable(), null, 'stessa chiave: tutto leggibile');

    const b = new TwitchCredentials({ adminSettings: s, box: new SecretBox(randomBytes(32)) });
    assert.equal(b.clientSecret, '');
    assert.equal(b.getToken('broadcaster'), null);
    assert.equal(b.getToken('bot'), null);
    assert.deepEqual(b.unreadable(), { clientSecret: true, broadcaster: true, bot: false });
    assert.equal(b.publicView().broadcaster.connected, false);
    assert.equal(JSON.stringify(s.get()), saved, 'nessuna scrittura');

    // Nuovo collegamento senza refresh token: il vecchio refresh token illeggibile non viene riutilizzato.
    b.setToken('broadcaster', { accessToken: 'nuovo', expiresAt: 2, userId: '1', login: 'canale' });
    assert.deepEqual(b.getToken('broadcaster') && [b.getToken('broadcaster').accessToken, b.getToken('broadcaster').refreshToken], ['nuovo', null]);
    assert.deepEqual(b.unreadable(), { clientSecret: true, broadcaster: false, bot: false });
  });
});
