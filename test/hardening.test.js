// Correzioni dell'audit pre-release: cookie malformati (M1), backup con schema
// più recente (M2) e problemi minori B1–B4, B6–B8.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, seqRng, redemption, BROADCASTER_ID } from './helpers.js';
import { startServer, dbFingerprint, overlaySocket } from './overlay-helpers.js';
import { parseCookies } from '../src/http/router.js';
import { LATEST_SCHEMA } from '../src/database/migrations.js';

const BAD = '%E0%A4%A'; // codifica percentuale troncata: decodeURIComponent lancia URIError

// Esito di un upgrade WebSocket: aperto, oppure codice HTTP di rifiuto.
function wsOutcome(url, headers = {}) {
  return new Promise((resolve) => {
    // Stesso User-Agent di fetch: la sessione è legata al browser che l'ha creata.
    const ws = new WebSocket(url, { headers: { 'User-Agent': 'node', ...headers } });
    const t = setTimeout(() => { ws.terminate(); resolve({ hang: true }); }, 2000);
    ws.on('open', () => { clearTimeout(t); resolve({ open: true, ws }); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); resolve({ status: res.statusCode }); ws.terminate(); });
    ws.on('error', () => { clearTimeout(t); resolve({ error: true }); });
  });
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('M1 – cookie malformati', () => {
  test('parseCookies ignora solo il cookie non valido', () => {
    assert.deepEqual(parseCookies(`a=1; bad=${BAD}; lc_session=abc%2Fdef; =x; flag`), { a: '1', lc_session: 'abc/def' });
    assert.deepEqual(parseCookies(undefined), {});
  });

  test('HTTP: API pubbliche e autenticate funzionano anche con un cookie estraneo malformato', async () => {
    const s = await startServer();
    try {
      await s.login();
      const pub = await fetch(`${s.base}/api/public/info`, { headers: { Cookie: `altraapp=${BAD}` } });
      assert.equal(pub.status, 200);
      const anon = await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: `lc_session=${BAD}` } });
      assert.equal(anon.status, 401, 'sessione illeggibile = non autenticato, non errore 500');
      const h = s.authHeaders();
      const me = await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: `altraapp=${BAD}; ${h.Cookie}` } });
      assert.equal(me.status, 200, 'la sessione valida resta riconosciuta');
      const path = await fetch(`${s.base}/api/admin/overlay/themes/${BAD}`, { headers: h });
      assert.equal(path.status, 400, 'parametro di percorso malformato = 400');
      const health = await fetch(`${s.base}/api/public/info`);
      assert.equal(health.status, 200, 'il server continua a rispondere');
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });

  test('WebSocket: overlay e dashboard non si bloccano con un cookie malformato', async () => {
    const s = await startServer();
    try {
      await s.login();
      const origin = s.base;
      const ov = await wsOutcome(`ws://127.0.0.1:${s.port}/ws/overlay`, { Cookie: `altraapp=${BAD}` });
      assert.equal(ov.open, true, 'overlay aperto');
      ov.ws.close();
      const anon = await wsOutcome(`ws://127.0.0.1:${s.port}/ws/admin`, { Cookie: `lc_session=${BAD}`, Origin: origin });
      assert.equal(anon.status, 401, 'risposta 401 invece di un socket appeso');
      const ok = await wsOutcome(`ws://127.0.0.1:${s.port}/ws/admin`, { Cookie: `altraapp=${BAD}; ${s.authHeaders().Cookie}`, Origin: origin });
      assert.equal(ok.open, true, 'dashboard collegata con la sessione valida');
      ok.ws.close();

      // Qualsiasi eccezione nel controllo dell'upgrade chiude il socket con 400.
      const orig = s.app.hub.authorizeAdmin;
      s.app.hub.authorizeAdmin = () => { throw new URIError('URI malformed'); };
      const boom = await wsOutcome(`ws://127.0.0.1:${s.port}/ws/admin`, { Origin: origin });
      s.app.hub.authorizeAdmin = orig;
      assert.equal(boom.status, 400);
      assert.equal(s.app.hub.rejected.malformed, 1);
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });
});

