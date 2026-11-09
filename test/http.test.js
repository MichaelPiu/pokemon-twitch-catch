import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { makeApp, cleanup, seedPokemon, waitFor } from './helpers.js';

describe('HTTP: autenticazione, sicurezza, pagine', () => {
  let ctx, app, base, cookie = '', csrf = '';

  const req = async (method, path, body, { headers = {}, withAuth = true } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(withAuth && cookie ? { Cookie: cookie } : {}), ...(withAuth && csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };

  before(async () => {
    ctx = await makeApp({ configureTwitch: false });
    app = ctx.app;
    seedPokemon(app.db);
    const port = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => { await app.close(); cleanup(ctx.dir); });

  test('/health risponde', async () => {
    const r = await req('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.db, 'ok');
  });

  test('API admin protette senza login', async () => {
    assert.equal((await req('GET', '/api/admin/overview', null, { withAuth: false })).status, 401);
  });

  test('login, cambio password obbligatorio, CSRF', async () => {
    assert.equal((await req('POST', '/api/auth/login', { username: 'admin', password: 'sbagliata' })).status, 401);
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'initialpass123' });
    assert.equal(r.status, 200);
    assert.equal(r.data.mustChangePassword, true);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    cookie = sc.split(';')[0];
    csrf = r.data.csrf;

    const blocked = await req('GET', '/api/admin/overview');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.details.mustChangePassword, true);

    assert.equal((await req('POST', '/api/auth/change-password', { currentPassword: 'initialpass123', newPassword: 'corta' })).status, 400);
    const saved = csrf;
    csrf = 'token-sbagliato';
    assert.equal((await req('POST', '/api/auth/change-password', { currentPassword: 'initialpass123', newPassword: 'NuovaPassword2026' })).status, 403, 'CSRF richiesto');
    csrf = saved;
    assert.equal((await req('POST', '/api/auth/change-password', { currentPassword: 'initialpass123', newPassword: 'NuovaPassword2026' })).status, 200);
    const ov = await req('GET', '/api/admin/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.data.lifecycle.state, 'OFFLINE');
  });

  test('nessun segreto Twitch esposto al frontend', async () => {
    app.credentials.setApp({ clientId: 'abcdefghij1234', clientSecret: 'supersegreto12345' });
    app.credentials.setToken('broadcaster', { accessToken: 'tokensegreto', refreshToken: 'refreshsegreto', userId: '1', login: 'x' });
    const r = await req('GET', '/api/admin/twitch');
    const s = JSON.stringify(r.data);
    assert.ok(!s.includes('supersegreto12345'));
    assert.ok(!s.includes('tokensegreto'));
    assert.ok(!s.includes('refreshsegreto'));
    assert.equal(r.data.credentials.clientSecretSet, true);
    const logs = JSON.stringify((await req('GET', '/api/admin/logs?level=debug')).data);
    assert.ok(!logs.includes('tokensegreto'));
  });

  test('validazione input impostazioni', async () => {
    const r = await req('PUT', '/api/admin/spawn/settings', { minIntervalS: 500, maxIntervalS: 100 });
    assert.equal(r.status, 400);
    const ok = await req('PUT', '/api/admin/spawn/settings', { minIntervalS: 60, maxIntervalS: 120 });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.maxIntervalS, 120);
    assert.equal((await req('PUT', '/api/admin/overlay', { colors: { primary: 'javascript:alert(1)' } })).status, 400);
  });

  test('generazione manuale bloccata da offline, consentita in DEMO', async () => {
    assert.equal((await req('POST', '/api/admin/spawn/manual', {})).status, 409);
    assert.equal((await req('POST', '/api/admin/demo/start')).status, 200);
    const sp = await req('POST', '/api/admin/spawn/manual', { pokemonId: 1 });
    assert.equal(sp.status, 200);
    assert.equal(sp.data.demo, true);
    const ball = app.db.get("SELECT id FROM ball_types WHERE code = 'masterball'");
    const t = await req('POST', '/api/admin/demo/throw', { username: 'Tester', ballTypeId: ball.id });
    assert.equal(t.data.caught, true);
    assert.equal((await req('POST', '/api/admin/demo/stop')).status, 200);
    assert.equal((await req('POST', '/api/admin/demo/clear')).status, 200);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE is_demo = 1').n, 0);
  });

  test('overlay WebSocket riceve snapshot ed eventi', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/overlay');
    const msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    await waitFor(() => msgs.some((m) => m.type === 'snapshot'));
    assert.equal(msgs[0].data.active, false);
    app.engine.startDemo();
    app.engine.spawn({ pokemonId: 2 });
    await waitFor(() => msgs.some((m) => m.type === 'spawn'));
    app.engine.stopDemo();
    await waitFor(() => msgs.some((m) => m.type === 'clear'));
    ws.close();
  });

  test('WebSocket admin rifiuta connessioni non autenticate', async () => {
    // Origin corretto (stessa origine della dashboard) ma nessun cookie: 401.
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/admin', { headers: { Origin: base } });
    const err = await new Promise((resolve) => { ws.on('unexpected-response', (_q, res) => resolve(res.statusCode)); ws.on('error', () => resolve('error')); });
    assert.equal(err, 401);
  });

  test('pagine pubbliche servite e disattivabili; path traversal bloccato', async () => {
    assert.equal((await req('GET', '/overlay')).status, 200);
    assert.equal((await req('GET', '/admin')).status, 200);
    assert.equal((await req('GET', '/leaderboard')).status, 200);
    assert.equal((await req('GET', '/pokedex/mario')).status, 200);
    assert.equal((await req('GET', '/images/..%2F..%2Fpackage.json')).status, 404);
    assert.equal((await req('GET', '/assets/../src/server.js')).status, 404);
    await req('PUT', '/api/admin/public-pages', { leaderboard: false, pokedex: false });
    assert.equal((await req('GET', '/leaderboard')).status, 404);
    assert.equal((await req('GET', '/api/public/leaderboard')).status, 404);
    assert.equal((await req('GET', '/api/public/pokedex/mario')).status, 404);
    await req('PUT', '/api/admin/public-pages', { leaderboard: true, pokedex: true });
    app.db.run("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('5', 'mario', 'Mario')");
    const pd = await req('GET', '/api/public/pokedex/Mario');
    assert.equal(pd.status, 200);
    assert.equal(pd.data.trainer.displayName, 'Mario');
  });

  test('rate limiting del login', async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await req('POST', '/api/auth/login', { username: 'admin', password: 'x' }, { withAuth: false, headers: { 'X-Forwarded-For': '10.9.9.9' } });
    assert.equal(last.status, 429);
  });
});
