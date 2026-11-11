// Messaggi automatici in chat (sezione "Messaggi Twitch" della dashboard).
//
// - Nessuna seconda connessione a Twitch: gli eventi arrivano dal motore di gioco
//   ('spawn', 'attempt', 'session'), l'invio passa dal ChatSender già usato per le
//   risposte ai comandi, con l'account del bot.
// - Il token del canale non viene mai usato se è collegato (o previsto) un bot; senza
//   bot si usa solo se l'amministratore lo consente esplicitamente.
// - Twitch non collegato o non raggiungibile: il messaggio viene scartato, mai
//   accodato per dopo (un "è apparso un Pokémon" di dieci minuti fa non serve).
// - Antispam: intervallo minimo per tipo di evento, limite di messaggi al minuto,
//   un solo messaggio per spawn e per cattura (deduplicazione), coda corta e
//   messaggi vecchi scartati. I limiti del bot già esistenti restano in vigore.
// - Sicurezza: i modelli sono testo semplice; le variabili vengono sostituite qui,
//   con valori letti dal database (nickname dall'identità Twitch registrata, nome e
//   rarità del Pokémon dallo spawn), ripuliti da caratteri di controllo e accorciati.
//   Nessun HTML, nessuna esecuzione di codice. Gli utenti della chat non possono
//   modificare nulla: le rotte di modifica sono solo per l'amministratore.
// - Un errore qui non deve mai fermare il gioco: ogni gestore è protetto.
import { randomBytes } from 'node:crypto';
import { HttpError } from '../http/router.js';
import { CHAT_MESSAGE_DEFAULTS, RARITY_LABELS } from '../configuration/defaults.js';

const SPAWN_VARS = ['pokemon', 'pokemon_lower', 'pokemon_upper', 'rarity', 'level', 'shiny'];
const CAPTURE_VARS = ['user', ...SPAWN_VARS];
const SESSION_VARS = ['session_type'];
const SESSION_END_VARS = ['session_type', 'captures', 'spawns', 'participants', 'duration'];

// Catalogo degli eventi. "fallback": se l'evento specifico è spento o non ha
// messaggi attivi si usa quello generico (mai due messaggi per lo stesso fatto).
export const CHAT_EVENTS = [
  { key: 'spawn', label: 'Spawn di un Pokémon', group: 'spawn', available: true, vars: SPAWN_VARS },
  { key: 'shiny_spawn', label: 'Spawn shiny', group: 'spawn', available: true, vars: SPAWN_VARS, fallback: 'spawn',
    hint: 'Sostituisce il messaggio di spawn quando il Pokémon è shiny.' },
  { key: 'capture', label: 'Cattura riuscita', group: 'capture', available: true, vars: CAPTURE_VARS },
  { key: 'shiny_capture', label: 'Cattura shiny', group: 'capture', available: true, vars: CAPTURE_VARS, fallback: 'capture',
    hint: 'Sostituisce il messaggio di cattura quando il Pokémon è shiny.' },
  { key: 'legendary_capture', label: 'Cattura leggendaria o mitica', group: 'capture', available: true, vars: CAPTURE_VARS, fallback: 'capture',
    hint: 'Sostituisce il messaggio di cattura per i Pokémon di rarità Leggendario o Mitico.' },
  { key: 'session_start', label: 'Inizio sessione', group: 'session', available: true, vars: SESSION_VARS,
    hint: 'Inizio di una diretta Twitch o di una sessione manuale (non dopo una ripresa o un riavvio).' },
  { key: 'session_end', label: 'Fine sessione', group: 'session', available: true, vars: SESSION_END_VARS,
    hint: 'Fine della diretta o della sessione manuale.' },
  { key: 'leaderboard_first', label: 'Primo posto in classifica', group: 'future', available: false,
    reason: 'Il motore non segnala ancora i cambi di posizione in classifica.' },
  { key: 'personal_record', label: 'Record personale di un giocatore', group: 'future', available: false,
    reason: 'Il motore non calcola ancora i record personali.' },
  { key: 'evolution', label: 'Evoluzione', group: 'future', available: false,
    reason: 'Il gioco non prevede ancora le evoluzioni.' },
];
const EVENT = new Map(CHAT_EVENTS.map((e) => [e.key, e]));

