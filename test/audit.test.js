// Test aggiunti durante l'audit della 1.0.0-rc.1:
// - autenticazione/CSRF/cambio password obbligatorio su TUTTE le rotte admin;
// - nessun segreto (Client Secret, token) in nessuna risposta admin;
// - collegamento OAuth (Device Code Flow) di broadcaster e bot, scope richiesti;
// - ciclo completo LIVE → OFFLINE → riavvio: dashboard, statistiche, Pokédex,
//   storico disponibili, overlay collegato, nessun dato perso.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { makeApp, cleanup, tempDir, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID, CLIENT_ID } from './helpers.js';

const UA = 'AuditTest/1.0';

// Percorso concreto di una rotta (i parametri diventano "1").
function concretePath(route) {
  return route.re.source.replace(/^\^/, '').replace(/\\\/\?\$$/, '').replace(/\/\?\$$/, '')
    .replace(/\(\[\^\/\]\+\)/g, '1').replace(/\\\//g, '/');
}

async function serve(opts = {}) {
  const ctx = await makeApp(opts);
  const port = await ctx.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { cookie, csrf, body, headers = {} } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* testo */ }
    return { status: r.status, text, data, headers: r.headers };
  };
  const login = async ({ change = true } = {}) => {
    const r = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'initialpass123' } });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    if (change) {
      const c = await call('POST', '/api/auth/change-password', { cookie, csrf: r.data.csrf, body: { currentPassword: 'initialpass123', newPassword: 'NuovaPassword2026' } });
      assert.equal(c.status, 200);
    }
    return { cookie, csrf: r.data.csrf };
  };
  return { ...ctx, port, base, call, login };
}

describe('Audit: autorizzazioni di tutte le rotte amministrative', () => {
  test('ogni rotta /api/admin e /api/auth non pubblica: 401 senza login, 403 con password da cambiare, 403 senza CSRF', async () => {
    const tw = new FakeTwitch();
    const s = await serve({ twitch: tw });
    try {
      const routes = s.app.router.routes.filter((r) => !r.opts.public);
      const admin = routes.filter((r) => concretePath(r).startsWith('/api/admin/'));
      assert.ok(admin.length >= 70, `rotte admin trovate: ${admin.length}`);
      const problems = [];
      for (const r of routes) {
        const res = await s.call(r.method, concretePath(r));
        if (res.status !== 401) problems.push(`${r.method} ${concretePath(r)} senza login → ${res.status}`);
      }
      // Sessione con password ancora da cambiare: tutto bloccato tranne le rotte di cambio password/logout/me.
      const first = await s.login({ change: false });
      for (const r of admin) {
        const res = await s.call(r.method, concretePath(r), { cookie: first.cookie, csrf: first.csrf });
        if (res.status !== 403) problems.push(`${r.method} ${concretePath(r)} con password da cambiare → ${res.status}`);
      }
      await s.call('POST', '/api/auth/change-password', { cookie: first.cookie, csrf: first.csrf, body: { currentPassword: 'initialpass123', newPassword: 'NuovaPassword2026' } });
      // Scritture senza token CSRF: rifiutate.
      for (const r of admin.filter((x) => x.method !== 'GET')) {
        const res = await s.call(r.method, concretePath(r), { cookie: first.cookie, body: {} });
        if (res.status !== 403) problems.push(`${r.method} ${concretePath(r)} senza CSRF → ${res.status}`);
      }
      assert.deepEqual(problems, []);
      // Le uniche rotte pubbliche sono quelle previste.
      const pub = s.app.router.routes.filter((r) => r.opts.public).map((r) => `${r.method} ${concretePath(r)}`).sort();
      assert.deepEqual(pub, [
        'GET /api/public/info', 'GET /api/public/leaderboard', 'GET /api/public/overlay', 'GET /api/public/pokedex/1', 'POST /api/auth/login',
      ].sort());
    } finally { await s.app.close(); cleanup(s.dir); }
  });

  test('nessun segreto Twitch in nessuna risposta GET admin né nei log', async () => {
    const tw = new FakeTwitch();
    const s = await serve({ twitch: tw });
    try {
      s.app.credentials.setApp({ clientId: CLIENT_ID, clientSecret: 'supersegretoclient0042' });
      s.app.credentials.setToken('broadcaster', { accessToken: 'accesstokensegreto77', refreshToken: 'refreshtokensegreto88', expiresAt: Date.now() + 3600e3, userId: BROADCASTER_ID, login: 'streamer' });
      s.app.credentials.setToken('bot', { accessToken: 'bottokensegreto99', refreshToken: 'botrefreshsegreto11', expiresAt: Date.now() + 3600e3, userId: '5000', login: 'mio_bot' });
      seedPokemon(s.app.db);
      const { cookie } = await s.login();
      const secrets = ['supersegretoclient0042', 'accesstokensegreto77', 'refreshtokensegreto88', 'bottokensegreto99', 'botrefreshsegreto11'];
      const leaks = [];
      for (const r of s.app.router.routes.filter((x) => x.method === 'GET')) {
        const res = await s.call('GET', concretePath(r), { cookie });
        for (const sec of secrets) if (res.text.includes(sec)) leaks.push(`${concretePath(r)} contiene ${sec}`);
      }
      // Anche il database non contiene i segreti in chiaro.
      const raw = s.app.db.get("SELECT value FROM admin_settings WHERE key = 'twitch_credentials'").value;
      for (const sec of secrets) if (raw.includes(sec)) leaks.push(`database contiene ${sec}`);
      const logs = JSON.stringify(s.app.logger.recent({ level: 'debug', limit: 1000 }));
      for (const sec of secrets) if (logs.includes(sec)) leaks.push(`log contengono ${sec}`);
      assert.deepEqual(leaks, []);
    } finally { await s.app.close(); cleanup(s.dir); }
  });
});

