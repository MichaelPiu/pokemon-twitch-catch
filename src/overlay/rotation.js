// Overlay rotante: nella stessa Browser Source /overlay si alternano automaticamente
// alcune schermate (classifica, ultime catture, shiny, obiettivi, statistiche, evento).
//
// - La rotazione la decide il server, con un solo timer: tutte le sorgenti OBS
//   collegate mostrano la stessa schermata, una riconnessione riceve lo stato
//   attuale nello snapshot e un riavvio riparte dalla prima schermata. Il client
//   non ha timer di rotazione: niente timer duplicati né aggiornamenti in conflitto.
// - Una schermata senza dati viene saltata; se nessuna ha dati il pannello sparisce.
// - Il cambio schermata viaggia solo sul canale "overlay": il canale "audio" non
//   viene toccato, quindi un suono in corso non si interrompe e non si ripete.
// - Quando parte un evento automatico (o si raggiunge un obiettivo) la sua
//   schermata viene mostrata subito, poi la rotazione riprende.
import { HttpError } from '../http/router.js';
import { imageUrl } from '../spawn/spawn.js';
import { RARITY_LABELS } from '../configuration/defaults.js';
import { PERIODS } from '../community/stats.js';

export const ROTATION_SCREENS = {
  leaderboard: 'Classifica',
  captures: 'Ultime catture',
  shiny: 'Shiny',
  goals: 'Obiettivi',
  stats: 'Statistiche Community',
  event: 'Evento attivo',
};
export const TRANSITIONS = { fade: 'Dissolvenza', slide: 'Scorrimento', zoom: 'Zoom', none: 'Nessuna' };
export const ROTATION_POSITIONS = { left: 'A sinistra', right: 'A destra', bottom: 'In basso' };
export const ROTATION_LIMITS = { durationS: [3, 3600], minS: [3, 600], maxS: [5, 3600], capturesCount: [5, 10] };

export const ROTATION_DEFAULTS = {
  enabled: false,
  transition: 'fade',
  position: 'left',
  minS: 8, // nessuna schermata resta meno di così…
  maxS: 60, // …o più di così (la durata di ogni schermata viene limitata a questo intervallo)
  eventPriority: true, // evento appena iniziato o obiettivo raggiunto: la sua schermata subito
  capturesCount: 8,
  statsPeriod: 'session',
  lock: null, // schermata bloccata manualmente (null = rotazione)
  screens: [
    { key: 'leaderboard', enabled: true, durationS: 15 },
    { key: 'captures', enabled: true, durationS: 12 },
    { key: 'shiny', enabled: true, durationS: 10 },
    { key: 'goals', enabled: true, durationS: 12 },
    { key: 'stats', enabled: true, durationS: 12 },
    { key: 'event', enabled: true, durationS: 15 },
  ],
};

const SPECIAL = new Set(['rare', 'epic', 'legendary', 'mythical']);
const nameSql = 'COALESCE(u.custom_name, u.display_name)';
const pcols = 'p.dex_number, p.name AS pname, p.name_it AS pname_it, p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url';
const captureView = (r) => ({
  id: r.id, user: r.player, at: r.caught_at, pokemonId: r.pokemon_id, name: r.pname_it || r.pname, dex: r.dex_number,
  rarity: r.rarity, rarityLabel: RARITY_LABELS[r.rarity] || r.rarity, shiny: !!r.is_shiny, special: !!r.is_shiny || SPECIAL.has(r.rarity),
  image: imageUrl({ image_file: r.image_file, shiny_image_file: r.shiny_image_file, image_url: r.image_url, shiny_image_url: r.shiny_image_url }, !!r.is_shiny),
});

export class RotationService {
  constructor({ db, settings, hub, leaderboard, stats, events, log, timers = true, now = () => Date.now() }) {
    this.db = db;
    this.store = settings; // SettingsStore overlay_settings, chiave "rotation"
    this.hub = hub;
    this.leaderboard = leaderboard;
    this.stats = stats;
    this.events = events;
    this.log = log;
    this.timers = timers;
    this.now = now;
    this.timer = null;
    this.refreshTimer = null;
    this.current = null; // { key, index, startedAt, endsAt, data }
    this.rev = 0;
    this.lastPayload = { visible: false, rev: 0 };
  }

