// API del controllo del motore di gioco: modalità AUTOMATICA (diretta Twitch)
// e MANUALE (sessione avviata dalla dashboard senza Twitch, dati reali).
// Tutte le rotte richiedono sessione admin; le scritture anche il token CSRF.
import { HttpError, readJson, v } from '../http/router.js';
import { STATES } from '../game_engine/stateMachine.js';
import { randomToken } from '../security/crypto.js';

const id = (x, name = 'ID') => v.num(x, { min: 1, int: true, name });

// Funzioni che richiedono Twitch e che nella sessione manuale non sono disponibili.
export const TWITCH_ONLY = [
  'Riscatti reali dei punti canale (le Poké Ball si lanciano dalla dashboard)',
  'Rimborso dei punti e aggiornamento dei riscatti su Twitch',
  'Risposte del bot nella chat di Twitch (i comandi si provano dalla dashboard, senza invio)',
  'Stato LIVE del canale: resta OFFLINE, la sessione è marcata MANUALE',
];

export function registerGameRoutes(app) {
  const r = app.router;
  const db = () => app.db;

  const state = () => {
    const st = app.engine.status();
    const lifecycle = app.sm.snapshot();
    const live = [STATES.LIVE, STATES.PAUSED].includes(lifecycle.state);
    return {
      control: st.mode === 'manual' ? 'MANUAL' : 'AUTOMATIC',
      lifecycle,
      engine: st,
      canStartManual: !st.mode && !live && !app.monitor.channelLive(),
      blockedReason: live ? 'Il canale è in diretta: il gioco è gestito automaticamente da Twitch'
        : app.monitor.channelLive() ? 'Twitch indica che il canale è in diretta: attendi la connessione'
          : st.mode === 'demo' ? 'Modalità DEMO attiva: fermala prima'
            : st.mode === 'manual' ? 'Sessione manuale già attiva' : null,
      twitchOnly: TWITCH_ONLY,
      balls: db().all('SELECT id, code, name, color, multiplier, guaranteed FROM ball_types WHERE enabled = 1 ORDER BY sort_order, id'),
      recentPlayers: db().all(
        `SELECT id, login, display_name, origin FROM twitch_users WHERE is_demo = 0 ORDER BY last_seen_at DESC LIMIT 30`),
    };
  };

  r.get('/api/admin/game', () => state());

  r.post('/api/admin/game/manual/start', (ctx) => {
    if ([STATES.LIVE, STATES.PAUSED].includes(app.sm.state)) throw new HttpError(409, 'Il canale è in diretta: il gioco è già gestito da Twitch');
    if (app.monitor.channelLive()) throw new HttpError(409, 'Twitch indica che il canale è in diretta: la sessione manuale non può partire');
    try {
      app.engine.startManual({ admin: ctx.session?.username || null });
    } catch (e) {
      throw new HttpError(409, e.message);
    }
    return state();
  });

  r.post('/api/admin/game/manual/stop', (ctx) => {
    if (app.engine.mode !== 'manual') throw new HttpError(409, 'Nessuna sessione manuale attiva');
    const closed = app.engine.stopManual('manual_stopped', { admin: ctx.session?.username || null });
    return { ...state(), closed };
  });

  r.post('/api/admin/game/notice/dismiss', () => {
    app.engine.notice = null;
    app.engine.emitStatus();
    return { ok: true };
  });

  // Lancio di una Poké Ball durante la sessione manuale: passa dal vero motore
  // (probabilità, limiti, vincitore singolo, Pokédex, statistiche, overlay).
  // Giocatore: uno spettatore già noto (userId) oppure un giocatore locale (name),
  // che resta distinto dagli account Twitch.
  r.post('/api/admin/game/manual/throw', async (ctx) => {
    if (app.engine.mode !== 'manual') throw new HttpError(409, 'Avvia prima una sessione manuale');
    const b = await readJson(ctx.req);
    let user;
    if (b.userId) {
      const u = db().get('SELECT * FROM twitch_users WHERE id = ? AND is_demo = 0', id(b.userId, 'Giocatore'));
      if (!u) throw new HttpError(404, 'Giocatore non trovato');
      user = { twitchId: u.twitch_id, login: u.login, displayName: u.display_name };
    } else {
      const name = v.str(b.name || 'Giocatore_Locale', { min: 1, max: 25, pattern: /^[A-Za-z0-9_]+$/, name: 'Nome giocatore' });
      user = { twitchId: `local:${name.toLowerCase()}`, login: name.toLowerCase(), displayName: name, origin: 'local' };
    }
    const res = app.engine.attempt({
      redemptionId: `manual-${randomToken(9)}`,
      ballTypeId: id(b.ballTypeId, 'Poké Ball'),
      user,
      redeemedAt: new Date().toISOString(),
      isDemo: false,
      source: 'manual',
    });
    return {
      rejected: !!res.rejected, reason: res.reason || null, caught: !!res.caught,
      probability: res.probability ?? null, fled: res.spawnEnded === 'fled', pokemon: res.pokemon || null,
      user: res.user ? { id: res.user.id, displayName: res.user.display_name, origin: res.user.origin } : null,
    };
  });
}