export const CHAT_VARIABLES = {
  pokemon: 'Nome del Pokémon',
  pokemon_lower: 'Nome del Pokémon in minuscolo',
  pokemon_upper: 'Nome del Pokémon in maiuscolo',
  rarity: 'Rarità (Comune, Raro, Leggendario, …)',
  level: 'Livello: il gioco non ha livelli, quindi resta vuoto',
  shiny: '"✨ shiny" se il Pokémon è shiny, altrimenti vuoto',
  user: 'Nome Twitch di chi ha catturato (dall\'account Twitch, non dal testo della chat)',
  session_type: '"diretta" o "sessione manuale"',
  captures: 'Catture della sessione',
  spawns: 'Pokémon apparsi nella sessione',
  participants: 'Giocatori della sessione',
  duration: 'Durata della sessione (es. 1 h 20 min)',
};

// Valori d'esempio per l'anteprima nella dashboard.
export const SAMPLE_VARS = {
  pokemon: 'Pikachu', pokemon_lower: 'pikachu', pokemon_upper: 'PIKACHU', rarity: 'Raro', level: '', shiny: '',
  user: 'AshKetchum', session_type: 'diretta', captures: '12', spawns: '20', participants: '7', duration: '1 h 20 min',
};

export const LIMITS = { textMax: 300, messagesMax: 100, perEventMax: 20, messageMax: 450, valueMax: 40, cooldownMax: 3600, perMinuteMax: 20 };
const QUEUE_MAX = 5;
const MAX_AGE_MS = 20000; // un messaggio rimasto in coda più di così è ormai fuori tempo
const SEEN_MAX = 2000;
const RECENT_MAX = 30;