describe('Audit: collegamento OAuth di broadcaster e bot', () => {
  test('Device Code Flow per canale e bot: scope minimi, token cifrati, il bot risponde in chat', async () => {
    const tw = new FakeTwitch();
    const s = await serve({ twitch: tw, configureTwitch: false });
    try {
      const { cookie, csrf } = await s.login();
      const app = await s.call('PUT', '/api/admin/twitch/app', { cookie, csrf, body: { clientId: CLIENT_ID, clientSecret: 'segretoapp00000001' } });
      assert.equal(app.status, 200);
      assert.equal(app.data.clientSecretSet, true);
      assert.ok(!app.text.includes('segretoapp00000001'));

      for (const role of ['broadcaster', 'bot']) {
        const start = await s.call('POST', `/api/admin/twitch/auth/${role}/start`, { cookie, csrf });
        assert.equal(start.status, 200, start.text);
        assert.equal(start.data.verificationUri, 'https://www.twitch.tv/activate');
        assert.ok(!('deviceCode' in start.data), 'il device_code resta sul server');
        const p1 = await s.call('POST', `/api/admin/twitch/auth/${role}/poll`, { cookie, csrf });
        assert.equal(p1.data.status, 'pending');
        const p2 = await s.call('POST', `/api/admin/twitch/auth/${role}/poll`, { cookie, csrf });
        assert.equal(p2.data.status, 'authorized', p2.text);
      }
      // Scope richiesti: esattamente quelli dichiarati, il bot solo la scrittura in chat.
      assert.deepEqual(tw.deviceRequests.map((d) => d.scopes), [
        'channel:read:redemptions channel:manage:redemptions user:read:chat user:write:chat',
        'user:write:chat',
      ]);
      // Client confidenziale: il secret viene inviato solo allo scambio del codice, mai al browser.
      assert.ok(tw.deviceTokenRequests.every((r) => r.client_secret === 'segretoapp00000001'));

      const view = (await s.call('GET', '/api/admin/twitch', { cookie })).data;
      assert.equal(view.credentials.broadcaster.connected, true);
      assert.equal(view.credentials.broadcaster.userId, BROADCASTER_ID);
      assert.equal(view.credentials.bot.connected, true);
      assert.equal(view.credentials.bot.login, 'mio_bot');
      const raw = s.app.db.get("SELECT value FROM admin_settings WHERE key = 'twitch_credentials'").value;
      for (const t of ['dev-broadcaster-access', 'dev-broadcaster-refresh', 'dev-bot-access', 'dev-bot-refresh', 'segretoapp00000001']) {
        assert.ok(!raw.includes(t), `${t} cifrato a riposo`);
      }
      // Le risposte in chat partono dall'account bot.
      assert.deepEqual(s.app.chat.sender(), { role: 'bot', id: '5000' });
      s.app.chat.send('prova');
      await waitFor(() => tw.chat.length === 1);
      assert.equal(tw.chat[0].sender_id, '5000');
      assert.equal(tw.chat[0].broadcaster_id, BROADCASTER_ID);
      // Scollegando il bot risponde di nuovo il canale.
      assert.equal((await s.call('DELETE', '/api/admin/twitch/auth/bot', { cookie, csrf })).status, 200);
      assert.deepEqual(s.app.chat.sender(), { role: 'broadcaster', id: BROADCASTER_ID });
    } finally { await s.app.close(); cleanup(s.dir); }
  });
});