describe('M2 – backup e database con schema più recente', () => {
  const makeFutureBackup = (app) => {
    app.db.run("INSERT INTO schema_migrations (id, name) VALUES (?, 'futura')", LATEST_SCHEMA + 96);
    const b = app.backups.create('manual');
    app.db.run('DELETE FROM schema_migrations WHERE id = ?', LATEST_SCHEMA + 96);
    return b.filename;
  };

  test('ripristino rifiutato senza toccare il database (nessun backup di sicurezza, nessuna sostituzione)', async () => {
    const s = await startServer();
    try {
      await s.login();
      seedPokemon(s.app.db);
      const name = makeFutureBackup(s.app);
      const before = dbFingerprint(s.app.db);
      const files = readdirSync(s.app.config.backupsDir).sort();
      const r = await s.req('POST', `/api/admin/backups/${name}/restore`, {});
      assert.equal(r.status, 400);
      assert.match(r.data.error, new RegExp(`schema v${LATEST_SCHEMA + 96}.*fino allo schema v${LATEST_SCHEMA}`));
      assert.equal(s.app.db.schemaVersion(), LATEST_SCHEMA);
      assert.deepEqual(dbFingerprint(s.app.db), before, 'database identico');
      assert.deepEqual(readdirSync(s.app.config.backupsDir).sort(), files, 'nessun file creato');
      // Un backup compatibile continua a funzionare.
      const ok = s.app.backups.create('manual');
      assert.equal((await s.req('POST', `/api/admin/backups/${ok.filename}/restore`, {})).status, 200);
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });

  test('caricamento di un backup più recente rifiutato', async () => {
    const s = await startServer();
    try {
      await s.login();
      const name = makeFutureBackup(s.app);
      const raw = readFileSync(s.app.backups.path(name));
      const r = await fetch(`${s.base}/api/admin/backups-upload`, { method: 'POST', headers: { ...s.authHeaders(), 'Content-Type': 'application/octet-stream' }, body: raw });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /versione più recente/);
      assert.equal(readdirSync(s.app.config.backupsDir).filter((f) => f.includes('upload')).length, 0);
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });

  test('avvio rifiutato su un database più recente, file invariato e nessuna migrazione', async () => {
    const { app, dir } = await makeApp({ configureTwitch: false });
    app.db.run("INSERT INTO schema_migrations (id, name) VALUES (?, 'futura')", LATEST_SCHEMA + 1);
    await app.close();
    const dbFile = join(dir, 'db', 'livecatch.sqlite');
    const hash = sha(dbFile);
    const backups = readdirSync(join(dir, 'backups')).sort();
    try {
      await assert.rejects(makeApp({ dir, configureTwitch: false }), (e) => {
        assert.equal(e.code, 'SCHEMA_TOO_NEW');
        assert.match(e.message, new RegExp(`schema v${LATEST_SCHEMA + 1}`));
        return true;
      });
      assert.equal(sha(dbFile), hash, 'database non modificato');
      assert.deepEqual(readdirSync(join(dir, 'backups')).sort(), backups, 'nessun backup pre-migrazione');
    } finally { cleanup(dir); }
  });
});

describe('Problemi minori', () => {
  test('B1: limite della classifica pubblica sempre tra 1 e 100', async () => {
    const s = await startServer();
    try {
      const db = s.app.db;
      seedPokemon(db);
      const p = db.get('SELECT id FROM pokemon LIMIT 1').id;
      db.tx(() => {
        for (let i = 0; i < 120; i++) {
          const u = db.run('INSERT INTO twitch_users (twitch_id, login, display_name) VALUES (?, ?, ?)', `u${i}`, `user${i}`, `User${i}`);
          db.run('INSERT INTO user_pokemon (user_id, pokemon_id) VALUES (?, ?)', Number(u.lastInsertRowid), p);
        }
      });
      s.app.adminSettings.set('publicPages', { ...s.app.adminSettings.get('publicPages'), leaderboard: true });
      const n = async (q) => (await s.req('GET', `/api/public/leaderboard${q}`, undefined, { auth: false })).data.items.length;
      assert.equal(await n('?limit=-1'), 1);
      assert.equal(await n('?limit=-1000'), 1);
      assert.equal(await n('?limit=1000'), 100);
      assert.equal(await n('?limit=abc'), 50);
      assert.equal(await n('?limit=2.7'), 2);
      assert.equal(await n(''), 50);
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });

  test('B2: riscatto annullato con revoca: Pokémon rimosso e statistiche coerenti (anche con eventi ripetuti)', async () => {
    const tw = new FakeTwitch();
    const es = await new FakeEventSub().start();
    const rng = seqRng();
    const ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    const app = ctx.app;
    try {
      seedPokemon(app.db);
      const { rewardId } = linkReward(app);
      app.gameSettings.set('capture', { ...app.gameSettings.get('capture'), revokeOnCancel: true });
      await app.monitor.start();
      await waitFor(() => app.sm.state === 'OFFLINE', { timeout: 8000 });
      tw.live = { id: 'b1' };
      es.notify('stream.online', { id: 'b1', broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
      await waitFor(() => app.sm.state === 'LIVE', { timeout: 8000 });
      rng.push(0.0); app.engine.spawn({});
      rng.push(0.0);
      es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'red-1', rewardId }));
      await waitFor(() => app.db.get("SELECT outcome FROM capture_attempts WHERE redemption_id = 'red-1'"));
      const a0 = app.db.get("SELECT * FROM capture_attempts WHERE redemption_id = 'red-1'");
      assert.equal(a0.outcome, 'caught');
      const sess = () => app.db.get('SELECT attempts, captures, failures, participants FROM stream_sessions WHERE id = ?', a0.session_id);
      const spawn = () => app.db.get('SELECT attempts, captures FROM spawn_history WHERE id = ?', a0.spawn_id);
      assert.deepEqual({ ...sess() }, { attempts: 1, captures: 1, failures: 0, participants: 1 });

      for (let i = 0; i < 2; i++) {
        es.notify('channel.channel_points_custom_reward_redemption.update', { id: 'red-1', reward: { id: rewardId }, status: 'canceled' });
      }
      await waitFor(() => app.db.get("SELECT outcome FROM capture_attempts WHERE redemption_id = 'red-1'").outcome === 'rejected');
      await new Promise((r) => setTimeout(r, 50));
      const a1 = app.db.get("SELECT * FROM capture_attempts WHERE redemption_id = 'red-1'");
      assert.equal(a1.reject_reason, 'canceled');
      assert.equal(a1.redemption_status, 'CANCELED');
      assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);
      assert.deepEqual({ ...sess() }, { attempts: 0, captures: 0, failures: 0, participants: 0 });
      assert.deepEqual({ ...spawn() }, { attempts: 0, captures: 0 });
      assert.equal(app.monitor.reconciler.pending().length, 0, 'nessun aggiornamento verso Twitch in sospeso');
    } finally { await app.close(); await es.stop(); cleanup(ctx.dir); }
  });

  test('B3: ripristino ed eliminazione di un tema rifiutati (409) se la revisione è superata', async () => {
    const s = await startServer();
    try {
      await s.login();
      const t = (await s.req('POST', '/api/admin/overlay/themes', { name: 'Prova', base: 'classic' })).data.theme;
      const cfg = structuredClone(t.config); cfg.colors.primary = '#111111';
      const saved = (await s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg, rev: t.rev })).data.theme;
      assert.equal(saved.rev, t.rev + 1);

      const r1 = await s.req('POST', `/api/admin/overlay/themes/${t.id}/reset`, { rev: t.rev });
      assert.equal(r1.status, 409);
      assert.equal(r1.data.details.current.rev, saved.rev);
      assert.equal((await s.req('GET', `/api/admin/overlay/themes/${t.id}`)).data.config.colors.primary, '#111111', 'non ripristinato');
      const d1 = await s.req('DELETE', `/api/admin/overlay/themes/${t.id}?rev=${t.rev}`);
      assert.equal(d1.status, 409);
      assert.equal((await s.req('GET', `/api/admin/overlay/themes/${t.id}`)).status, 200, 'non eliminato');
      assert.equal((await s.req('DELETE', `/api/admin/overlay/themes/${t.id}?rev=abc`)).status, 400);

      const r2 = await s.req('POST', `/api/admin/overlay/themes/${t.id}/reset`, { rev: saved.rev });
      assert.equal(r2.status, 200);
      const d2 = await s.req('DELETE', `/api/admin/overlay/themes/${t.id}?rev=${r2.data.theme.rev}`);
      assert.equal(d2.status, 200);
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });

  test('B4: limite delle connessioni overlay per IP e totale; la dashboard non è coinvolta', async () => {
    const s = await startServer({ env: { WS_OVERLAY_MAX_PER_IP: '3', WS_OVERLAY_MAX_CONNECTIONS: '5' } });
    try {
      await s.login();
      const url = `ws://127.0.0.1:${s.port}/ws/overlay`;
      const open = [];
      for (let i = 0; i < 3; i++) { const o = await wsOutcome(url); assert.equal(o.open, true, `sorgente OBS ${i + 1}`); open.push(o.ws); }
      assert.equal((await wsOutcome(url)).status, 503, 'oltre il limite per IP');
      const admin = await wsOutcome(`ws://127.0.0.1:${s.port}/ws/admin`, { Cookie: s.authHeaders().Cookie, Origin: s.base });
      assert.equal(admin.open, true, 'dashboard non limitata');
      admin.ws.close();
      // Una sorgente chiusa libera il posto (OBS che ricarica la pagina).
      open.pop().close();
      await waitFor(() => s.app.hub.counts().overlay === 2);
      const again = await wsOutcome(url);
      assert.equal(again.open, true);
      open.push(again.ws);
      assert.equal(s.app.hub.rejected.overlayLimit, 1);
      open.forEach((w) => w.close());
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
    // Valori predefiniti: 30 per IP e 100 in totale.
    const d = await startServer();
    try { assert.deepEqual(d.app.hub.overlayLimits, { max: 100, perIp: 30 }); } finally { await d.app.close(); cleanup(d.ctx.dir); }
  });

  test('B6: backup automatico calcolato sul giorno locale (non UTC)', async () => {
    const prevTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo'; // UTC+9, senza ora legale
    const { app, dir } = await makeApp({ configureTwitch: false });
    try {
      app.adminSettings.set('backup', { ...app.adminSettings.get('backup'), autoEnabled: true, hour: 0 });
      // Ultimo backup automatico: 9 marzo, 10:00 ora locale (01:00 UTC).
      app.db.run("INSERT INTO backup_history (filename, kind, size_bytes, created_at) VALUES ('x.sqlite.gz', 'auto', 1, '2026-03-09T01:00:00.000Z')");
      // 10 marzo, 00:30 ora locale = ancora 9 marzo in UTC: il backup del giorno va fatto.
      const r = app.backups.checkAuto(new Date('2026-03-09T15:30:00.000Z'));
      assert.ok(r?.filename, 'backup del 10 marzo creato');
      // Stesso giorno locale: nessun secondo backup.
      assert.equal(app.backups.checkAuto(new Date('2026-03-09T20:00:00.000Z')), null);
    } finally {
      await app.close();
      cleanup(dir);
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    }
  });

  test('B7: impostazioni Pokémon importate validate; valori non validi = nessuna modifica', async () => {
    const s = await startServer();
    try {
      await s.login();
      seedPokemon(s.app.db);
      const slug = s.app.db.get('SELECT slug FROM pokemon LIMIT 1').slug;
      const before = dbFingerprint(s.app.db).pokemon;
      const bad = [
        { slug, rarity: 'leggendario-falso' },
        { slug, catch_modifier: -5 },
        { slug, catch_modifier: '2' },
        { slug, spawn_weight: 1e9 },
        { slug, enabled: 'sì' },
        { slug: "x' OR 1=1 --" },
        'non un oggetto',
      ];
      for (const entry of bad) {
        const r = await s.req('POST', '/api/admin/import', { data: { format: 'livecatch-export', users: [], collections: [], pokemonSettings: [entry] } });
        assert.equal(r.status, 400, JSON.stringify(entry));
        assert.match(r.data.error, /Impostazioni Pokémon n\. 1 non valide/);
      }
      assert.equal((await s.req('POST', '/api/admin/import', { data: { format: 'livecatch-export', pokemonSettings: { slug } } })).status, 400);
      assert.equal(dbFingerprint(s.app.db).pokemon, before, 'nessuna modifica ai Pokémon');

      // Esportazione dell'app reimportata: valida. Campi assenti = invariati.
      const exp = (await s.req('GET', '/api/admin/export')).data;
      assert.equal((await s.req('POST', '/api/admin/import', { data: exp })).status, 200);
      const ok = await s.req('POST', '/api/admin/import', { data: { format: 'livecatch-export', pokemonSettings: [{ slug, spawn_weight: 7 }] } });
      assert.equal(ok.status, 200);
      const row = s.app.db.get('SELECT rarity, spawn_weight FROM pokemon WHERE slug = ?', slug);
      assert.equal(row.spawn_weight, 7);
      assert.ok(row.rarity);
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });

  test('B8: niente simulazioni su OBS in ERROR/CONNECTING se il canale risulta in diretta; anteprima sempre disponibile', async () => {
    const s = await startServer();
    try {
      await s.login();
      // Le transizioni di stato provocate dal test vengono registrate in
      // state_transitions: tutte le altre tabelle devono restare identiche.
      const fp = () => { const f = dbFingerprint(s.app.db); delete f.state_transitions; return f; };
      const db0 = fp();
      const ov = overlaySocket(s.port);
      await ov.open;
      for (const state of ['ERROR', 'CONNECTING']) {
        s.app.sm.goTo(state, 'test');
        s.app.monitor.setKnownLive(true);
        const obs = await s.req('POST', '/api/admin/overlay/simulate', { kind: 'spawn', target: 'obs' });
        assert.equal(obs.status, 409, `${state}: bloccata`);
        assert.match(obs.data.error, /risulta in diretta/);
        const busy = (await s.req('GET', '/api/admin/overlay/themes')).data.obs.busy;
        assert.match(busy, /in diretta/, 'il Designer passa in automatico all\'anteprima');
        const prev = await s.req('POST', '/api/admin/overlay/simulate', { kind: 'spawn', target: 'preview' });
        assert.equal(prev.status, 200, `${state}: anteprima privata disponibile`);

        s.app.monitor.setKnownLive(false); // Twitch: canale offline
        assert.equal((await s.req('POST', '/api/admin/overlay/simulate', { kind: 'clear', target: 'obs' })).status, 200, `${state}: canale offline = consentita`);
      }
      // Informazione vecchia (oltre 30 minuti): non blocca più.
      s.app.monitor.knownLive = { live: true, at: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
      assert.equal(s.app.monitor.channelLive(), false);
      ov.ws.close();
      assert.deepEqual(fp(), db0, 'il simulatore non scrive nel database');
    } finally { await s.app.close(); cleanup(s.ctx.dir); }
  });
});

describe('B5 – timeout propri di Helix', () => {
  test('una richiesta Helix bloccata termina entro il timeout configurato e non resta appesa', async () => {
    const tw = new FakeTwitch();
    const { app, dir } = await makeApp({ twitch: tw, env: { TWITCH_HTTP_TIMEOUT_MS: '120', TWITCH_HTTP_RETRIES: '1' } });
    try {
      tw.fault('/helix/channel_points/custom_rewards', { hang: true });
      const t0 = Date.now();
      await assert.rejects(app.helix.updateReward(BROADCASTER_ID, 'r1', { is_paused: true }), { transient: true });
      assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
      assert.equal(tw.faults[0].hits, 2, 'PATCH idempotente: un ritentativo');
    } finally { await app.close(); cleanup(dir); }
  });
});
