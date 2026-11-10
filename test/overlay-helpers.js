// Utilità condivise dai test dell'overlay: server con login amministratore,
// WebSocket dell'overlay che raccoglie i messaggi, fotografia del database.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { makeApp } from './helpers.js';

export async function startServer(opts = {}) {
  const ctx = await makeApp({ configureTwitch: false, ...opts });
  const app = ctx.app;
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  let csrf = '';
  const req = async (method, path, body, { auth = true, raw = false, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && cookie ? { Cookie: cookie } : {}),
        ...(auth && csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const login = async (password = 'initialpass123', next = 'NuovaPassword2026') => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    assert.equal(res.status, 200);
    cookie = res.headers.get('set-cookie').split(';')[0];
    const me = await req('GET', '/api/auth/me');
    csrf = me.data.csrf;
    if (me.data.mustChangePassword) {
      assert.equal((await req('POST', '/api/auth/change-password', { currentPassword: password, newPassword: next })).status, 200);
      csrf = (await req('GET', '/api/auth/me')).data.csrf;
    }
  };
  const authHeaders = () => ({ Cookie: cookie, 'X-CSRF-Token': csrf });
  return { ctx, app, port, base, req, login, authHeaders };
}

// Apre il WebSocket dell'overlay e raccoglie i messaggi.
export function overlaySocket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  return { ws, msgs, open: new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }) };
}

// Fotografia completa del database (tutte le tabelle, tutte le righe): serve a
// dimostrare che il simulatore non scrive nulla.
export function dbFingerprint(db) {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, JSON.stringify(db.all(`SELECT * FROM "${t}" ORDER BY rowid`))]));
}
