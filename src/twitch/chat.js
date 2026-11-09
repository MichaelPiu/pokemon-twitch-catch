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
    if (bot?.accessToken && bot.userId) return { role: 'bot', id: bot.userId };
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
        }
      }
    } finally {
      this.sending = false;
    }
  }

  stats() { return { sent: this.sent, dropped: this.dropped, queued: this.queue.length, lastError: this.lastError }; }
}