describe('Audit: ciclo completo LIVE → OFFLINE → riavvio', () => {
  test('dashboard sempre attiva, gioco automatico, overlay collegato, dati conservati dopo il riavvio', async () => {
    const dir = tempDir();
    const tw = new FakeTwitch();
    const es = await new FakeEventSub().start();
    const rng = seqRng();
    let s = await serve({ dir, twitch: tw, eventsub: es, rng });
    try {
      seedPokemon(s.app.db);
      const reward = linkReward(s.app, 'pokeball');
      const { cookie } = await s.login();
      await s.app.monitor.start();
      await waitFor(() => s.app.sm.state === 'OFFLINE', { timeout: 8000 });
      // Offline: dashboard e dati disponibili, motore spento.
      for (const p of ['/api/admin/overview', '/api/admin/stats', '/api/admin/users', '/api/admin/sessions', '/api/admin/system']) {
        assert.equal((await s.call('GET', p, { cookie })).status, 200, p);
      }
      assert.equal(s.app.engine.running, false);

      // Overlay collegato via WebSocket (come OBS).
      const msgs = [];
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/overlay`);
      ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
      await waitFor(() => msgs.some((m) => m.type === 'snapshot'));

      // LIVE: il gioco parte da solo.
      tw.live = { id: 'b-audit' };
      es.notify('stream.online', { id: 'b-audit', broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
      await waitFor(() => s.app.sm.state === 'LIVE' && s.app.engine.running, { timeout: 8000 });
      await waitFor(() => msgs.some((m) => m.type === 'state' && m.data.active === true));
      const sp = s.app.engine.tick();
      assert.ok(sp);
      await waitFor(() => msgs.some((m) => m.type === 'spawn'));
      rng.push(0.0);
      es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'audit-1', rewardId: reward.rewardId }));
      await waitFor(() => msgs.some((m) => m.type === 'throw' && m.data.caught));
      // Lo stesso riscatto due volte (EventSub reinvia con un altro message_id): una sola cattura.
      es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'audit-1', rewardId: reward.rewardId }));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(s.app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1);

      // OFFLINE: il gioco si ferma, l'overlay viene pulito, la dashboard resta.
      tw.live = null;
      es.notify('stream.offline', { broadcaster_user_id: BROADCASTER_ID });
      await waitFor(() => s.app.sm.state === 'OFFLINE', { timeout: 8000 });
      await waitFor(() => msgs.some((m) => m.type === 'clear'));
      assert.equal(s.app.engine.running, false);
      assert.equal((await s.call('GET', '/api/admin/overview', { cookie })).status, 200);
      ws.close();

      const before = {
        users: (await s.call('GET', '/api/admin/users', { cookie })).data.total,
        sessions: (await s.call('GET', '/api/admin/sessions', { cookie })).text,
        pokedex: (await s.call('GET', '/api/public/pokedex/mario')).text,
        leaderboard: (await s.call('GET', '/api/public/leaderboard')).text,
      };
      assert.equal(before.users, 1);
      await s.app.close();

      // Riavvio (come un riavvio del container sullo stesso volume).
      s = await serve({ dir, twitch: tw, eventsub: es, configureTwitch: false });
      const again = await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'NuovaPassword2026' } });
      assert.equal(again.status, 200, 'password cambiata conservata');
      const c2 = again.headers.get('set-cookie').split(';')[0];
      assert.equal((await s.call('GET', '/api/admin/users', { cookie: c2 })).data.total, before.users);
      assert.equal((await s.call('GET', '/api/admin/sessions', { cookie: c2 })).text, before.sessions);
      assert.equal((await s.call('GET', '/api/public/pokedex/mario')).text, before.pokedex);
      assert.equal((await s.call('GET', '/api/public/leaderboard')).text, before.leaderboard);
      assert.equal(s.app.engine.running, false, 'dopo il riavvio offline il motore resta spento');
      assert.equal(s.app.credentials.getToken('broadcaster').accessToken, 'access', 'token Twitch conservati e decifrabili');
    } finally { await s.app.close(); await es.stop(); cleanup(dir); }
  });
});
