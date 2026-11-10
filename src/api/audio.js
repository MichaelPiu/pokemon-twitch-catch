// API degli effetti sonori per OBS (sezione "Audio OBS" della dashboard).
// Tutte le rotte sono sotto /api/admin/: sessione admin, CSRF e controllo
// Origin/Host vengono applicati dal server come per il resto della dashboard.
// La dashboard non riproduce mai l'audio: la prova invia l'evento solo
// all'overlay /overlay aperto nella Browser Source di OBS.
import { HttpError, readJson } from '../http/router.js';
import { audit } from '../audit.js';

export function registerAudioRoutes(app) {
  const r = app.router;
  const who = (ctx) => ctx.session?.username || null;

  r.get('/api/admin/audio', () => ({ ...app.audio.view(), dir: app.config.audioDir }));

  r.put('/api/admin/audio', async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Richiesta non valida');
    const before = app.audio.settings();
    const next = app.audio.setSettings(b);
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length) audit(app.db, { admin: who(ctx), action: 'audio_settings', targetType: 'audio', detail: { changed } }, app.log);
    app.log.info('Impostazioni audio aggiornate', { changed });
    return { ...app.audio.view(), dir: app.config.audioDir };
  });

  r.post('/api/admin/audio/test', async (ctx) => {
    const b = await readJson(ctx.req);
    return app.audio.test({ kind: b?.kind, fileId: b?.fileId });
  });
}
