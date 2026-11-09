// Utilità per i test: app isolata su cartella temporanea, finto Twitch
// (Helix + OAuth via fetch simulato, EventSub via vero server WebSocket locale).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
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
    this.calls = [];
    this.fetch = this.fetch.bind(this);
  }

  async fetch(url, opts = {}) {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();
    this.calls.push(`${method} ${u.pathname}`);
    const body = opts.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body;
    const res = (status, data) => new Response(data === undefined ? '' : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname.startsWith('/oauth2')) {
      if (u.pathname === '/oauth2/validate') return this.tokenValid ? res(200, { client_id: CLIENT_ID, login: 'streamer', user_id: BROADCASTER_ID, scopes: [] }) : res(401, { message: 'invalid' });
      if (u.pathname === '/oauth2/token') return res(200, { access_token: 'newaccess', refresh_token: 'newrefresh', expires_in: 14000, scope: [] });
      return res(404, {});
    }
    if (this.helixDown) throw new TypeError('fetch failed');
    const p = u.pathname.replace('/helix', '');
    if (p === '/streams') return res(200, { data: this.live ? [{ id: this.live.id, title: this.live.title || 'Live', started_at: this.live.started_at || new Date().toISOString(), type: 'live' }] : [] });
    if (p === '/eventsub/subscriptions' && method === 'POST') { this.subscriptions.push(body); return res(202, { data: [{ id: `sub${this.subscriptions.length}`, status: 'enabled', type: body.type }] }); }
    if (p === '/chat/messages') { this.chat.push(body); return res(200, { data: [{ message_id: 'm', is_sent: true }] }); }
    if (p === '/channel_points/custom_rewards/redemptions') { this.redemptionUpdates.push({ id: u.searchParams.get('id'), status: body.status }); return res(200, { data: [] }); }
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
    this.wss.on('connection', (ws) => {
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

export async function makeApp({ dir = tempDir(), twitch = null, eventsub = null, configureTwitch = true, rng = null } = {}) {
  const config = loadConfig({
    DATA_DIR: dir,
    ADMIN_INITIAL_PASSWORD: 'initialpass123',
    TWITCH_HELIX_BASE: 'http://twitch.test/helix',
    TWITCH_OAUTH_BASE: 'http://twitch.test/oauth2',
    TWITCH_EVENTSUB_URL: eventsub?.url || 'ws://127.0.0.1:1',
    TWITCH_EVENTSUB_BACKOFF_MS: '30',
    POKEAPI_BASE: 'http://pokeapi.test/api/v2',
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

export function redemption({ id, rewardId, userId = '2001', login = 'mario', name = 'Mario', redeemedAt = new Date().toISOString(), status = 'unfulfilled' }) {
  return {
    id, broadcaster_user_id: BROADCASTER_ID, user_id: userId, user_login: login, user_name: name, user_input: '', status,
    reward: { id: rewardId, title: 'Lancia', cost: 100, prompt: '' }, redeemed_at: redeemedAt,
  };
}
