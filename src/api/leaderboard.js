// API delle Classifiche: classifiche di sessione, controlli dell'overlay,
// congelamento, Hall of Fame, riepiloghi, giocatori e regole di punteggio.
// Tutte le rotte sono sotto /api/admin/: sessione admin, CSRF e controllo
// Origin/Host vengono applicati dal server come per il resto della dashboard.
import { HttpError, readJson, v } from '../http/router.js';
import { SCREENS, BOARDS, HOF_KINDS } from '../leaderboard/leaderboard.js';
import { audit } from '../audit.js';

const wrap = (fn) => async (ctx) => {
  try { return await fn(ctx); } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.status) throw new HttpError(e.status, e.message);
    throw e;
  }
};
const id = (x, name = 'ID') => v.num(x, { min: 1, int: true, name });
const sessionRef = (x) => (x === undefined || x === null || x === '' || x === 'current' ? 'current' : id(x, 'Sessione'));
const kindOf = (x) => {
  if (x == null || x === '' || x === 'all') return null;
  if (!['twitch', 'manual'].includes(x)) throw new HttpError(400, 'Tipo di sessione non valido: twitch o manual');
  return x;
};

export function registerLeaderboardRoutes(app) {
  const r = app.router;
  const lb = () => app.leaderboard;
  const who = (ctx) => ctx.session?.username || null;

  const state = (ref = 'current', opts = {}) => {
    let view = null;
    let error = null;
    try { view = lb().view(ref, opts); } catch (e) { if (e.status === 409 || e.status === 404) error = e.message; else throw e; }
    return {
      view, error,
      display: lb().display(),
      current: lb().currentSession()?.id ?? null,
      snapshots: view ? lb().snapshots(view.session.id) : [],
      overlays: app.hub.counts().overlay,
    };
  };

  // --- Classifica di una sessione -----------------------------------------------------
  r.get('/api/admin/leaderboard', wrap((ctx) => {
    const player = ctx.query.get('player');
    return state(sessionRef(ctx.query.get('sessionId')), { player: player ? v.str(player, { max: 40, name: 'Giocatore' }) : null });
  }));

  r.get('/api/admin/leaderboard/sessions', wrap((ctx) => ({
    current: lb().currentSession()?.id ?? null,
    sessions: lb().listSessions({ kind: kindOf(ctx.query.get('kind')), limit: 100 }),
  })));

  // --- Overlay -----------------------------------------------------------------------
  r.post('/api/admin/leaderboard/show', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 4096);
    const screen = b.screen ?? 'board';
    if (!SCREENS.includes(screen)) throw new HttpError(400, 'Schermata non valida');
    if (b.board != null && !BOARDS.includes(b.board)) throw new HttpError(400, 'Classifica non valida');
    if (b.hofKind != null && !HOF_KINDS.includes(b.hofKind)) throw new HttpError(400, 'Filtro non valido');
    const display = lb().show({ sessionId: sessionRef(b.sessionId), screen, board: b.board ?? null, hofKind: b.hofKind ?? null, admin: who(ctx) });
    return { display, overlays: app.hub.counts().overlay };
  }));

  r.post('/api/admin/leaderboard/hide', wrap(async (ctx) => ({ display: lb().hide({ admin: who(ctx) }) })));

  r.post('/api/admin/leaderboard/winner', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 4096);
    const display = lb().show({ sessionId: sessionRef(b.sessionId), screen: 'winner', board: b.board ?? null, admin: who(ctx) });
    return { display, winner: lb().overlayPayload().winner ?? null };
  }));

  // Aggiorna: ricalcola e reinvia all'overlay (i risultati congelati non cambiano).
  r.post('/api/admin/leaderboard/refresh', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 4096);
    const ref = sessionRef(b.sessionId);
    lb().pushOverlay();
    return state(ref);
  }));

  // Anteprima: stessa schermata dell'overlay, senza pubblicarla.
  r.get('/api/admin/leaderboard/preview', wrap((ctx) => lb().preview({
    sessionId: sessionRef(ctx.query.get('sessionId')),
    screen: ctx.query.get('screen') || 'board',
    board: ctx.query.get('board') || 'points',
    hofKind: ctx.query.get('hofKind') || 'all',
  })));

  // --- Congelamento ------------------------------------------------------------------
  r.post('/api/admin/leaderboard/freeze', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 4096);
    const out = lb().freeze(sessionRef(b.sessionId), { admin: who(ctx) });
    return { ...out, ...state(out.sessionId) };
  }));

  r.post('/api/admin/leaderboard/unfreeze', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 4096);
    if (b.confirm !== true) throw new HttpError(400, 'Conferma esplicita richiesta per sbloccare i risultati');
    const out = lb().unfreeze(sessionRef(b.sessionId), { admin: who(ctx), reason: b.reason });
    return { ...out, ...state(out.sessionId) };
  }));

  // --- Hall of Fame ------------------------------------------------------------------
  r.get('/api/admin/leaderboard/halloffame', wrap((ctx) => {
    const kind = ctx.query.get('kind') || 'all';
    const limit = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.get('limit'))) || 25));
    return lb().hallOfFame({ kind, limit });
  }));

  // --- Riepiloghi ---------------------------------------------------------------------
  r.get('/api/admin/recaps', wrap((ctx) => ({ recaps: lb().listRecaps({ kind: kindOf(ctx.query.get('kind')), limit: 100 }) })));

  r.get('/api/admin/recaps/:sessionId', wrap((ctx) => lb().recap(lb().session(id(ctx.params.sessionId, 'Sessione')).id)));

  r.post('/api/admin/recaps/:sessionId/regenerate', wrap((ctx) => {
    const s = lb().session(id(ctx.params.sessionId, 'Sessione'));
    if (!s.ended_at) throw new HttpError(409, 'La sessione è ancora in corso: il riepilogo viene salvato alla chiusura');
    const data = lb().generateRecap(s.id, { by: who(ctx) || 'admin' });
    audit(app.db, { admin: who(ctx), action: 'recap_regenerate', targetType: 'session', targetId: s.id, detail: { source: data.leaderboardSource } }, app.log);
    return { ...data, stored: true };
  }));

  // --- Giocatori ----------------------------------------------------------------------
  r.get('/api/admin/players', wrap((ctx) => {
    const q = ctx.query.get('q') || '';
    const origin = ctx.query.get('origin') || null;
    if (origin && !['twitch', 'local'].includes(origin)) throw new HttpError(400, 'Origine non valida: twitch o local');
    return { players: lb().listPlayers({ q: v.str(q, { max: 40, name: 'Ricerca' }), origin, limit: 100 }) };
  }));

  r.get('/api/admin/players/:id', wrap((ctx) => lb().player(id(ctx.params.id, 'Giocatore'))));

  r.put('/api/admin/players/:id/name', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 4096);
    if (b.name !== null && typeof b.name !== 'string') throw new HttpError(400, 'Nome non valido (stringa, oppure null per tornare al nickname Twitch)');
    return lb().renamePlayer(id(ctx.params.id, 'Giocatore'), b.name, { admin: who(ctx) });
  }));

  // --- Regole e impostazioni ------------------------------------------------------------
  r.get('/api/admin/leaderboard/rules', wrap(() => ({ rules: lb().rules(), history: lb().ruleHistory(), commands: lb().commandSettings() })));

  r.put('/api/admin/leaderboard/rules', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 8192);
    const out = lb().setRules(b, { admin: who(ctx) });
    return { ...out, history: lb().ruleHistory() };
  }));

  r.put('/api/admin/leaderboard/commands', wrap(async (ctx) => {
    const b = await readJson(ctx.req, 8192);
    return { commands: lb().setCommandSettings(b, { admin: who(ctx) }) };
  }));
}
