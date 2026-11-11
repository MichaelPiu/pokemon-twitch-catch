// API dei messaggi automatici in chat (sezione "Messaggi Twitch" della dashboard).
// Tutte le rotte sono sotto /api/admin/: sessione admin, CSRF e controllo
// Origin/Host vengono applicati dal server come per il resto della dashboard.
// Gli utenti della chat non hanno alcun accesso ai modelli dei messaggi.
import { HttpError, readJson } from '../http/router.js';
import { audit } from '../audit.js';
import { RateLimiter } from '../security/rateLimit.js';

export function registerChatMessageRoutes(app) {
  const r = app.router;
  const who = (ctx) => ctx.session?.username || null;
  const testLimiter = new RateLimiter({ max: 5, windowMs: 60000 });
  const body = async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Richiesta non valida');
    return b;
  };

  r.get('/api/admin/chat-messages', () => app.chatMessages.view());

  r.put('/api/admin/chat-messages', async (ctx) => {
    const b = await body(ctx);
    const before = app.chatMessages.settings();
    const next = app.chatMessages.setSettings(b);
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length) {
      audit(app.db, { admin: who(ctx), action: 'chat_messages_settings', targetType: 'chat_messages', detail: { changed, enabled: next.enabled, messages: next.messages.length } }, app.log);
    }
    return app.chatMessages.view();
  });

  // Anteprima con valori d'esempio (nessun invio).
  r.post('/api/admin/chat-messages/preview', async (ctx) => {
    const b = await body(ctx);
    return { message: app.chatMessages.preview(String(b.text ?? ''), String(b.event || 'spawn')) };
  });

  // Invio di prova esplicito: parte solo se Twitch è collegato.
  r.post('/api/admin/chat-messages/test', async (ctx) => {
    const b = await body(ctx);
    if (!testLimiter.hit(who(ctx) || 'admin')) throw new HttpError(429, 'Troppe prove ravvicinate: riprova tra un minuto');
    const out = await app.chatMessages.test({ text: b.text, event: String(b.event || 'spawn') });
    audit(app.db, { admin: who(ctx), action: 'chat_messages_test', targetType: 'chat_messages', detail: { event: b.event || 'spawn', account: out.account } }, app.log);
    return out;
  });
}
