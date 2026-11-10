// Hub WebSocket: canale "overlay" (pubblico, sola lettura, accessibile da OBS da
// qualsiasi origine), canale "audio" (pubblico, sola lettura: solo gli effetti
// sonori, ascoltati dall'overlay /overlay quando gira nella Browser Source di
// OBS) e canale "admin" (sessione
// valida + controllo Host/Origin, delegati ad authorizeAdmin).
import { WebSocketServer } from 'ws';

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 421: 'Misdirected Request', 503: 'Service Unavailable' };

// Limiti del canale pubblico dell'overlay: abbondanti per molte sorgenti OBS
// (una per scena), anteprime del Designer e schermi in rete locale, ma
// sufficienti a impedire che un client esaurisca la memoria aprendo
// connessioni senza fine.
export const OVERLAY_LIMITS = { max: 100, perIp: 30 };

function reject(socket, code) {
  try {
    socket.write(`HTTP/1.1 ${code} ${STATUS_TEXT[code] || 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* socket già chiuso */ }
  socket.destroy();
}

export class WsHub {
  constructor({ authorizeAdmin, log, clientIp = (req) => req.socket?.remoteAddress || '', overlayLimits = {} }) {
    this.authorizeAdmin = authorizeAdmin;
    this.log = log;
    this.clientIp = clientIp;
    this.overlayLimits = { ...OVERLAY_LIMITS, ...overlayLimits };
    this.rejected = { overlayLimit: 0, malformed: 0 };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.clients = { overlay: new Set(), audio: new Set(), admin: new Set() };
    this.snapshotProviders = { overlay: null, audio: null, admin: null };
    this.heartbeat = setInterval(() => this.ping(), 30000);
    this.heartbeat.unref?.();
  }

  setSnapshot(channel, fn) { this.snapshotProviders[channel] = fn; }

  // Nessuna eccezione deve uscire dal gestore 'upgrade' del server HTTP: una
  // richiesta malformata riceve 400 e il socket viene sempre chiuso.
  handleUpgrade(req, socket, head) {
    try {
      this.upgrade(req, socket, head);
    } catch (e) {
      this.rejected.malformed++;
      this.log?.warn?.('Connessione WebSocket rifiutata: richiesta non valida', { message: e.message });
      reject(socket, 400);
    }
  }

  upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    let channel = null;
    let ip = '';
    if (url.pathname === '/ws/overlay' || url.pathname === '/ws/audio') {
      // Canali pubblici: stessi limiti, conteggiati separatamente.
      channel = url.pathname === '/ws/audio' ? 'audio' : 'overlay';
      ip = this.clientIp(req);
      const { max, perIp } = this.overlayLimits;
      const set = this.clients[channel];
      let same = 0;
      for (const ws of set) if (ws.clientIp === ip) same++;
      if (set.size >= max || same >= perIp) {
        this.rejected.overlayLimit++;
        if (this.rejected.overlayLimit === 1 || this.rejected.overlayLimit % 100 === 0) {
          this.log?.warn?.('Connessione overlay rifiutata: limite raggiunto', { channel, total: set.size, fromIp: same, max, perIp, rejected: this.rejected.overlayLimit });
        }
        return reject(socket, 503);
      }
    } else if (url.pathname === '/ws/admin') {
      const auth = this.authorizeAdmin ? this.authorizeAdmin(req) : { ok: false, status: 401 };
      if (!auth.ok) return reject(socket, auth.status || 401);
      channel = 'admin';
    } else {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.clientIp = ip;
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
  audio(type, data) { this.broadcast('audio', type, data); }
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

  counts() { return { overlay: this.clients.overlay.size, audio: this.clients.audio.size, admin: this.clients.admin.size }; }

  close() {
    clearInterval(this.heartbeat);
    for (const set of Object.values(this.clients)) for (const ws of set) ws.terminate();
    this.wss.close();
  }
}
