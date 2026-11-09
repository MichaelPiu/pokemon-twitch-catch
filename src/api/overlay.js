// API dell'Overlay Designer: temi (elenco, modifica, duplicazione, ripristino,
// importazione/esportazione, attivazione) e simulatore.
// Tutte le rotte sono sotto /api/admin/: login, CSRF e controllo Origin/Host
// vengono applicati dal server come per il resto della dashboard.
import { HttpError, readJson } from '../http/router.js';
import { LAYOUTS, FONTS, POSITIONS, ENTRANCES, EXITS, TIMER_STYLES, MAX_IMPORT_BYTES } from '../../public/assets/js/overlay/theme-core.js';
import { SIM_KINDS } from '../overlay/simulator.js';

const wrap = (fn) => async (ctx) => {
  try { return await fn(ctx); } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.status) throw new HttpError(e.status, e.message, e.current ? { current: e.current } : undefined);
    throw e;
  }
};

export function registerOverlayRoutes(app) {
  const r = app.router;
  const themes = app.themes;
  // Il tema attivo è cambiato o modificato: l'overlay in OBS si aggiorna subito.
  const pushIfActive = (id) => { if (themes.activeId() === id) app.hub.overlay('settings', themes.effective()); };

  r.get('/api/admin/overlay/themes', () => ({
    activeId: themes.activeId(),
    themes: themes.list(),
    options: {
      layouts: LAYOUTS, fonts: Object.fromEntries(Object.entries(FONTS).map(([k, [label]]) => [k, label])),
      positions: POSITIONS, entrances: ENTRANCES, exits: EXITS, timerStyles: TIMER_STYLES,
    },
    obs: {
      width: app.overlaySettings.get('layout').width || 1920, height: app.overlaySettings.get('layout').height || 1080,
      overlays: app.hub.counts().overlay, busy: app.simulator.publicOverlayBusy(),
    },
  }));

  r.get('/api/admin/overlay/themes/:id', wrap((ctx) => themes.require(ctx.params.id)));

  r.post('/api/admin/overlay/themes', wrap(async (ctx) => {
    const b = await readJson(ctx.req);
    return themes.create({ name: b.name, base: b.base, config: b.config });
  }));

  r.post('/api/admin/overlay/themes/:id/duplicate', wrap(async (ctx) => {
    const b = await readJson(ctx.req);
    return { theme: themes.duplicate(ctx.params.id, b.name) };
  }));

  r.put('/api/admin/overlay/themes/:id', wrap(async (ctx) => {
    const b = await readJson(ctx.req);
    // Controllo delle modifiche concorrenti: serve la revisione su cui si è
    // lavorato. "force: true" sovrascrive consapevolmente (scelta esplicita del Designer).
    const force = b.force === true;
    if (!force && b.rev === undefined) throw new HttpError(400, 'Revisione del tema mancante: ricarica il Designer');
    const out = themes.update(ctx.params.id, { name: b.name, config: b.config, rev: force ? undefined : b.rev });
    pushIfActive(out.theme.id);
    return out;
  }));

  r.post('/api/admin/overlay/themes/:id/reset', wrap((ctx) => {
    const theme = themes.reset(ctx.params.id);
    pushIfActive(theme.id);
    return { theme };
  }));

  r.post('/api/admin/overlay/themes/:id/activate', wrap((ctx) => {
    const theme = themes.setActive(ctx.params.id);
    const settings = themes.effective();
    app.hub.overlay('settings', settings);
    app.log.info(`Tema overlay attivo: ${theme.name}`);
    return { activeId: theme.id, theme, overlays: app.hub.counts().overlay };
  }));

  r.delete('/api/admin/overlay/themes/:id', wrap((ctx) => {
    const out = themes.remove(ctx.params.id);
    if (out.activeChanged) app.hub.overlay('settings', themes.effective());
    return { ...out, activeId: themes.activeId() };
  }));

  r.get('/api/admin/overlay/themes/:id/export', wrap((ctx) => themes.exportJson(ctx.params.id)));

  r.post('/api/admin/overlay/themes/import', wrap(async (ctx) => {
    const b = await readJson(ctx.req, MAX_IMPORT_BYTES + 1024);
    // Accetta sia il file esportato così com'è sia { json: "<testo>" }.
    return themes.importJson(typeof b.json === 'string' ? b.json : b);
  }));

  // Simulatore: target "preview" (solo anteprima, nessun invio) oppure "obs".
  r.post('/api/admin/overlay/simulate', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 32 * 1024);
    const kind = b.kind;
    if (typeof kind !== 'string' || !SIM_KINDS.includes(kind)) throw new HttpError(400, 'Tipo di simulazione non valido');
    // Destinazione esplicita: "preview" = anteprima privata del Designer (nessun invio),
    // "obs" = overlay pubblico (solo a gioco fermo).
    const target = b.target === undefined ? 'preview' : b.target;
    if (target !== 'preview' && target !== 'obs') throw new HttpError(400, 'Destinazione non valida: "preview" oppure "obs"');
    if (b.text !== undefined && typeof b.text !== 'string') throw new HttpError(400, 'Il testo della notifica deve essere una stringa');
    const d = b.durationS === undefined ? 60 : Number(b.durationS);
    if (!Number.isFinite(d)) throw new HttpError(400, 'Durata non valida');
    const opts = { text: b.text, durationS: Math.min(300, Math.max(5, Math.round(d))) };
    if (target === 'obs') return { ...app.simulator.sendToObs(kind, opts), target };
    return { ...app.simulator.build(kind, { ...opts, spawn: b.spawn }), target };
  }));
}
