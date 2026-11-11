// Invio messaggi in chat tramite Helix (POST /chat/messages) con coda e
// limite di messaggi per finestra, per non superare i limiti di Twitch.
import { RateLimiter } from '../security/rateLimit.js';

export class ChatSender {
  constructor({ helix, credentials, log, getLimits }) {
    this.helix = helix;
    this.creds = credentials;
    this.log = log;
    this.getLimits = getLimits;
    this.queue = [];
    this.sending = false;
    this.limiter = null;
    this.limiterKey = '';
    this.sent = 0;
    this.dropped = 0;
    this.lastError = null;
  }

  limiterNow() {
    const { botMaxPerWindow, botWindowS } = this.getLimits();
    const key = `${botMaxPerWindow}/${botWindowS}`;
    if (key !== this.limiterKey) {
      this.limiter = new RateLimiter({ max: botMaxPerWindow, windowMs: botWindowS * 1000 });
      this.limiterKey = key;
    }
    return this.limiter;
  }

  sender() {
    const bot = this.creds.getToken('bot');
    // Un bot con token revocato non blocca la chat: risponde l'account del canale.
    if (bot?.accessToken && bot.userId && !bot.authError) return { role: 'bot', id: bot.userId };
    const b = this.creds.getToken('broadcaster');
    return b?.userId ? { role: 'broadcaster', id: b.userId } : null;
  }

  send(message, replyTo = null) {
    if (this.queue.length >= 20) { this.dropped++; return false; }
    this.queue.push({ message: String(message).slice(0, 480), replyTo });
    this.drain();
    return true;
  }

  async drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        if (!this.limiterNow().hit('bot')) {
          // Limite raggiunto: scarta i messaggi in eccesso invece di accumulare ritardo.
          this.dropped += this.queue.length;
          this.queue = [];
          this.log.warn('Limite risposte bot raggiunto: messaggi scartati');
          break;
        }
        const item = this.queue.shift();
        const s = this.sender();
        const broadcaster = this.creds.getToken('broadcaster');
        if (!s || !broadcaster?.userId) { this.lastError = 'Nessun account per la chat'; continue; }
        try {
          const r = await this.helix.sendChatMessage({
            broadcasterId: broadcaster.userId, senderId: s.id, message: item.message, replyTo: item.replyTo, role: s.role,
          });
          if (r && r.is_sent === false) {
            this.lastError = r.drop_reason?.message || 'Messaggio scartato da Twitch';
            this.log.warn('Messaggio chat non inviato', { reason: this.lastError });
          } else {
            this.sent++;
          }
        } catch (e) {
          this.lastError = e.message;
          this.log.warn('Errore invio chat', { message: e.message });
          if (s.role === 'bot' && (e.authInvalid || e.status === 401)) {
            this.creds.markInvalid('bot', e.message);
            this.log.error('Token del bot revocato o scaduto: le risposte passano all\'account del canale finché non ricolleghi il bot');
            if (!item.retried) this.queue.unshift({ ...item, retried: true });
          }
        }
      }
    } finally {
      this.sending = false;
    }
  }

  // Invio immediato con esito, per i messaggi automatici: solo con l'account
  // indicato (nessun ripiego sull'account del canale) e dentro gli stessi limiti
  // delle risposte del bot. Non lancia mai eccezioni.
  async deliver(message, { role = 'bot' } = {}) {
    try {
      if (!this.limiterNow().hit('bot')) { this.dropped++; return { ok: false, code: 'rate_limited', message: 'Limite di messaggi del bot raggiunto' }; }
      const broadcaster = this.creds.getToken('broadcaster');
      const sender = this.creds.getToken(role);
      if (!broadcaster?.userId || !sender?.userId) return { ok: false, code: 'no_sender', message: 'Nessun account per la chat' };
      const r = await this.helix.sendChatMessage({ broadcasterId: broadcaster.userId, senderId: sender.userId, message: String(message).slice(0, 480), role });
      if (r && r.is_sent === false) {
        this.lastError = r.drop_reason?.message || 'Messaggio scartato da Twitch';
        return { ok: false, code: 'dropped', message: this.lastError };
      }
      this.sent++;
      return { ok: true, messageId: r?.message_id || null };
    } catch (e) {
      this.lastError = e.message;
      if (role === 'bot' && (e.authInvalid || e.status === 401)) {
        this.creds.markInvalid('bot', e.message);
        this.log.error('Token del bot revocato o scaduto: ricollega il bot');
      }
      const code = e.status === 429 ? 'rate_limited' : e.status === 403 ? 'forbidden' : (e.authInvalid || e.status === 401) ? 'auth' : e.transient ? 'unreachable' : 'error';
      return { ok: false, code, status: e.status || null, message: e.message };
    }
  }

  stats() { return { sent: this.sent, dropped: this.dropped, queued: this.queue.length, lastError: this.lastError }; }
}
