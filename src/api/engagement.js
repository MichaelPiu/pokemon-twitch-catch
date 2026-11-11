// API di Statistiche Community, Eventi automatici e Overlay rotante.
// Tutte le rotte sono sotto /api/admin/: sessione admin, CSRF e controllo
// Origin/Host vengono applicati dal server come per il resto della dashboard.
import { HttpError, readJson } from '../http/router.js';
import { audit } from '../audit.js';
import { PERIODS, LUCK_METRICS } from '../community/stats.js';

const wrap = (fn) => async (ctx) => {
  try { return await fn(ctx); } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.status) throw new HttpError(e.status, e.message);
    throw e;
  }
};

export function registerEngagementRoutes(app) {
  const r = app.router;
  const who = (ctx) => ctx.session?.username || null;
  const body = async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Richiesta non valida');
    return b;
  };

  // --- Statistiche Community -----------------------------------------------------
  r.get('/api/admin/community-stats', wrap((ctx) => {
    const period = ctx.query.get('period') || 'session';
    const metric = ctx.query.get('metric') || null;
    return {
      stats: app.communityStats.compute(period, { luckMetric: metric }),
      settings: app.communityStats.settings(),
      periods: PERIODS,
      metrics: Object.fromEntries(Object.entries(LUCK_METRICS).map(([k, m]) => [k, { label: m.label, explain: m.explain }])),
    };
  }));

  r.put('/api/admin/community-stats/settings', wrap(async (ctx) => {
    const b = await body(ctx);
    const next = app.communityStats.setSettings(b);
    audit(app.db, { admin: who(ctx), action: 'community_stats_settings', targetType: 'community_stats', detail: next }, app.log);
    app.rotation.scheduleRefresh();
    return next;
  }));

  // --- Eventi automatici ----------------------------------------------------------
  r.get('/api/admin/events', wrap(() => ({
    ...app.events.view(),
    announcements: app.chatMessages.announcementsPreview(['event_legendary_start', 'event_shiny_start', 'event_end', 'pokemon_of_day', 'pokemon_of_day_capture', 'community_goal_start', 'community_goal_complete']),
    chat: { enabled: app.chatMessages.settings().enabled, availability: app.chatMessages.availability() },
  })));

  r.put('/api/admin/events', wrap(async (ctx) => {
    const b = await body(ctx);
    app.events.setSettings(b, { admin: who(ctx) });
    return app.events.view();
  }));

  r.post('/api/admin/events/start', wrap(async (ctx) => {
    const b = await body(ctx);
    const type = String(b.type || '');
    const durationMin = b.durationMin == null || b.durationMin === '' ? null : Number(b.durationMin);
    return { active: app.events.startEvent(type, { by: 'admin', admin: who(ctx) || 'admin', durationMin }) };
  }));

  r.post('/api/admin/events/stop', wrap(async (ctx) => {
    await body(ctx);
    return { ended: app.events.stopEvent({ reason: 'admin', admin: who(ctx) || 'admin' }) };
  }));

  r.post('/api/admin/events/community/new', wrap(async (ctx) => {
    const b = await body(ctx);
    const s = app.events.settings();
    if (!s.enabled || !s.community.enabled) throw new HttpError(409, 'Attiva prima gli eventi automatici e l\'Evento Community');
    return { community: app.events.newCommunityGoal({ admin: who(ctx), goal: b.goal == null || b.goal === '' ? null : Number(b.goal) }) };
  }));

  // --- Overlay rotante ---------------------------------------------------------------
  r.get('/api/admin/rotation', wrap(() => app.rotation.view()));

  r.put('/api/admin/rotation', wrap(async (ctx) => {
    const b = await body(ctx);
    const next = app.rotation.setSettings(b);
    audit(app.db, { admin: who(ctx), action: 'overlay_rotation_settings', targetType: 'overlay_rotation', detail: { enabled: next.enabled, lock: next.lock, screens: next.screens.filter((x) => x.enabled).map((x) => x.key) } }, app.log);
    return app.rotation.view();
  }));

  // Blocca una schermata (screen: null = sblocca e riprendi la rotazione).
  r.post('/api/admin/rotation/lock', wrap(async (ctx) => {
    const b = await body(ctx);
    app.rotation.setLock(b.screen ?? null);
    audit(app.db, { admin: who(ctx), action: 'overlay_rotation_lock', targetType: 'overlay_rotation', detail: { screen: b.screen ?? null } }, app.log);
    return app.rotation.view();
  }));

  r.post('/api/admin/rotation/next', wrap(async (ctx) => {
    await body(ctx);
    if (!app.rotation.settings().enabled) throw new HttpError(409, 'L\'overlay rotante è disattivato');
    app.rotation.advance({ reason: 'admin' });
    return app.rotation.view();
  }));

  r.get('/api/admin/rotation/preview', wrap((ctx) => app.rotation.preview(String(ctx.query.get('screen') || 'leaderboard'))));
}
