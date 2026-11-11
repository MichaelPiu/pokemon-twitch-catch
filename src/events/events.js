// Eventi automatici durante le dirette: Evento Leggendario, Bonus Shiny,
// Pokémon del giorno ed Evento Community.
//
// Regole di sicurezza:
// - Tutto è spento per impostazione predefinita; nessun evento parte senza che
//   l'amministratore abbia attivato gli eventi e il singolo evento (o lo avvii a mano).
// - I bonus non toccano mai le impostazioni salvate del gioco né la probabilità di
//   cattura: valgono solo per la SCELTA del Pokémon che appare (rarità e shiny),
//   vengono letti dal motore a ogni spawn (spawnModifier) e smettono di valere nel
//   momento stesso in cui l'evento termina o viene sospeso. Non c'è nulla da
//   "ripristinare": le probabilità salvate non sono mai state modificate.
// - Un solo evento con bonus alla volta (Leggendario e Shiny non si sovrappongono);
//   Pokémon del giorno ed Evento Community sono compatibili con tutto.
// - Twitch offline / gioco fermo: l'evento attivo termina o viene sospeso secondo la
//   regola scelta; in entrambi i casi nessun bonus resta attivo. Nessun annuncio
//   arretrato: gli annunci passano dai Messaggi Twitch (stesso antispam, mai accodati).
// - Ogni avvio e fine viene registrato nello storico (impostazioni dell'app, quindi
//   anche nei backup) e nel registro operazioni.
import { EventEmitter } from 'node:events';
import { HttpError } from '../http/router.js';
import { audit } from '../audit.js';
import { imageUrl } from '../spawn/spawn.js';
import { RARITY_LABELS } from '../configuration/defaults.js';

export const EVENT_TYPES = {
  legendary: { label: 'Evento Leggendario', bonus: true },
  shiny: { label: 'Bonus Shiny', bonus: true },
  pokemon_of_day: { label: 'Pokémon del giorno', bonus: false },
  community: { label: 'Evento Community', bonus: false },
};
export const DAYS = [1, 2, 3, 4, 5, 6, 0]; // lunedì … domenica (getDay di JavaScript)
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const anyTime = () => ({ days: [...ALL_DAYS], from: '00:00', to: '23:59' });

export const EVENT_LIMITS = {
  durationMin: [1, 120], everyMinutes: [5, 1440], everyCaptures: [3, 1000],
  legendaryBoost: [1, 10], shinyMultiplier: [1, 20], goal: [1, 100000], rewardMax: 120, historyMax: 100,
};

export const AUTO_EVENT_DEFAULTS = {
  enabled: false, // interruttore generale
  manualMode: false, // eventi anche nelle sessioni manuali della dashboard
  offlineRule: 'end', // Twitch offline o gioco fermo: 'end' (termina) o 'pause' (sospende, riprende dopo)
  legendary: { enabled: false, trigger: 'time', everyMinutes: 45, everyCaptures: 30, durationMin: 5, legendaryBoost: 3, schedule: anyTime() },
  shiny: { enabled: false, auto: false, everyMinutes: 60, durationMin: 5, shinyMultiplier: 3, schedule: anyTime() },
  pokemonOfDay: { enabled: false, mode: 'auto', pokemonId: null, announce: true },
  community: { enabled: false, goal: 50, reward: 'Premio sbloccato: grazie a tutti!', unlock: 'none', autoRestart: false },
};

const err = (status, message) => new HttpError(status, message);
const clone = (v) => structuredClone(v);
const pad = (n) => String(n).padStart(2, '0');
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localMidnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const minutesOfDay = (ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
const hhmm = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(String(s)); if (!m || +m[1] > 23 || +m[2] > 59) return null; return +m[1] * 60 + +m[2]; };
const durText = (min) => (min === 1 ? '1 minuto' : `${min} minuti`);
// FNV-1a: scelta del Pokémon del giorno ripetibile e verificabile (stessa data → stesso Pokémon).
const fnv = (s) => { let h = 0x811c9dc5; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };

export class AutoEventsService extends EventEmitter {
  constructor({ db, settings, engine, hub, chatMessages = null, log, timers = true, now = () => Date.now() }) {
    super();
    this.db = db;
    this.store = settings; // SettingsStore admin_settings: "autoEvents" (configurazione) e "autoEventsState" (stato e storico)
    this.engine = engine;
    this.hub = hub;
    this.chatMessages = chatMessages;
    this.log = log;
    this.timers = timers;
    this.now = now;
    this.interval = null;
    this.ticking = false;
  }