  // --- Impostazioni -----------------------------------------------------------------
  settings() {
    const s = this.store.get('rotation') || {};
    const d = ROTATION_DEFAULTS;
    const saved = Array.isArray(s.screens) ? s.screens.filter((x) => ROTATION_SCREENS[x?.key]) : [];
    // Ordine salvato + eventuali schermate nuove in coda (aggiornamenti futuri).
    const screens = [...saved.map((x) => ({ ...d.screens.find((y) => y.key === x.key), ...x })),
      ...d.screens.filter((x) => !saved.some((y) => y.key === x.key)).map((x) => ({ ...x }))];
    return { ...structuredClone(d), ...s, screens, lock: s.lock && ROTATION_SCREENS[s.lock] ? s.lock : null };
  }

  setSettings(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Richiesta non valida');
    const next = this.settings();
    const bool = (v, k) => { if (typeof v !== 'boolean') throw new HttpError(400, `Valore non valido: ${k}`); return v; };
    const int = (v, k, [min, max]) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${k}: valore intero tra ${min} e ${max}`); return n; };
    const L = ROTATION_LIMITS;
    if (input.enabled !== undefined) next.enabled = bool(input.enabled, 'enabled');
    if (input.eventPriority !== undefined) next.eventPriority = bool(input.eventPriority, 'eventPriority');
    if (input.transition !== undefined) { if (!TRANSITIONS[input.transition]) throw new HttpError(400, 'Transizione non valida'); next.transition = input.transition; }
    if (input.position !== undefined) { if (!ROTATION_POSITIONS[input.position]) throw new HttpError(400, 'Posizione non valida'); next.position = input.position; }
    if (input.statsPeriod !== undefined) { if (!PERIODS[input.statsPeriod]) throw new HttpError(400, 'Periodo non valido'); next.statsPeriod = input.statsPeriod; }
    if (input.minS !== undefined) next.minS = int(input.minS, 'Durata minima (s)', L.minS);
    if (input.maxS !== undefined) next.maxS = int(input.maxS, 'Durata massima (s)', L.maxS);
    if (next.maxS < next.minS) throw new HttpError(400, 'La durata massima deve essere almeno uguale a quella minima');
    if (input.capturesCount !== undefined) next.capturesCount = int(input.capturesCount, 'Catture mostrate', L.capturesCount);
    if (input.lock !== undefined) {
      if (input.lock !== null && !ROTATION_SCREENS[input.lock]) throw new HttpError(400, 'Schermata non valida');
      next.lock = input.lock;
    }
    if (input.screens !== undefined) {
      if (!Array.isArray(input.screens)) throw new HttpError(400, 'Elenco delle schermate non valido');
      const seen = new Set();
      const list = input.screens.map((x, i) => {
        if (!x || !ROTATION_SCREENS[x.key] || seen.has(x.key)) throw new HttpError(400, `Schermata ${i + 1} non valida`);
        seen.add(x.key);
        return { key: x.key, enabled: x.enabled === undefined ? true : bool(x.enabled, ROTATION_SCREENS[x.key]), durationS: int(x.durationS, `${ROTATION_SCREENS[x.key]}: durata`, L.durationS) };
      });
      for (const d of ROTATION_DEFAULTS.screens) if (!seen.has(d.key)) list.push({ ...d, enabled: false });
      next.screens = list;
    }
    this.store.set('rotation', next);
    this.restart();
    return next;
  }

  setLock(key) { return this.setSettings({ lock: key ?? null }); }

  durationOf(s, key) {
    const sc = s.screens.find((x) => x.key === key);
    return Math.min(s.maxS, Math.max(s.minS, sc?.durationS || s.minS));
  }

  // --- Dati delle schermate --------------------------------------------------------------
  // null = nessun dato: la schermata viene saltata.
  data(key, s = this.settings()) {
    try {
      switch (key) {
        case 'leaderboard': return this.leaderboardData();
        case 'captures': return this.capturesData(s.capturesCount);
        case 'shiny': return this.shinyData();
        case 'goals': return this.goalsData();
        case 'stats': return this.statsData(s.statsPeriod);
        case 'event': return this.eventData();
        default: return null;
      }
    } catch (e) {
      this.log?.warn('Schermata dell\'overlay rotante non disponibile', { screen: key, message: e.message });
      return null;
    }
  }

  // Sessione di riferimento: quella in corso, altrimenti l'ultima con catture.
  session() {
    const cur = this.leaderboard.currentSession?.();
    if (cur) return cur;
    return this.db.get("SELECT * FROM stream_sessions WHERE is_demo = 0 AND kind IN ('twitch','manual') AND captures > 0 ORDER BY started_at DESC, id DESC LIMIT 1") || null;
  }

  leaderboardData() {
    const s = this.session();
    if (!s) return null;
    const v = this.leaderboard.view(s, { limit: 10 });
    if (!v.points.length) return null;
    return {
      session: { id: s.id, kind: s.kind, open: !s.ended_at, startedAt: s.started_at },
      rows: v.points.slice(0, 10).map((r) => ({ userId: r.userId, rank: r.rank, name: r.name, points: r.points, captures: r.captures, shiny: r.shiny })),
      totals: v.totals,
    };
  }

  capturesData(limit = 8) {
    const rows = this.db.all(
      `SELECT e.id, e.pokemon_id, e.is_shiny, e.rarity, e.caught_at, ${nameSql} AS player, ${pcols}
       FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id JOIN twitch_users u ON u.id = e.user_id
       WHERE e.voided_at IS NULL ORDER BY e.caught_at DESC, e.id DESC LIMIT ?`, limit);
    return rows.length ? { items: rows.map(captureView) } : null;
  }

  shinyData() {
    const rows = this.db.all(
      `SELECT e.id, e.pokemon_id, e.is_shiny, e.rarity, e.caught_at, ${nameSql} AS player, ${pcols}
       FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id JOIN twitch_users u ON u.id = e.user_id
       WHERE e.voided_at IS NULL AND e.is_shiny = 1 ORDER BY e.caught_at DESC, e.id DESC LIMIT 6`);
    if (!rows.length) return null;
    const s = this.leaderboard.currentSession?.();
    const sessionCount = s ? this.db.get('SELECT COUNT(*) AS n FROM leaderboard_events WHERE session_id = ? AND voided_at IS NULL AND is_shiny = 1', s.id).n : null;
    const total = this.db.get('SELECT COUNT(*) AS n FROM leaderboard_events WHERE voided_at IS NULL AND is_shiny = 1').n;
    return { items: rows.map(captureView), sessionCount, total };
  }

  goalsData() {
    const ev = this.events?.overlayPayload();
    if (!ev?.enabled) return null;
    const community = ev.community?.active ? ev.community : null;
    const potd = ev.pokemonOfDay || null;
    if (!community && !potd) return null;
    return { community, pokemonOfDay: potd, active: ev.active || null };
  }

  statsData(period) {
    const st = this.stats.overlay(period);
    return st.empty ? null : st;
  }

  eventData() {
    const ev = this.events?.overlayPayload();
    if (!ev?.enabled || !ev.active || ev.active.paused) return null;
    return { active: ev.active, community: ev.community?.active ? ev.community : null };
  }

  // --- Rotazione -----------------------------------------------------------------------
  start() { this.advance({ reason: 'start' }); }

  restart() {
    this.current = null;
    this.advance({ reason: 'settings' });
  }

  stop() {
    clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.refreshTimer); this.refreshTimer = null;
  }

  arm(ms) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.timers) return;
    this.timer = setTimeout(() => { this.timer = null; this.advance({ reason: 'timer' }); }, ms);
    this.timer.unref?.();
  }

  // Passa alla schermata successiva con dati (o a quella indicata).
  advance({ reason = 'timer', to = null } = {}) {
    if (!this.db?.db) return this.lastPayload;
    const s = this.settings();
    if (!s.enabled) { this.stop(); this.current = null; return this.publish({ visible: false }); }
    const enabled = s.screens.filter((x) => x.enabled);
    let pick = null;
    if (s.lock) {
      const data = this.data(s.lock, s);
      if (data) pick = { key: s.lock, data };
    } else if (to) {
      const data = this.data(to, s);
      if (data) pick = { key: to, data };
    }
    if (!pick && !s.lock) {
      const start = this.current ? enabled.findIndex((x) => x.key === this.current.key) : -1;
      for (let i = 1; i <= enabled.length; i++) {
        const sc = enabled[(start + i + enabled.length) % enabled.length];
        if (!sc) break;
        const data = this.data(sc.key, s);
        if (data) { pick = { key: sc.key, data }; break; }
      }
    }
    if (!pick) {
      this.current = null;
      // Nessuna schermata con dati: si riprova più tardi (nuove catture, eventi).
      this.arm(s.minS * 1000);
      return this.publish({ visible: false, locked: s.lock, reason });
    }
    const t = this.now();
    const dur = this.durationOf(s, pick.key);
    this.current = { key: pick.key, startedAt: t, endsAt: s.lock ? null : t + dur * 1000 };
    if (!s.lock) this.arm(dur * 1000);
    else this.arm(s.maxS * 1000); // schermata bloccata: solo aggiornamento periodico dei dati
    return this.publish({ visible: true, screen: pick.key, data: pick.data, durationS: s.lock ? null : dur, transition: s.transition, enter: true, reason });
  }

  // Dati cambiati (cattura, evento): si ridisegna la schermata corrente senza
  // cambiarla; se non ha più dati si passa alla successiva.
  refresh() {
    if (!this.current || !this.db?.db) return this.lastPayload;
    const s = this.settings();
    if (!s.enabled) return this.advance();
    const data = this.data(this.current.key, s);
    if (!data) return this.advance({ reason: 'empty' });
    return this.publish({
      visible: true, screen: this.current.key, data, durationS: this.current.endsAt ? Math.round((this.current.endsAt - this.current.startedAt) / 1000) : null,
      transition: s.transition, enter: false, reason: 'refresh',
    });
  }

  scheduleRefresh() {
    if (!this.current) {
      // Pannello nascosto per mancanza di dati: magari ora ce ne sono.
      if (this.settings().enabled) this.advance({ reason: 'data' });
      return;
    }
    if (!this.timers) { this.refresh(); return; }
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh(); }, 500);
    this.refreshTimer.unref?.();
  }

  // Evento appena iniziato / obiettivo raggiunto: la sua schermata subito.
  onEvents(info = {}) {
    const s = this.settings();
    if (!s.enabled) return;
    if (s.eventPriority && !s.lock) {
      const want = info.kind === 'start' ? 'event' : info.kind === 'community_complete' ? 'goals' : null;
      if (want && s.screens.some((x) => x.key === want && x.enabled)) { this.advance({ to: want, reason: 'event' }); return; }
    }
    if (this.current && ['event', 'goals'].includes(this.current.key)) this.scheduleRefresh();
    else if (!this.current) this.advance({ reason: 'data' });
  }

  publish(p) {
    const s = this.settings();
    this.rev += 1;
    const t = this.now();
    const payload = {
      visible: !!p.visible, rev: this.rev, screen: p.screen || null, label: p.screen ? ROTATION_SCREENS[p.screen] : null,
      data: p.data || null, transition: p.transition || s.transition, position: s.position, durationS: p.durationS ?? null,
      startedAt: this.current ? new Date(this.current.startedAt).toISOString() : null,
      endsAt: this.current?.endsAt ? new Date(this.current.endsAt).toISOString() : null,
      locked: s.lock, enter: !!p.enter, serverTime: new Date(t).toISOString(),
    };
    this.lastPayload = payload;
    this.hub?.overlay('rotation', payload);
    this.hub?.admin('rotation', { screen: payload.screen, visible: payload.visible, locked: payload.locked, endsAt: payload.endsAt });
    return payload;
  }

  // Snapshot per una nuova connessione: stato attuale, senza animazione d'ingresso.
  payload() {
    if (!this.settings().enabled) return { visible: false, rev: this.rev };
    return { ...this.lastPayload, enter: false };
  }

  // Anteprima di una schermata per la dashboard (nessun invio agli overlay).
  preview(key) {
    if (!ROTATION_SCREENS[key]) throw new HttpError(400, 'Schermata non valida');
    const s = this.settings();
    const data = this.data(key, s);
    return { visible: !!data, rev: 0, screen: key, label: ROTATION_SCREENS[key], data, transition: s.transition, position: s.position, durationS: this.durationOf(s, key), preview: true, empty: !data, enter: true };
  }

  view() {
    const s = this.settings();
    return {
      settings: s, screens: ROTATION_SCREENS, transitions: TRANSITIONS, positions: ROTATION_POSITIONS, periods: PERIODS, limits: ROTATION_LIMITS,
      current: this.lastPayload.visible ? { screen: this.lastPayload.screen, endsAt: this.lastPayload.endsAt, locked: s.lock } : null,
      available: Object.fromEntries(Object.keys(ROTATION_SCREENS).map((k) => [k, !!this.data(k, s)])),
      overlays: this.hub?.counts?.().overlay ?? 0,
    };
  }
}