// Valore di una variabile: testo semplice su una riga, senza caratteri di controllo.
export function cleanValue(v, max = LIMITS.valueMax) {
  return String(v ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Sostituzione delle variabili: solo nomi conosciuti tra graffe; il resto resta com'è.
// Il testo finale è una riga sola, senza "/" o "." iniziali (comandi di chat) e
// entro il limite di lunghezza di Twitch (500 caratteri).
export function renderTemplate(text, vars = {}) {
  const out = String(text ?? '').replace(/\{([a-z_]+)\}/g, (m, name) => (Object.hasOwn(vars, name) ? cleanValue(vars[name]) : m));
  return cleanValue(out, 2000).replace(/^[\s/.\\]+/, '').slice(0, LIMITS.messageMax).trim();
}

const lower = (s) => String(s ?? '').toLocaleLowerCase('it');
const upper = (s) => String(s ?? '').toLocaleUpperCase('it');

export function pokemonVars({ name, rarity, shiny }) {
  return {
    pokemon: name, pokemon_lower: lower(name), pokemon_upper: upper(name),
    rarity: RARITY_LABELS[rarity] || rarity || '', level: '', shiny: shiny ? '✨ shiny' : '',
  };
}

function durationText(s) {
  const n = Math.max(0, Number(s) || 0);
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export class ChatMessagesService {
  constructor({ db, settings, chat, credentials, twitch, log, rng = Math.random, now = () => Date.now() }) {
    this.db = db;
    this.store = settings; // SettingsStore (admin_settings, chiave "chatMessages")
    this.chat = chat;
    this.creds = credentials;
    this.twitch = twitch; // () => stato del collegamento Twitch (vedi availability)
    this.log = log;
    this.rng = rng;
    this.now = now;
    this.captureDelayMs = 2000; // attesa prima del messaggio di cattura: un riscatto annullato subito non viene annunciato
    this.queue = [];
    this.sending = false;
    this.seen = new Map(); // ID evento -> momento (deduplicazione)
    this.lastByEvent = new Map(); // tipo di evento -> ultimo invio (intervallo minimo)
    this.lastMessage = new Map(); // tipo di evento -> ID dell'ultimo messaggio scelto (casuale senza ripetere)
    this.window = []; // momenti degli invii automatici (limite al minuto)
    this.pauseUntil = 0; // pausa dopo un "troppe richieste" di Twitch
    this.timers = new Set();
    this.recent = [];
    this.stats = { sent: 0, skipped: 0, failed: 0, lastError: null };
  }

  // --- Impostazioni ------------------------------------------------------------
  settings() {
    const s = this.store.get('chatMessages') || {};
    const events = {};
    for (const e of CHAT_EVENTS) {
      if (!e.available) continue;
      events[e.key] = { ...CHAT_MESSAGE_DEFAULTS.events[e.key], ...(s.events?.[e.key] || {}) };
    }
    return {
      enabled: s.enabled ?? CHAT_MESSAGE_DEFAULTS.enabled,
      allowChannelAccount: s.allowChannelAccount ?? CHAT_MESSAGE_DEFAULTS.allowChannelAccount,
      maxPerMinute: s.maxPerMinute ?? CHAT_MESSAGE_DEFAULTS.maxPerMinute,
      events,
      messages: Array.isArray(s.messages) ? s.messages : CHAT_MESSAGE_DEFAULTS.messages.map((m) => ({ ...m })),
    };
  }

  // Validazione completa: si salva solo una configurazione coerente.
  setSettings(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Richiesta non valida');
    const cur = this.settings();
    const next = { ...cur, events: { ...cur.events } };
    const bool = (v, k) => { if (typeof v !== 'boolean') throw new HttpError(400, `Valore non valido: ${k}`); return v; };
    const int = (v, k, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${k}: valore tra ${min} e ${max}`); return n; };
    if (input.enabled !== undefined) next.enabled = bool(input.enabled, 'enabled');
    if (input.allowChannelAccount !== undefined) next.allowChannelAccount = bool(input.allowChannelAccount, 'allowChannelAccount');
    if (input.maxPerMinute !== undefined) next.maxPerMinute = int(input.maxPerMinute, 'Messaggi al minuto', 1, LIMITS.perMinuteMax);

    if (input.messages !== undefined) {
      if (!Array.isArray(input.messages) || input.messages.length > LIMITS.messagesMax) throw new HttpError(400, `Elenco dei messaggi non valido (massimo ${LIMITS.messagesMax})`);
      const ids = new Set();
      const perEvent = {};
      next.messages = input.messages.map((m, i) => {
        if (!m || typeof m !== 'object') throw new HttpError(400, `Messaggio ${i + 1} non valido`);
        const ev = EVENT.get(m.event);
        if (!ev) throw new HttpError(400, `Messaggio ${i + 1}: evento sconosciuto`);
        if (!ev.available) throw new HttpError(400, `Messaggio ${i + 1}: l'evento "${ev.label}" non è ancora disponibile`);
        let id = typeof m.id === 'string' && /^[a-z0-9-]{1,40}$/.test(m.id) ? m.id : `m-${randomBytes(5).toString('hex')}`;
        if (ids.has(id)) id = `m-${randomBytes(5).toString('hex')}`;
        ids.add(id);
        const text = cleanValue(m.text, 10000);
        if (!text) throw new HttpError(400, `Messaggio ${i + 1}: il testo è vuoto`);
        if (text.length > LIMITS.textMax) throw new HttpError(400, `Messaggio ${i + 1}: massimo ${LIMITS.textMax} caratteri`);
        perEvent[ev.key] = (perEvent[ev.key] || 0) + 1;
        if (perEvent[ev.key] > LIMITS.perEventMax) throw new HttpError(400, `"${ev.label}": massimo ${LIMITS.perEventMax} messaggi`);
        return { id, event: ev.key, enabled: m.enabled === undefined ? true : bool(m.enabled, `Messaggio ${i + 1}`), text };
      });
    }

    if (input.events !== undefined) {
      if (!input.events || typeof input.events !== 'object' || Array.isArray(input.events)) throw new HttpError(400, 'Eventi non validi');
      for (const [key, v] of Object.entries(input.events)) {
        const ev = EVENT.get(key);
        if (!ev) throw new HttpError(400, `Evento sconosciuto: ${key}`);
        if (!ev.available) {
          if (v?.enabled) throw new HttpError(400, `L'evento "${ev.label}" non è ancora disponibile`);
          continue;
        }
        if (!v || typeof v !== 'object') throw new HttpError(400, `Evento non valido: ${key}`);
        const e = { ...next.events[key] };
        if (v.enabled !== undefined) e.enabled = bool(v.enabled, `${ev.label}`);
        if (v.mode !== undefined) {
          if (!['fixed', 'random'].includes(v.mode)) throw new HttpError(400, `${ev.label}: modalità non valida`);
          e.mode = v.mode;
        }
        if (v.fixedId !== undefined) e.fixedId = v.fixedId == null || v.fixedId === '' ? null : String(v.fixedId);
        if (v.cooldownS !== undefined) e.cooldownS = int(v.cooldownS, `${ev.label}: intervallo minimo`, 0, LIMITS.cooldownMax);
        next.events[key] = e;
      }
    }
    // Messaggio fisso: deve esistere ed essere di quell'evento (se eliminato si usa il primo attivo).
    for (const [key, e] of Object.entries(next.events)) {
      if (e.fixedId && !next.messages.some((m) => m.id === e.fixedId && m.event === key)) e.fixedId = null;
    }
    this.store.set('chatMessages', next);
    return next;
  }

  // --- Stato di Twitch ---------------------------------------------------------
  // Si invia solo se Twitch è davvero collegato (EventSub attivo, account del canale
  // valido) e c'è un account autorizzato a scrivere in chat.
  availability(s = this.settings()) {
    const t = this.twitch?.() || {};
    if (!t.configured) return { ok: false, code: 'twitch_not_configured', message: 'Twitch non è collegato (sezione Twitch)' };
    if (t.credentialsUnreadable) return { ok: false, code: 'twitch_not_configured', message: 'Credenziali Twitch non leggibili: ricollega gli account' };
    if (t.broadcasterError) return { ok: false, code: 'twitch_auth', message: 'Account del canale da ricollegare' };
    if (!t.connected) return { ok: false, code: 'twitch_offline', message: 'Twitch non raggiungibile in questo momento' };
    const bot = this.creds.getToken('bot');
    const botLinked = !!this.creds.raw?.().bot || !!bot;
    if (botLinked) {
      if (!bot?.accessToken || !bot.userId) return { ok: false, code: 'bot_unreadable', message: 'Account del bot non leggibile: ricollegalo' };
      if (bot.authError) return { ok: false, code: 'bot_auth', message: 'Token del bot revocato o scaduto: ricollega il bot' };
      if (Array.isArray(bot.scopes) && bot.scopes.length && !bot.scopes.includes('user:write:chat')) {
        return { ok: false, code: 'bot_scope', message: 'Il bot non ha il permesso di scrivere in chat (user:write:chat): ricollegalo' };
      }
      return { ok: true, role: 'bot', account: bot.displayName || bot.login || 'bot' };
    }
    if (!s.allowChannelAccount) return { ok: false, code: 'no_bot', message: 'Nessun bot collegato: collega il bot o consenti l\'invio con l\'account del canale' };
    const b = this.creds.getToken('broadcaster');
    if (Array.isArray(b?.scopes) && b.scopes.length && !b.scopes.includes('user:write:chat')) {
      return { ok: false, code: 'channel_scope', message: 'L\'account del canale non ha il permesso di scrivere in chat: ricollegalo' };
    }
    return { ok: true, role: 'broadcaster', account: b?.displayName || b?.login || 'canale' };
  }

  // --- Scelta e preparazione dei messaggi -----------------------------------------
  activeMessages(s, key) { return s.messages.filter((m) => m.event === key && m.enabled); }

  // Evento effettivo: lo specifico (es. cattura shiny) se attivo e con messaggi,
  // altrimenti il generico.
  resolveEvent(s, key) {
    const ev = EVENT.get(key);
    if (!ev?.available) return null;
    const cfg = s.events[key];
    if (cfg?.enabled && this.activeMessages(s, key).length) return key;
    return ev.fallback ? this.resolveEvent(s, ev.fallback) : null;
  }

  pick(s, key) {
    const list = this.activeMessages(s, key);
    if (!list.length) return null;
    const cfg = s.events[key];
    if (cfg.mode === 'fixed') return list.find((m) => m.id === cfg.fixedId) || list[0];
    const last = this.lastMessage.get(key);
    const options = list.length > 1 ? list.filter((m) => m.id !== last) : list;
    const i = Math.min(options.length - 1, Math.max(0, Math.floor(this.rng() * options.length)));
    return options[i];
  }

  record(entry) {
    this.recent.unshift({ at: new Date(this.now()).toISOString(), ...entry });
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
  }

  skip(entry) {
    this.stats.skipped++;
    this.record({ outcome: 'skipped', ...entry });
    return null;
  }

  guard(what, fn) {
    try { return fn(); } catch (e) {
      this.stats.failed++;
      this.stats.lastError = { at: new Date(this.now()).toISOString(), what, message: e.message };
      this.log?.warn('Messaggio in chat non preparato (il gioco continua)', { what, message: e.message });
      return null;
    }
  }

  // Prepara e accoda il messaggio di un evento. key: evento generico (spawn, capture, ...).
  // verify(): ricontrolla nel database, al momento dell'invio, che il fatto sia ancora vero.
  trigger(key, eventId, vars, { verify = null, delayMs = 0, variants = [] } = {}) {
    const s = this.settings();
    if (!s.enabled) return null;
    if (this.seen.has(eventId)) return this.skip({ event: key, eventId, reason: 'duplicato' });
    let resolved = null;
    for (const k of [...variants, key]) { resolved = this.resolveEvent(s, k); if (resolved) break; }
    if (!resolved) return null; // evento spento o senza messaggi attivi
    this.seen.set(eventId, this.now());
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value);
    const av = this.availability(s);
    if (!av.ok) return this.skip({ event: resolved, eventId, reason: av.message });
    const cooldown = s.events[resolved].cooldownS * 1000;
    const last = this.lastByEvent.get(resolved);
    if (cooldown && last != null && this.now() - last < cooldown) return this.skip({ event: resolved, eventId, reason: 'intervallo minimo non trascorso' });
    if (this.queue.length >= QUEUE_MAX) return this.skip({ event: resolved, eventId, reason: 'coda piena' });
    const msg = this.pick(s, resolved);
    const text = renderTemplate(msg.text, vars);
    if (!text) return this.skip({ event: resolved, eventId, reason: 'messaggio vuoto' });
    this.lastMessage.set(resolved, msg.id);
    // Riservato subito: due eventi ravvicinati dello stesso tipo non passano entrambi.
    this.lastByEvent.set(resolved, this.now());
    const item = { event: resolved, eventId, messageId: msg.id, text, verify, createdAt: this.now() };
    if (delayMs > 0) {
      const t = setTimeout(() => { this.timers.delete(t); this.enqueue(item); }, delayMs);
      t.unref?.();
      this.timers.add(t);
    } else {
      this.enqueue(item);
    }
    return item;
  }

  enqueue(item) {
    this.queue.push(item);
    this.drain().catch((e) => this.log?.warn('Coda dei messaggi in chat interrotta', { message: e.message }));
  }

  // Invio in sequenza, uno alla volta. Tutto ciò che non può partire subito viene
  // scartato (nessun recupero a posteriori).
  async drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        await this.deliver(item);
      }
    } finally {
      this.sending = false;
    }
  }

  async deliver(item) {
    const base = { event: item.event, eventId: item.eventId, text: item.text, test: !!item.test };
    try {
      const s = this.settings();
      if (!item.test && !s.enabled) return this.skip({ ...base, reason: 'messaggi automatici disattivati' });
      if (this.now() - item.createdAt > MAX_AGE_MS) return this.skip({ ...base, reason: 'troppo vecchio' });
      if (item.verify && !item.verify()) return this.skip({ ...base, reason: 'evento non più valido (es. cattura annullata)' });
      const av = this.availability(s);
      if (!av.ok) return this.skip({ ...base, reason: av.message });
      if (this.now() < this.pauseUntil) return this.skip({ ...base, reason: 'Twitch ha chiesto di rallentare' });
      if (!item.test) {
        const since = this.now() - 60000;
        this.window = this.window.filter((t) => t > since);
        if (this.window.length >= s.maxPerMinute) return this.skip({ ...base, reason: 'limite di messaggi al minuto' });
        this.window.push(this.now());
      }
      const r = await this.chat.deliver(item.text, { role: av.role });
      if (r.ok) {
        this.stats.sent++;
        this.record({ outcome: 'sent', ...base, account: av.role });
        return r;
      }
      if (r.code === 'rate_limited') this.pauseUntil = this.now() + 30000;
      this.stats.failed++;
      this.stats.lastError = { at: new Date(this.now()).toISOString(), what: item.event, message: r.message, code: r.code };
      this.record({ outcome: 'failed', ...base, reason: r.message });
      this.log?.warn('Messaggio in chat non inviato', { event: item.event, code: r.code, http: r.status || null, message: r.message });
      return r;
    } catch (e) {
      this.stats.failed++;
      this.stats.lastError = { at: new Date(this.now()).toISOString(), what: item.event, message: e.message };
      this.record({ outcome: 'failed', ...base, reason: e.message });
      this.log?.warn('Messaggio in chat non inviato (il gioco continua)', { event: item.event, message: e.message });
      return { ok: false, code: 'error', message: e.message };
    }
  }

  // --- Eventi del motore -----------------------------------------------------------
  onSpawn(spawn) {
    return this.guard('spawn', () => {
      if (!spawn?.id || spawn.demo) return null;
      const row = this.db.get(`SELECT s.is_demo, s.is_shiny, s.rarity, p.name_it, p.name FROM spawn_history s
        JOIN pokemon p ON p.id = s.pokemon_id WHERE s.id = ?`, spawn.id);
      if (!row || row.is_demo) return null;
      const vars = pokemonVars({ name: row.name_it || row.name, rarity: row.rarity, shiny: !!row.is_shiny });
      return this.trigger('spawn', `spawn-${spawn.id}`, vars, { variants: row.is_shiny ? ['shiny_spawn'] : [] });
    });
  }

  // Solo catture riuscite e ancora valide nel database: niente tentativi falliti,
  // rifiutati, duplicati, DEMO o riscatti annullati.
  onAttempt(res) {
    return this.guard('capture', () => {
      if (!res || res.rejected || res.duplicate || res.ignored || !res.caught || !res.attemptId) return null;
      const row = this.captureRow(res.attemptId);
      if (!row || row.outcome !== 'caught' || row.is_demo) return null;
      const vars = { user: row.display_name, ...pokemonVars({ name: row.name_it || row.name, rarity: row.rarity, shiny: !!row.is_shiny }) };
      const variants = [];
      if (row.is_shiny) variants.push('shiny_capture');
      if (['legendary', 'mythical'].includes(row.rarity)) variants.push('legendary_capture');
      const id = res.attemptId;
      return this.trigger('capture', `capture-${id}`, vars, {
        variants,
        delayMs: this.captureDelayMs,
        verify: () => this.captureRow(id)?.outcome === 'caught',
      });
    });
  }

  captureRow(id) {
    return this.db.get(`SELECT a.outcome, a.is_demo, u.display_name, s.is_shiny, s.rarity, p.name_it, p.name
      FROM capture_attempts a JOIN twitch_users u ON u.id = a.user_id
      JOIN spawn_history s ON s.id = a.spawn_id JOIN pokemon p ON p.id = s.pokemon_id WHERE a.id = ?`, id) || null;
  }

  // Inizio di una sessione nuova (non una ripresa dopo disconnessione o riavvio).
  onSession({ session, resumed } = {}) {
    return this.guard('session_start', () => {
      if (!session?.id || resumed || !['twitch', 'manual'].includes(session.kind)) return null;
      return this.trigger('session_start', `session-start-${session.id}`, { session_type: session.kind === 'manual' ? 'sessione manuale' : 'diretta' });
    });
  }

  onSessionClosed(s) {
    return this.guard('session_end', () => {
      if (!s?.id || !['twitch', 'manual'].includes(s.kind) || s.end_reason === 'restart') return null;
      return this.trigger('session_end', `session-end-${s.id}`, {
        session_type: s.kind === 'manual' ? 'sessione manuale' : 'diretta',
        captures: String(s.captures ?? 0), spawns: String(s.spawns ?? 0), participants: String(s.participants ?? 0), duration: durationText(s.duration_s),
      });
    });
  }

  // --- Dashboard -------------------------------------------------------------------
  preview(text, event = 'spawn') {
    const ev = EVENT.get(event);
    const vars = Object.fromEntries((ev?.vars || Object.keys(SAMPLE_VARS)).map((k) => [k, SAMPLE_VARS[k]]));
    return renderTemplate(cleanValue(text, LIMITS.textMax), vars);
  }

  // Invio di prova richiesto dall'amministratore: passa dagli stessi controlli
  // (Twitch collegato, account autorizzato, limiti del bot) ma non dagli intervalli.
  async test({ text, event = 'spawn' } = {}) {
    if (typeof text !== 'string' || !cleanValue(text)) throw new HttpError(400, 'Scrivi il testo da provare');
    if (cleanValue(text, 10000).length > LIMITS.textMax) throw new HttpError(400, `Massimo ${LIMITS.textMax} caratteri`);
    if (!EVENT.get(event)?.available) throw new HttpError(400, 'Evento non valido');
    const av = this.availability();
    if (!av.ok) throw new HttpError(409, av.message);
    const message = this.preview(text, event);
    if (!message) throw new HttpError(400, 'Il messaggio risultante è vuoto');
    const r = await this.deliver({ event, eventId: `test-${randomBytes(6).toString('hex')}`, text: message, createdAt: this.now(), test: true });
    if (!r?.ok) throw new HttpError(502, `Twitch non ha accettato il messaggio: ${r?.message || r?.reason || 'errore'}`);
    return { sent: true, message, account: av.account };
  }

  view() {
    const s = this.settings();
    return {
      settings: s,
      events: CHAT_EVENTS.map((e) => ({ key: e.key, label: e.label, group: e.group, available: e.available, vars: e.vars || [], fallback: e.fallback || null, hint: e.hint || null, reason: e.reason || null })),
      variables: CHAT_VARIABLES,
      sample: SAMPLE_VARS,
      limits: LIMITS,
      availability: this.availability(s),
      stats: { ...this.stats },
      recent: this.recent.slice(0, RECENT_MAX),
    };
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue = [];
  }
}
