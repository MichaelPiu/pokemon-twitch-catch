// Client EventSub via WebSocket: nessuna porta da aprire sul router.
// Gestisce welcome, keepalive, reconnect richiesto da Twitch, revoche e
// riconnessione automatica con backoff esponenziale.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class EventSubClient extends EventEmitter {
  constructor({ url, log, WebSocketImpl = WebSocket, backoffBaseMs = 1000, backoffMaxMs = 60000 }) {
    super();
    this.url = url;
    this.log = log;
    this.WS = WebSocketImpl;
    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.stopped = true;
    this.attempt = 0;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.keepaliveMs = 15000;
    this.lastMessageAt = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open(this.url, false);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.keepaliveTimer);
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(); this.ws.terminate?.(); } catch { /* ignora */ } }
    this.ws = null;
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected', { reason: 'stopped' });
    }
    this.sessionId = null;
  }

  open(url, isTwitchReconnect) {
    const ws = new this.WS(url);
    const previous = isTwitchReconnect ? this.ws : null;
    if (!isTwitchReconnect) this.ws = ws;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.lastMessageAt = Date.now();
      this.armKeepalive();
      const type = msg?.metadata?.message_type;
      if (type === 'session_welcome') {
        const session = msg.payload.session;
        this.keepaliveMs = ((session.keepalive_timeout_seconds || 10) + 5) * 1000;
        this.armKeepalive();
        if (isTwitchReconnect) {
          // Le sottoscrizioni vengono trasferite da Twitch: chiude la vecchia connessione.
          this.ws = ws;
          if (previous) { try { previous.removeAllListeners(); previous.close(); } catch { /* ignora */ } }
        }
        this.sessionId = session.id;
        this.connected = true;
        this.attempt = 0;
        this.emit('connected', { sessionId: session.id, resubscribe: !isTwitchReconnect });
      } else if (type === 'session_keepalive') {
        // solo heartbeat
      } else if (type === 'notification') {
        this.emit('notification', {
          messageId: msg.metadata.message_id,
          messageTimestamp: msg.metadata.message_timestamp,
          type: msg.metadata.subscription_type,
          event: msg.payload.event,
          subscription: msg.payload.subscription,
        });
      } else if (type === 'session_reconnect') {
        this.log.info('Twitch richiede la riconnessione EventSub');
        this.open(msg.payload.session.reconnect_url, true);
      } else if (type === 'revocation') {
        this.log.warn('Sottoscrizione EventSub revocata', { type: msg.payload?.subscription?.type, status: msg.payload?.subscription?.status });
        this.emit('revocation', msg.payload.subscription);
      }
    });

    ws.on('close', (code) => {
      if (ws !== this.ws) return; // vecchia connessione chiusa dopo un reconnect
      this.handleDrop(`closed:${code}`);
    });
    ws.on('error', (err) => {
      this.log.warn('Errore WebSocket EventSub', { message: err.message });
      if (ws === this.ws && ws.readyState !== 1) this.handleDrop('error');
    });
  }

  armKeepalive() {
    clearTimeout(this.keepaliveTimer);
    if (this.stopped) return;
    this.keepaliveTimer = setTimeout(() => {
      this.log.warn('Keepalive EventSub scaduto: connessione considerata persa');
      this.handleDrop('keepalive_timeout');
    }, this.keepaliveMs);
    this.keepaliveTimer.unref?.();
  }

  handleDrop(reason) {
    clearTimeout(this.keepaliveTimer);
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.terminate?.(); } catch { /* ignora */ } }
    this.ws = null;
    const wasConnected = this.connected;
    this.connected = false;
    this.sessionId = null;
    if (wasConnected || this.attempt === 0) this.emit('disconnected', { reason });
    if (this.stopped) return;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt) * (0.8 + Math.random() * 0.4);
    this.attempt++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(this.url, false), delay);
    this.reconnectTimer.unref?.();
  }
}
