// Utilità per i test: app isolata su cartella temporanea, finto Twitch
// (Helix + OAuth via fetch simulato, EventSub via vero server WebSocket locale).
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from '../src/database/migrations.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { request as httpRequest } from 'node:http';
import { loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { Logger } from '../src/logger.js';

export const BROADCASTER_ID = '1000';
export const CLIENT_ID = 'testclientid0000';

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'livecatch-test-'));
}

export async function waitFor(cond, { timeout = 3000, interval = 10, message = 'condizione non raggiunta' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Finto Twitch: stato manipolabile dai test.
export class FakeTwitch {
  constructor() {
    this.live = null; // { id, title, started_at }
    this.subscriptions = [];
    this.chat = [];
    this.redemptionUpdates = [];
    this.rewards = [];
    this.helixDown = false;
    this.tokenValid = true;
    // Coda dei riscatti su Twitch (per la riconciliazione): { id, reward:{id}, status:'UNFULFILLED', ... }
    this.queue = [];
    this.rewardPatches = [];
    this.failRewardPatch = 0; // numero di PATCH ricompensa che falliscono (500)
    this.failRedemptionUpdates = 0; // numero di PATCH riscatto che falliscono (500)
    this.goneRedemptions = new Set(); // id per cui Twitch risponde 404
    this.foreignRewards = new Set(); // ricompense non create da questo Client ID (403)
    this.calls = [];
    // Token revocati (access o refresh): Helix e /validate rispondono 401, il rinnovo 400.
    this.revokedTokens = new Set();
    // Guasti temporanei programmati (prima corrispondenza per prefisso del percorso):
    // { path, status, headers, network: true, hang: true, times } — times: -1 = sempre.
    this.faults = [];
    this.fetch = this.fetch.bind(this);
  }

  fault(path, opts = {}) { this.faults.push({ path, times: -1, status: 503, ...opts }); return this; }

  applyFault(u, opts) {
    const f = this.faults.find((x) => u.pathname.startsWith(x.path) && x.times !== 0);
    if (!f) return null;
    if (f.times > 0) f.times--;
    f.hits = (f.hits || 0) + 1;
    if (f.hang) {
      // Richiesta che non risponde mai: termina solo con l'AbortSignal del client.
      return new Promise((_, reject) => {
        const sig = opts.signal;
        if (!sig) return;
        if (sig.aborted) reject(sig.reason);
        sig.addEventListener('abort', () => reject(sig.reason), { once: true });
      });
    }
    if (f.network) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response(JSON.stringify({ status: f.status, message: 'fault' }), { status: f.status, headers: { 'Content-Type': 'application/json', ...(f.headers || {}) } }));
  }

  async fetch(url, opts = {}) {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();
    this.calls.push(`${method} ${u.pathname}`);
    const faulted = this.applyFault(u, opts);
    if (faulted) return faulted;
    const body = opts.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body;
    const res = (status, data) => new Response(data === undefined ? '' : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname.startsWith('/oauth2')) {
      const form = typeof opts.body === 'string' && !opts.body.startsWith('{') ? new URLSearchParams(opts.body) : null;
      // Device Code Flow (collegamento account): il primo polling è "pending", il secondo autorizza.
      if (u.pathname === '/oauth2/device') {
        this.deviceRequests = [...(this.deviceRequests || []), { clientId: form?.get('client_id'), scopes: form?.get('scopes') }];
        const role = form?.get('scopes') === 'user:write:chat' ? 'bot' : 'broadcaster';
        return res(200, { device_code: `dc-${role}`, user_code: role === 'bot' ? 'BOT-CODE' : 'LIVE-CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 1800, interval: 1 });
      }
      if (u.pathname === '/oauth2/token' && form?.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const dc = form.get('device_code');
        this.devicePolls = this.devicePolls || {};
        this.devicePolls[dc] = (this.devicePolls[dc] || 0) + 1;
        this.deviceTokenRequests = [...(this.deviceTokenRequests || []), Object.fromEntries(form)];
        if (this.devicePolls[dc] === 1) return res(400, { status: 400, message: 'authorization_pending' });
        const role = dc.replace('dc-', '');
        return res(200, { access_token: `dev-${role}-access`, refresh_token: `dev-${role}-refresh`, expires_in: 14000, scope: form.get('scopes').split(' ') });
      }
      if (u.pathname === '/oauth2/validate') {
        if (!this.tokenValid) return res(401, { message: 'invalid' });
        const auth = String(opts.headers?.Authorization || '');
        if (this.revokedTokens.has(auth.replace(/^OAuth /, ''))) return res(401, { status: 401, message: 'invalid access token' });
        if (auth.includes('dev-bot')) return res(200, { client_id: CLIENT_ID, login: 'mio_bot', user_id: '5000', scopes: ['user:write:chat'] });
        return res(200, { client_id: CLIENT_ID, login: 'streamer', user_id: BROADCASTER_ID, scopes: [] });
      }
      if (u.pathname === '/oauth2/token' && this.revokedTokens.has(form?.get('refresh_token'))) return res(400, { status: 400, message: 'Invalid refresh token' });
      if (u.pathname === '/oauth2/token') return res(200, { access_token: 'newaccess', refresh_token: 'newrefresh', expires_in: 14000, scope: [] });
      return res(404, {});
    }
    if (this.helixDown) throw new TypeError('fetch failed');
    const bearer = String(opts.headers?.Authorization || '').replace(/^Bearer /, '');
    if (this.revokedTokens.has(bearer)) { this.unauthorized = (this.unauthorized || 0) + 1; return res(401, { status: 401, message: 'Invalid OAuth token' }); }
    const p = u.pathname.replace('/helix', '');
    if (p === '/streams') return res(200, { data: this.live ? [{ id: this.live.id, title: this.live.title || 'Live', started_at: this.live.started_at || new Date().toISOString(), type: 'live' }] : [] });
    if (p === '/eventsub/subscriptions' && method === 'POST') { this.subscriptions.push(body); return res(202, { data: [{ id: `sub${this.subscriptions.length}`, status: 'enabled', type: body.type }] }); }
    if (p === '/chat/messages') { this.chat.push(body); return res(200, { data: [{ message_id: 'm', is_sent: true }] }); }
    if (p === '/channel_points/custom_rewards/redemptions' && method === 'GET') {
      const rid = u.searchParams.get('reward_id');
      if (this.foreignRewards.has(rid)) return res(403, { message: 'The ID in header must match the client ID' });
      const st = u.searchParams.get('status');
      return res(200, { data: this.queue.filter((r) => r.reward.id === rid && r.status === st), pagination: {} });
    }
    if (p === '/channel_points/custom_rewards/redemptions' && method === 'PATCH') {
      const id = u.searchParams.get('id');
      if (this.failRedemptionUpdates > 0) { this.failRedemptionUpdates--; return res(500, { message: 'Internal Server Error' }); }
      if (this.goneRedemptions.has(id)) return res(404, { message: 'redemption not found' });
      if (this.foreignRewards.has(u.searchParams.get('reward_id'))) return res(403, { message: 'forbidden' });
      this.redemptionUpdates.push({ id, status: body.status });
      const q = this.queue.find((r) => r.id === id);
      if (q) q.status = body.status;
      return res(200, { data: [{ id, status: body.status }] });
    }
    if (p === '/channel_points/custom_rewards' && method === 'PATCH') {
      const id = u.searchParams.get('id');
      if (this.failRewardPatch > 0) { this.failRewardPatch--; return res(500, { message: 'Internal Server Error' }); }
      if (this.foreignRewards.has(id)) return res(403, { message: 'forbidden' });
      this.rewardPatches.push({ id, ...body });
      return res(200, { data: [{ id, ...body }] });
    }
    if (p === '/channel_points/custom_rewards' && method === 'GET') return res(200, { data: this.rewards });
    if (p === '/channel_points/custom_rewards' && method === 'POST') {
      const r = { id: `00000000-0000-0000-0000-${String(this.rewards.length + 1).padStart(12, '0')}`, title: body.title, cost: body.cost, is_enabled: true };
      this.rewards.push(r);
      return res(200, { data: [r] });
    }
    return res(404, { message: 'not found' });
  }
}

// Server EventSub locale che parla il protocollo WebSocket di Twitch.
export class FakeEventSub {
  async start() {
    this.wss = new WebSocketServer({ port: 0 });
    this.sockets = new Set();
    this.sessionCounter = 0;
    this.msgCounter = 0;
    this.refuse = false; // true: le nuove connessioni vengono chiuse subito (Twitch irraggiungibile)
    this.wss.on('connection', (ws) => {
      if (this.refuse) { ws.terminate(); return; }
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.send(JSON.stringify({
        metadata: { message_id: `w${++this.msgCounter}`, message_type: 'session_welcome', message_timestamp: new Date().toISOString() },
        payload: { session: { id: `session-${++this.sessionCounter}`, status: 'connected', keepalive_timeout_seconds: 10 } },
      }));
    });
    await new Promise((r) => this.wss.on('listening', r));
    this.url = `ws://127.0.0.1:${this.wss.address().port}`;
    return this;
  }

  notify(type, event, { messageId = `n${++this.msgCounter}`, timestamp = new Date().toISOString() } = {}) {
    const msg = JSON.stringify({
      metadata: { message_id: messageId, message_type: 'notification', message_timestamp: timestamp, subscription_type: type, subscription_version: '1' },
      payload: { subscription: { type, version: '1', status: 'enabled' }, event },
    });
    for (const ws of this.sockets) ws.send(msg);
    return messageId;
  }

  // Revoca di una sottoscrizione (es. il canale scollega l'app: status "authorization_revoked").
  revoke(type, status = 'authorization_revoked') {
    const msg = JSON.stringify({
      metadata: { message_id: `r${++this.msgCounter}`, message_type: 'revocation', message_timestamp: new Date().toISOString(), subscription_type: type, subscription_version: '1' },
      payload: { subscription: { id: 'sub-x', type, version: '1', status, condition: {} } },
    });
    for (const ws of this.sockets) ws.send(msg);
  }

  dropAll() { for (const ws of this.sockets) ws.terminate(); }

  async stop() {
    for (const ws of this.sockets) ws.terminate();
    await new Promise((r) => this.wss.close(r));
  }
}

// Generatore deterministico: restituisce in sequenza i valori forniti (poi 0.5).
export function seqRng(values = []) {
  const q = [...values];
  const fn = () => (q.length ? q.shift() : 0.5);
  fn.push = (...v) => q.push(...v);
  return fn;
}

export async function makeApp({ dir = tempDir(), twitch = null, eventsub = null, configureTwitch = true, rng = null, env = {} } = {}) {
  const config = loadConfig({
    DATA_DIR: dir,
    ADMIN_INITIAL_PASSWORD: 'initialpass123',
    TWITCH_HELIX_BASE: 'http://twitch.test/helix',
    TWITCH_OAUTH_BASE: 'http://twitch.test/oauth2',
    TWITCH_EVENTSUB_URL: eventsub?.url || 'ws://127.0.0.1:1',
    TWITCH_EVENTSUB_BACKOFF_MS: '30',
    TWITCH_HTTP_RETRY_MS: '5', // ritentativi rapidi sugli errori temporanei di Twitch
    POKEAPI_BASE: 'http://pokeapi.test/api/v2',
    ...env,
  });
  const app = new App(config, {
    fetchImpl: twitch?.fetch || (async () => { throw new Error('rete disabilitata nei test'); }),
    timers: false,
    logger: new Logger({ level: 'warn', console: false }),
  });
  if (rng) app.rng = rng;
  await app.init();
  if (rng) app.engine.rng = rng;
  if (configureTwitch) {
    app.credentials.setApp({ clientId: CLIENT_ID, clientSecret: 'testsecret000000' });
    app.credentials.setToken('broadcaster', {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600e3, scopes: [], userId: BROADCASTER_ID, login: 'streamer', displayName: 'Streamer',
    });
  }
  return { app, dir, config };
}

// Database come lo lascerebbe una versione precedente dell'app: solo le migrazioni
// fino a upTo (es. 2 = 1.0.0-rc.2, 3 = 1.0.0-rc.3). Ritorna il percorso del file.
export function legacyDatabase(dir, upTo) {
  mkdirSync(join(dir, 'db'), { recursive: true });
  const file = join(dir, 'db', 'livecatch.sqlite');
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  d.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  for (const m of migrations.filter((x) => x.id <= upTo)) {
    d.exec(m.sql);
    d.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
  }
  d.close();
  return file;
}

export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignora */ }
}

// Pokémon di prova (nessuna dipendenza da PokéAPI nei test).
export function seedPokemon(db, list = null) {
  const rows = list || [
    { dex: 1, slug: 'testmon-a', name: 'Testmon A', rarity: 'common' },
    { dex: 2, slug: 'testmon-b', name: 'Testmon B', rarity: 'uncommon' },
    { dex: 3, slug: 'testmon-c', name: 'Testmon C', rarity: 'rare' },
    { dex: 4, slug: 'testmon-d', name: 'Testmon D', rarity: 'legendary' },
  ];
  for (const p of rows) {
    db.run('INSERT INTO pokemon (dex_number, slug, name, types, generation, rarity, enabled) VALUES (?, ?, ?, ?, 1, ?, ?)',
      p.dex, p.slug, p.name, JSON.stringify(p.types || ['normal']), p.rarity, p.enabled === false ? 0 : 1);
  }
  return db.all('SELECT * FROM pokemon ORDER BY id');
}

export function linkReward(app, ballCode = 'pokeball', rewardId = '11111111-1111-1111-1111-111111111111', managed = true) {
  const ball = app.db.get('SELECT * FROM ball_types WHERE code = ?', ballCode);
  app.db.run('INSERT INTO twitch_rewards (reward_id, ball_type_id, title, cost, managed_by_app) VALUES (?, ?, ?, 100, ?)', rewardId, ball.id, `Lancia ${ball.name}`, managed ? 1 : 0);
  return { rewardId, ball };
}

// Riscatto nel formato delle API Helix (GET .../redemptions), messo in coda sul finto Twitch.
export function queuedRedemption(opts) {
  return { ...redemption({ ...opts, status: 'UNFULFILLED' }) };
}

export function redemption({ id, rewardId, userId = '2001', login = 'mario', name = 'Mario', redeemedAt = new Date().toISOString(), status = 'unfulfilled' }) {
  return {
    id, broadcaster_user_id: BROADCASTER_ID, user_id: userId, user_login: login, user_name: name, user_input: '', status,
    reward: { id: rewardId, title: 'Lancia', cost: 100, prompt: '' }, redeemed_at: redeemedAt,
  };
}

// Richiesta HTTP di basso livello: permette di impostare liberamente Host,
// Origin, User-Agent e X-Forwarded-* (fetch non consente di cambiare Host).
export function rawRequest(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = httpRequest({
      host: '127.0.0.1', port, method, path,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* non JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Client HTTP autenticato come amministratore (login + cambio password obbligatorio).
// Usa le vere rotte, con cookie di sessione e token CSRF.
export async function adminClient(app, { password = 'NuovaPassword2026' } = {}) {
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  let csrf = '';
  const req = async (method, path, body, { auth = true, csrfToken } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && cookie ? { Cookie: cookie } : {}),
        ...(auth && method !== 'GET' ? { 'X-CSRF-Token': csrfToken ?? csrf } : {}),
        Origin: base,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const r0 = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'admin', password: 'initialpass123' }),
  });
  if (r0.status !== 200) throw new Error(`login non riuscito: ${r0.status}`);
  cookie = r0.headers.get('set-cookie').split(';')[0];
  csrf = (await r0.json()).csrf;
  const ch = await req('POST', '/api/auth/change-password', { currentPassword: 'initialpass123', newPassword: password });
  if (ch.status !== 200) throw new Error(`cambio password non riuscito: ${ch.status} ${JSON.stringify(ch.data)}`);
  csrf = (await req('GET', '/api/auth/me')).data.csrf;
  return { req, base, get cookie() { return cookie; }, get csrf() { return csrf; } };
}
