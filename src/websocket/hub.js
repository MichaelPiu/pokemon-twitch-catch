// Hub WebSocket: canale "overlay" (pubblico, sola lettura) e canale "admin"
// (richiede sessione amministratore valida).
import { WebSocketServer } from 'ws';
import { parseCookies } from '../http/router.js';
import { SESSION_COOKIE } from '../security/auth.js';

export class WsHub {
  constructor({ auth, log }) {
    this.auth = auth;
    this.log = log;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.clients = { overlay: new Set(), admin: new Set() };
    this.snapshotProviders = { overlay: null, admin: null };
    this.heartbeat = setInterval(() => this.ping(), 30000);
    this.heartbeat.unref?.();
  }

  setSnapshot(channel, fn) { this.snapshotProviders[channel] = fn; }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    let channel = null;
    if (url.pathname === '/ws/overlay') channel = 'overlay';
    else if (url.pathname === '/ws/admin') {
      const session = this.auth.resolve(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (!session || session.mustChangePassword) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      channel = 'admin';
    } else {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', () => { /* i client non inviano comandi via WS */ });
      ws.on('close', () => this.clients[channel].delete(ws));
      ws.on('error', () => this.clients[channel].delete(ws));
      this.clients[channel].add(ws);
      const snap = this.snapshotProviders[channel]?.();
      if (snap) this.sendTo(ws, 'snapshot', snap);
    });
  }

  sendTo(ws, type, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data, ts: Date.now() }));
  }

  broadcast(channel, type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const ws of this.clients[channel]) if (ws.readyState === 1) ws.send(msg);
  }

  overlay(type, data) { this.broadcast('overlay', type, data); }
  admin(type, data) { this.broadcast('admin', type, data); }

  ping() {
    for (const set of Object.values(this.clients)) {
      for (const ws of set) {
        if (!ws.isAlive) { ws.terminate(); set.delete(ws); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignora */ }
      }
    }
  }

  counts() { return { overlay: this.clients.overlay.size, admin: this.clients.admin.size }; }

  close() {
    clearInterval(this.heartbeat);
    for (const set of Object.values(this.clients)) for (const ws of set) ws.terminate();
    this.wss.close();
  }
}