  start() {
    if (!this.timers || this.interval) return;
    this.interval = setInterval(() => this.tick(), 5000);
    this.interval.unref?.();
  }

  close() { clearInterval(this.interval); this.interval = null; }

  // --- Configurazione ------------------------------------------------------------
  settings() {
    const s = this.store.get('autoEvents') || {};
    const d = AUTO_EVENT_DEFAULTS;
    const merge = (k) => ({ ...clone(d[k]), ...(s[k] || {}) });
    return {
      enabled: s.enabled ?? d.enabled, manualMode: s.manualMode ?? d.manualMode, offlineRule: s.offlineRule ?? d.offlineRule,
      legendary: { ...merge('legendary'), schedule: { ...anyTime(), ...(s.legendary?.schedule || {}) } },
      shiny: { ...merge('shiny'), schedule: { ...anyTime(), ...(s.shiny?.schedule || {}) } },
      pokemonOfDay: merge('pokemonOfDay'),
      community: merge('community'),
    };
  }

  setSettings(input = {}, { admin = null } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw err(400, 'Richiesta non valida');
    const cur = this.settings();
    const next = clone(cur);
    const bool = (v, k) => { if (typeof v !== 'boolean') throw err(400, `Valore non valido: ${k}`); return v; };
    const int = (v, k, [min, max]) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw err(400, `${k}: valore intero tra ${min} e ${max}`); return n; };
    const num = (v, k, [min, max]) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw err(400, `${k}: valore tra ${min} e ${max}`); return Math.round(n * 100) / 100; };
    const oneOf = (v, k, list) => { if (!list.includes(v)) throw err(400, `Valore non valido: ${k}`); return v; };
    const schedule = (v, k) => {
      if (!v || typeof v !== 'object') throw err(400, `${k}: programmazione non valida`);
      const days = Array.isArray(v.days) ? [...new Set(v.days.map(Number))] : null;
      if (!days || days.some((x) => !ALL_DAYS.includes(x))) throw err(400, `${k}: giorni non validi`);
      if (hhmm(v.from) == null || hhmm(v.to) == null) throw err(400, `${k}: orario non valido (HH:MM)`);
      return { days: days.sort(), from: v.from, to: v.to };
    };
    const L = EVENT_LIMITS;
    if (input.enabled !== undefined) next.enabled = bool(input.enabled, 'enabled');
    if (input.manualMode !== undefined) next.manualMode = bool(input.manualMode, 'manualMode');
    if (input.offlineRule !== undefined) next.offlineRule = oneOf(input.offlineRule, 'Regola offline', ['end', 'pause']);
    const g = input.legendary;
    if (g !== undefined) {
      if (!g || typeof g !== 'object') throw err(400, 'Evento Leggendario non valido');
      const e = next.legendary;
      if (g.enabled !== undefined) e.enabled = bool(g.enabled, 'Evento Leggendario');
      if (g.trigger !== undefined) e.trigger = oneOf(g.trigger, 'Attivazione', ['time', 'captures']);
      if (g.everyMinutes !== undefined) e.everyMinutes = int(g.everyMinutes, 'Ogni quanti minuti', L.everyMinutes);
      if (g.everyCaptures !== undefined) e.everyCaptures = int(g.everyCaptures, 'Ogni quante catture', L.everyCaptures);
      if (g.durationMin !== undefined) e.durationMin = int(g.durationMin, 'Durata (minuti)', L.durationMin);
      if (g.legendaryBoost !== undefined) e.legendaryBoost = num(g.legendaryBoost, 'Moltiplicatore Leggendari', L.legendaryBoost);
      if (g.schedule !== undefined) e.schedule = schedule(g.schedule, 'Evento Leggendario');
    }
    const sh = input.shiny;
    if (sh !== undefined) {
      if (!sh || typeof sh !== 'object') throw err(400, 'Bonus Shiny non valido');
      const e = next.shiny;
      if (sh.enabled !== undefined) e.enabled = bool(sh.enabled, 'Bonus Shiny');
      if (sh.auto !== undefined) e.auto = bool(sh.auto, 'Avvio programmato');
      if (sh.everyMinutes !== undefined) e.everyMinutes = int(sh.everyMinutes, 'Ogni quanti minuti', L.everyMinutes);
      if (sh.durationMin !== undefined) e.durationMin = int(sh.durationMin, 'Durata (minuti)', L.durationMin);
      if (sh.shinyMultiplier !== undefined) e.shinyMultiplier = num(sh.shinyMultiplier, 'Moltiplicatore shiny', L.shinyMultiplier);
      if (sh.schedule !== undefined) e.schedule = schedule(sh.schedule, 'Bonus Shiny');
    }
    const pd = input.pokemonOfDay;
    if (pd !== undefined) {
      if (!pd || typeof pd !== 'object') throw err(400, 'Pokémon del giorno non valido');
      const e = next.pokemonOfDay;
      if (pd.enabled !== undefined) e.enabled = bool(pd.enabled, 'Pokémon del giorno');
      if (pd.announce !== undefined) e.announce = bool(pd.announce, 'Annuncio');
      if (pd.mode !== undefined) e.mode = oneOf(pd.mode, 'Scelta', ['auto', 'fixed']);
      if (pd.pokemonId !== undefined) {
        if (pd.pokemonId === null || pd.pokemonId === '') e.pokemonId = null;
        else {
          const id = Number(pd.pokemonId);
          if (!Number.isInteger(id) || !this.db.get('SELECT id FROM pokemon WHERE id = ?', id)) throw err(400, 'Pokémon non trovato');
          e.pokemonId = id;
        }
      }
      if (e.mode === 'fixed' && !e.pokemonId) throw err(400, 'Scegli il Pokémon del giorno o usa la scelta automatica');
    }
    const cm = input.community;
    if (cm !== undefined) {
      if (!cm || typeof cm !== 'object') throw err(400, 'Evento Community non valido');
      const e = next.community;
      if (cm.enabled !== undefined) e.enabled = bool(cm.enabled, 'Evento Community');
      if (cm.goal !== undefined) e.goal = int(cm.goal, 'Obiettivo (catture)', L.goal);
      if (cm.reward !== undefined) {
        const r = String(cm.reward ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
        if (r.length > L.rewardMax) throw err(400, `Premio: massimo ${L.rewardMax} caratteri`);
        e.reward = r;
      }
      if (cm.unlock !== undefined) e.unlock = oneOf(cm.unlock, 'Premio', ['none', 'legendary', 'shiny']);
      if (cm.autoRestart !== undefined) e.autoRestart = bool(cm.autoRestart, 'Nuovo obiettivo automatico');
    }
    this.store.set('autoEvents', next);
    // Prima attivazione dell'Evento Community: l'obiettivo parte adesso (le catture precedenti non contano).
    if (next.enabled && next.community.enabled && !this.state().community) this.newCommunityGoal({ admin, announce: false });
    if (JSON.stringify(cur) !== JSON.stringify(next)) {
      audit(this.db, { admin, action: 'auto_events_settings', targetType: 'auto_events', detail: { enabled: next.enabled, legendary: next.legendary.enabled, shiny: next.shiny.enabled, pokemonOfDay: next.pokemonOfDay.enabled, community: next.community.enabled } }, this.log);
    }
    setImmediate(() => this.tick());
    return next;
  }

  // --- Stato persistente -----------------------------------------------------------
  state() {
    const s = this.store.get('autoEventsState') || {};
    return { seq: s.seq || 0, active: s.active || null, last: s.last || {}, community: s.community || null, potd: s.potd || null, history: Array.isArray(s.history) ? s.history : [] };
  }

  save(st) {
    if (st.history.length > EVENT_LIMITS.historyMax) st.history.length = EVENT_LIMITS.historyMax;
    this.store.set('autoEventsState', st);
  }

  // Il gioco è in condizione di avere eventi? (diretta, o sessione manuale se consentito; mai DEMO)
  gameAllows(s = this.settings()) {
    const e = this.engine;
    if (!e.running || !e.session) return false;
    if (e.mode === 'live') return true;
    return e.mode === 'manual' && s.manualMode;
  }

  inSchedule(sc, ms = this.now()) {
    const d = new Date(ms).getDay();
    if (!sc.days.includes(d)) return false;
    const m = minutesOfDay(ms);
    const from = hhmm(sc.from);
    const to = hhmm(sc.to);
    return from <= to ? m >= from && m <= to : m >= from || m <= to; // fascia anche a cavallo della mezzanotte
  }

  // Bonus attivo per lo spawn: letto dal motore a ogni scelta del Pokémon.
  spawnModifier() {
    try {
      const st = this.state();
      const a = st.active;
      if (!a || a.pausedAt || this.now() >= a.endsAt) return null;
      const s = this.settings();
      if (!s.enabled || !this.gameAllows(s)) return null;
      if (a.type === 'legendary') return { source: a.id, rarityBoost: { legendary: a.bonus.legendaryBoost, mythical: a.bonus.legendaryBoost } };
      if (a.type === 'shiny') return { source: a.id, shinyMultiplier: a.bonus.shinyMultiplier };
      return null;
    } catch (e) {
      this.log?.warn('Bonus evento non leggibile: spawn senza bonus', { message: e.message });
      return null;
    }
  }

  // --- Avvio e fine degli eventi con bonus ----------------------------------------------
  startEvent(type, { by = 'auto', admin = null, durationMin = null, reason = null } = {}) {
    if (!EVENT_TYPES[type]?.bonus) throw err(400, 'Evento non valido');
    const s = this.settings();
    if (!s.enabled) throw err(409, 'Gli eventi automatici sono disattivati: attivali prima');
    if (!s[type].enabled) throw err(409, `${EVENT_TYPES[type].label} è disattivato nelle impostazioni`);
    if (!this.gameAllows(s)) {
      throw err(409, this.engine.mode === 'manual' ? 'Eventi non consentiti nelle sessioni manuali (vedi impostazioni)' : 'Il gioco non è attivo: serve una diretta (o una sessione manuale, se consentito)');
    }
    const st = this.state();
    if (st.active) throw err(409, `C'è già un evento attivo (${EVENT_TYPES[st.active.type].label}): terminalo prima di avviarne un altro`);
    const minutes = durationMin == null ? s[type].durationMin : Number(durationMin);
    if (!Number.isInteger(minutes) || minutes < EVENT_LIMITS.durationMin[0] || minutes > EVENT_LIMITS.durationMin[1]) throw err(400, `Durata: tra ${EVENT_LIMITS.durationMin[0]} e ${EVENT_LIMITS.durationMin[1]} minuti`);
    const t = this.now();
    const bonus = type === 'legendary' ? { legendaryBoost: s.legendary.legendaryBoost } : { shinyMultiplier: s.shiny.shinyMultiplier };
    st.seq += 1;
    const a = {
      id: st.seq, type, label: EVENT_TYPES[type].label, by: admin ? `admin:${admin}` : by, reason, bonus, durationMin: minutes,
      startedAt: new Date(t).toISOString(), endsAt: t + minutes * 60000, pausedAt: null, remainingMs: null, pausedMs: 0,
      sessionId: this.engine.session?.id ?? null, sessionKind: this.engine.session?.kind ?? null,
    };
    st.active = a;
    st.last[type] = { startedAt: a.startedAt, endedAt: null, captureMark: this.captureCount() };
    this.save(st);
    audit(this.db, { admin, action: 'auto_event_start', targetType: 'auto_event', targetId: a.id, detail: { type, by: a.by, durationMin: minutes, bonus, sessionId: a.sessionId } }, this.log);
    this.log?.info(`${a.label} avviato (${durText(minutes)}, ${type === 'legendary' ? `Leggendari ×${bonus.legendaryBoost}` : `shiny ×${bonus.shinyMultiplier}`})`);
    this.announce(type === 'legendary' ? 'event_legendary_start' : 'event_shiny_start', `event-start-${a.id}`,
      { duration: durText(minutes), boost: String(type === 'legendary' ? bonus.legendaryBoost : bonus.shinyMultiplier) });
    this.changed({ kind: 'start', event: this.publicActive(a) });
    return this.publicActive(a);
  }

  stopEvent({ reason = 'admin', admin = null } = {}) {
    const st = this.state();
    if (!st.active) throw err(409, 'Nessun evento attivo');
    return this.finish(st, reason, { admin });
  }

  // Chiude l'evento attivo: bonus via subito, risultato nello storico, annuncio.
  finish(st, reason, { admin = null, announce = true } = {}) {
    const a = st.active;
    const t = this.now();
    const endedAt = new Date(a.pausedAt ? a.pausedAt : Math.min(t, a.endsAt)).toISOString();
    const result = this.result(a.startedAt, endedAt);
    const entry = { ...a, endedAt, reason, result, endsAt: undefined, remainingMs: undefined };
    delete entry.endsAt; delete entry.remainingMs;
    st.history.unshift(entry);
    st.active = null;
    if (st.last[a.type]) st.last[a.type].endedAt = endedAt;
    this.save(st);
    audit(this.db, { admin, action: 'auto_event_end', targetType: 'auto_event', targetId: a.id, detail: { type: a.type, reason, result } }, this.log);
    this.log?.info(`${a.label} terminato (${reason}): ${result.captures} catture, ${result.legendarySpawns} leggendari e ${result.shinySpawns} shiny apparsi`);
    if (announce) this.announce('event_end', `event-end-${a.id}`, { event: a.label, captures: String(result.captures) });
    this.changed({ kind: 'end', event: entry });
    return entry;
  }

  // Risultato dell'evento: cosa è apparso e cosa è stato catturato nella sua finestra.
  result(from, to) {
    const sp = this.db.get(
      `SELECT COUNT(*) AS spawns, COALESCE(SUM(is_shiny), 0) AS shiny,
              COALESCE(SUM(CASE WHEN rarity IN ('legendary','mythical') THEN 1 ELSE 0 END), 0) AS legendary
       FROM spawn_history WHERE is_demo = 0 AND started_at >= ? AND started_at <= ?`, from, to);
    const ca = this.db.get(
      `SELECT COUNT(*) AS captures, COALESCE(SUM(is_shiny), 0) AS shiny,
              COALESCE(SUM(CASE WHEN rarity IN ('legendary','mythical') THEN 1 ELSE 0 END), 0) AS legendary
       FROM leaderboard_events WHERE voided_at IS NULL AND caught_at >= ? AND caught_at <= ?`, from, to);
    return { spawns: sp.spawns, shinySpawns: sp.shiny, legendarySpawns: sp.legendary, captures: ca.captures, shinyCaptures: ca.shiny, legendaryCaptures: ca.legendary };
  }

  captureCount(sinceIso = null) {
    return this.db.get(`SELECT COUNT(*) AS n FROM leaderboard_events WHERE voided_at IS NULL${sinceIso ? ' AND caught_at >= ?' : ''}`, ...(sinceIso ? [sinceIso] : [])).n;
  }

  // --- Ciclo periodico -----------------------------------------------------------------
  tick() {
    if (this.ticking || !this.db?.db) return;
    this.ticking = true;
    try {
      const s = this.settings();
      const st = this.state();
      const t = this.now();
      const allowed = s.enabled && this.gameAllows(s);
      if (st.active) {
        const a = st.active;
        if (!s.enabled) this.finish(st, 'disabled');
        else if (!a.pausedAt && t >= a.endsAt) this.finish(st, 'completed');
        else if (!allowed && !a.pausedAt) {
          if (s.offlineRule === 'pause') this.pause(st);
          else this.finish(st, this.offlineReason());
        } else if (allowed && a.pausedAt) this.resume(st);
      }
      if (!allowed) return;
      this.pokemonOfDayTick(s);
      this.checkCommunity(s);
      if (this.state().active) return;
      // Avvii automatici: solo eventi attivi, nella fascia oraria, a intervalli minimi.
      const sinceStart = (type) => {
        const last = this.state().last[type];
        const ref = Math.max(Date.parse(this.engine.session.started_at), last?.endedAt ? Date.parse(last.endedAt) : 0);
        return { minutes: (t - ref) / 60000, refIso: new Date(ref).toISOString() };
      };
      const L = s.legendary;
      if (L.enabled && this.inSchedule(L.schedule, t)) {
        const ref = sinceStart('legendary');
        const due = L.trigger === 'time' ? ref.minutes >= L.everyMinutes : this.captureCount(ref.refIso) >= L.everyCaptures;
        if (due) { this.startEvent('legendary', { by: 'auto', reason: L.trigger === 'time' ? `ogni ${L.everyMinutes} minuti` : `ogni ${L.everyCaptures} catture` }); return; }
      }
      const S = s.shiny;
      if (S.enabled && S.auto && this.inSchedule(S.schedule, t) && sinceStart('shiny').minutes >= S.everyMinutes) {
        this.startEvent('shiny', { by: 'auto', reason: `ogni ${S.everyMinutes} minuti` });
      }
    } catch (e) {
      this.log?.warn('Eventi automatici: controllo periodico non riuscito (il gioco continua)', { message: e.message });
    } finally {
      this.ticking = false;
    }
  }

  offlineReason() {
    const e = this.engine;
    if (e.mode === 'demo') return 'demo';
    if (e.mode === 'manual') return 'manual_not_allowed';
    return 'twitch_offline';
  }

  pause(st) {
    const a = st.active;
    const t = this.now();
    a.pausedAt = t;
    a.remainingMs = Math.max(0, a.endsAt - t);
    this.save(st);
    this.log?.info(`${a.label} sospeso: il gioco non è attivo (restano ${Math.ceil(a.remainingMs / 60000)} min)`);
    audit(this.db, { action: 'auto_event_pause', targetType: 'auto_event', targetId: a.id, detail: { remainingMs: a.remainingMs, reason: this.offlineReason() } }, this.log);
    this.changed({ kind: 'pause', event: this.publicActive(a) });
  }

  resume(st) {
    const a = st.active;
    const t = this.now();
    a.pausedMs = (a.pausedMs || 0) + (t - a.pausedAt);
    a.endsAt = t + (a.remainingMs || 0);
    a.pausedAt = null;
    a.remainingMs = null;
    this.save(st);
    this.log?.info(`${a.label} ripreso`);
    this.changed({ kind: 'resume', event: this.publicActive(a) });
  }

  // Fine sessione (diretta terminata, sessione manuale fermata): l'evento termina o
  // resta sospeso secondo la regola; prima del riepilogo, così vi compare.
  onSessionClosed(s) {
    try {
      const st = this.state();
      if (!st.active) return;
      const rule = this.settings().offlineRule;
      if (rule === 'pause' && s?.end_reason !== 'restore') { if (!st.active.pausedAt) this.pause(st); return; }
      this.finish(st, s?.kind === 'manual' ? 'session_end' : 'twitch_offline');
    } catch (e) {
      this.log?.warn('Eventi automatici: chiusura sessione non gestita', { message: e.message });
    }
  }

  // --- Pokémon del giorno -----------------------------------------------------------------
  pokemonOfDay({ select = true } = {}) {
    const s = this.settings().pokemonOfDay;
    if (!s.enabled) return null;
    const date = localDate(this.now());
    const st = this.state();
    let id = st.potd?.date === date ? st.potd.pokemonId : null;
    if (!id && select) {
      if (s.mode === 'fixed' && s.pokemonId) id = s.pokemonId;
      else {
        const pool = this.db.all('SELECT id FROM pokemon WHERE enabled = 1 AND spawn_weight > 0 ORDER BY id');
        if (pool.length) id = pool[fnv(date) % pool.length].id;
      }
      if (id) { st.potd = { date, pokemonId: id, announced: false }; this.save(st); }
    }
    if (!id) return null;
    const p = this.db.get('SELECT * FROM pokemon WHERE id = ?', id);
    if (!p) return null;
    const since = new Date(localMidnight(this.now())).toISOString();
    const catchers = this.db.all(
      `SELECT COALESCE(u.custom_name, u.display_name) AS name, MIN(e.caught_at) AS at FROM leaderboard_events e JOIN twitch_users u ON u.id = e.user_id
       WHERE e.voided_at IS NULL AND e.pokemon_id = ? AND e.caught_at >= ? GROUP BY e.user_id ORDER BY at ASC LIMIT 20`, id, since);
    return {
      date, pokemonId: p.id, dex: p.dex_number, name: p.name_it || p.name, rarity: p.rarity, rarityLabel: RARITY_LABELS[p.rarity] || p.rarity,
      image: imageUrl(p, false), mode: s.mode, catchers: catchers.map((c) => c.name), catchersCount: catchers.length,
    };
  }

  pokemonOfDayTick(s) {
    if (!s.pokemonOfDay.enabled) return;
    const p = this.pokemonOfDay();
    if (!p) return;
    const st = this.state();
    if (!st.potd || st.potd.announced) return;
    st.potd.announced = true;
    st.history.unshift({ id: ++st.seq, type: 'pokemon_of_day', label: EVENT_TYPES.pokemon_of_day.label, startedAt: new Date(this.now()).toISOString(), endedAt: null, by: 'auto', pokemon: p.name, pokemonId: p.pokemonId, date: p.date, sessionId: this.engine.session?.id ?? null });
    this.save(st);
    if (s.pokemonOfDay.announce) this.announce('pokemon_of_day', `potd-${p.date}`, { pokemon: p.name, rarity: p.rarityLabel });
    this.changed({ kind: 'potd', pokemonOfDay: p });
  }

  // --- Evento Community -------------------------------------------------------------------
  newCommunityGoal({ admin = null, goal = null, announce = true } = {}) {
    const s = this.settings();
    const st = this.state();
    const g = goal == null ? s.community.goal : Number(goal);
    if (!Number.isInteger(g) || g < EVENT_LIMITS.goal[0] || g > EVENT_LIMITS.goal[1]) throw err(400, `Obiettivo: tra ${EVENT_LIMITS.goal[0]} e ${EVENT_LIMITS.goal[1]} catture`);
    st.seq += 1;
    st.community = { id: st.seq, goal: g, reward: s.community.reward, startedAt: new Date(this.now()).toISOString(), completedAt: null };
    this.save(st);
    audit(this.db, { admin, action: 'community_goal_new', targetType: 'auto_event', targetId: st.community.id, detail: { goal: g } }, this.log);
    if (announce && s.enabled && s.community.enabled && this.gameAllows(s)) this.announce('community_goal_start', `community-start-${st.community.id}`, { goal: String(g), reward: s.community.reward });
    this.changed({ kind: 'community', community: this.communityView() });
    return this.communityView();
  }

  communityView() {
    const s = this.settings();
    const c = this.state().community;
    if (!c) return { enabled: s.enabled && s.community.enabled, active: false };
    const progress = c.completedAt ? c.goal : Math.min(c.goal, this.captureCount(c.startedAt));
    return {
      enabled: s.enabled && s.community.enabled, active: true, id: c.id, goal: c.goal, progress, pct: Math.min(100, Math.floor((progress / c.goal) * 100)),
      reward: c.reward, startedAt: c.startedAt, completedAt: c.completedAt, unlock: s.community.unlock,
    };
  }

  // delayMs: dopo una cattura l'annuncio aspetta quello della cattura stessa (stesso ordine in chat).
  checkCommunity(s = this.settings(), { delayMs = 0 } = {}) {
    if (!s.enabled || !s.community.enabled) return;
    const st = this.state();
    const c = st.community;
    if (!c || c.completedAt) return;
    const n = this.captureCount(c.startedAt);
    if (n < c.goal) return;
    c.completedAt = new Date(this.now()).toISOString();
    st.history.unshift({ id: ++st.seq, type: 'community', label: EVENT_TYPES.community.label, startedAt: c.startedAt, endedAt: c.completedAt, by: 'community', reason: 'completed', goal: c.goal, reward: c.reward, sessionId: this.engine.session?.id ?? null, result: { captures: n } });
    this.save(st);
    audit(this.db, { action: 'community_goal_completed', targetType: 'auto_event', targetId: c.id, detail: { goal: c.goal } }, this.log);
    this.log?.info(`Obiettivo della community raggiunto: ${c.goal} catture`);
    this.announce('community_goal_complete', `community-done-${c.id}`, { goal: String(c.goal), reward: c.reward }, { delayMs });
    this.hub?.overlay('celebration', { kind: 'community', title: 'Obiettivo raggiunto!', text: c.reward || `${c.goal} catture della community`, goal: c.goal });
    this.changed({ kind: 'community_complete', community: this.communityView() });
    // Premio facoltativo: un evento con bonus, solo se non ce n'è già uno.
    const unlock = s.community.unlock;
    if (unlock !== 'none' && s[unlock].enabled && !this.state().active && this.gameAllows(s)) {
      try { this.startEvent(unlock, { by: 'community', reason: `obiettivo di ${c.goal} catture raggiunto` }); } catch (e) { this.log?.warn('Premio della community non avviato', { message: e.message }); }
    }
    if (s.community.autoRestart) this.newCommunityGoal({ announce: true });
  }

  // Cattura confermata dal motore: obiettivi e Pokémon del giorno.
  onAttempt(res) {
    try {
      if (!res?.caught || res.isDemo || res.demo || !res.leaderboardEvent) return;
      const s = this.settings();
      if (!s.enabled) return;
      this.checkCommunity(s, { delayMs: (this.chatMessages?.captureDelayMs ?? 0) + 300 });
      const st = this.state();
      const ev = res.leaderboardEvent;
      if (s.pokemonOfDay.enabled && st.potd?.date === localDate(this.now()) && ev.pokemon_id === st.potd.pokemonId && this.gameAllows(s)) {
        const u = this.db.get('SELECT COALESCE(custom_name, display_name) AS name FROM twitch_users WHERE id = ?', ev.user_id);
        const p = this.db.get('SELECT name, name_it, rarity FROM pokemon WHERE id = ?', ev.pokemon_id);
        const attemptId = ev.capture_attempt_id;
        // Come per le catture: breve attesa e nuovo controllo (un riscatto annullato subito non viene annunciato).
        this.announce('pokemon_of_day_capture', `potd-capture-${attemptId}`, { user: u?.name || '', pokemon: p?.name_it || p?.name || '', rarity: RARITY_LABELS[p?.rarity] || '' }, {
          delayMs: this.chatMessages?.captureDelayMs ?? 0,
          verify: () => this.db.get('SELECT outcome FROM capture_attempts WHERE id = ?', attemptId)?.outcome === 'caught',
        });
      }
      this.changed({ kind: 'capture' });
    } catch (e) {
      this.log?.warn('Eventi automatici: cattura non elaborata (il gioco continua)', { message: e.message });
    }
  }

  // --- Annunci, overlay e viste -------------------------------------------------------------
  announce(key, eventId, vars, opts = {}) {
    try { this.chatMessages?.trigger(key, eventId, vars, opts); } catch (e) { this.log?.warn('Annuncio in chat non preparato', { message: e.message }); }
  }

  publicActive(a = this.state().active) {
    if (!a) return null;
    const t = this.now();
    return {
      id: a.id, type: a.type, label: a.label, by: a.by, startedAt: a.startedAt, durationMin: a.durationMin,
      endsAt: a.pausedAt ? null : new Date(a.endsAt).toISOString(), paused: !!a.pausedAt,
      remainingS: Math.max(0, Math.round((a.pausedAt ? a.remainingMs : a.endsAt - t) / 1000)),
      bonus: a.bonus,
      bonusText: a.type === 'legendary' ? `Leggendari e Mitici ×${a.bonus.legendaryBoost}` : `Probabilità shiny ×${a.bonus.shinyMultiplier}`,
      sessionId: a.sessionId,
    };
  }

  overlayPayload() {
    const s = this.settings();
    if (!s.enabled) return { enabled: false, active: null, community: null, pokemonOfDay: null };
    return {
      enabled: true,
      active: this.publicActive(),
      community: s.community.enabled ? this.communityView() : null,
      pokemonOfDay: s.pokemonOfDay.enabled ? this.pokemonOfDay({ select: this.gameAllows(s) || !!this.state().potd }) : null,
    };
  }

  changed(info = {}) {
    try {
      const payload = this.overlayPayload();
      this.hub?.overlay('events', payload);
      this.hub?.admin('events', { ...payload, info: info.kind || null });
      this.emit('change', { ...info, payload });
    } catch (e) {
      this.log?.warn('Aggiornamento eventi non inviato', { message: e.message });
    }
  }

  // Eventi registrati durante una sessione (per lo Stream Recap).
  forSession(s) {
    const st = this.state();
    const start = Date.parse(s.started_at);
    const end = s.ended_at ? Date.parse(s.ended_at) : Infinity;
    const overlaps = (e) => e.sessionId === s.id || (Date.parse(e.startedAt) <= end && (e.endedAt ? Date.parse(e.endedAt) : Infinity) >= start);
    const list = st.history.filter((e) => e.type !== 'pokemon_of_day' && overlaps(e));
    if (st.active && overlaps(st.active)) list.unshift({ ...this.publicActive(st.active), ongoing: true });
    return list.slice(0, 20).map((e) => ({
      id: e.id, type: e.type, label: e.label, by: e.by, startedAt: e.startedAt, endedAt: e.endedAt || null, reason: e.reason || null,
      ongoing: !!e.ongoing, paused: !!e.paused, bonus: e.bonus || null, goal: e.goal || null, reward: e.reward || null, result: e.result || null,
    }));
  }

  view() {
    const st = this.state();
    return {
      settings: this.settings(), limits: EVENT_LIMITS, types: EVENT_TYPES,
      game: { mode: this.engine.mode, running: this.engine.running, allowed: this.gameAllows() },
      active: this.publicActive(st.active), community: this.communityView(), pokemonOfDay: this.pokemonOfDay({ select: false }),
      history: st.history.slice(0, 50),
    };
  }
}
