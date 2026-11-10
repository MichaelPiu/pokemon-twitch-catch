// Effetti sonori per OBS: un suono a ogni nuovo spawn e la musica di conferma a
// ogni cattura riuscita. Gli eventi nascono dagli eventi già emessi dal motore
// di gioco ('spawn', 'attempt'): nessun secondo motore e nessuna seconda
// gestione degli eventi. Vengono inviati solo al canale WebSocket "audio",
// ascoltato dalla Browser Source /overlay/audio: la dashboard e l'overlay
// grafico non li ricevono mai.
//
// I file stanno nella cartella dati (DATA_DIR/audio), non nel repository né
// nell'immagine: l'app serve solo i file di una whitelist costruita leggendo
// quella cartella (estensioni audio, niente collegamenti simbolici, profondità
// e numero limitati), identificati da un ID opaco.
//
// Un errore audio non deve mai fermare il gioco: ogni gestore è protetto.
import { readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { join, extname, basename, relative, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../http/router.js';
import { AUDIO_DEFAULTS } from '../configuration/defaults.js';

export const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav' };
export { AUDIO_DEFAULTS };
const LIMITS = { files: 500, depth: 3, sizeBytes: 50 * 1024 * 1024 };
// Riconoscimento automatico (modificabile dalla dashboard): jingle brevi per lo
// spawn, "Caught a Pokémon" (o nomi simili) per la cattura.
// I nomi vengono confrontati senza accenti (i file estratti da uno zip possono
// avere "é" scomposta in "e" + accento).
const CAPTURE_AUTO = /(caught a pokemon|cattura|captured|capture)/i;
const SPAWN_AUTO = /(obtained a key item|obtained an item|level up|pokemon healed|evolved|pokedex evaluation|spawn|appear|apparso|apparizione)/i;
const plain = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const SEEN_MAX = 2000;

const fileId = (rel) => createHash('sha256').update(rel).digest('hex').slice(0, 16);

export class AudioService {
  constructor({ dir, db, settings, hub, log, rng = Math.random }) {
    this.dir = dir;
    this.db = db;
    this.store = settings; // SettingsStore (admin_settings, chiave "audio")
    this.hub = hub;
    this.log = log;
    this.rng = rng;
    this.lastSpawn = null; // percorso dell'ultimo suono di spawn (per non ripeterlo)
    this.sent = new Map(); // ID evento -> momento dell'invio (deduplicazione lato server)
    this.cache = null;
    this.stats = { sent: 0, skipped: 0, errors: 0, last: null, lastError: null };
    try { mkdirSync(dir, { recursive: true }); } catch { /* cartella non scrivibile: catalogo vuoto */ }
  }

  settings() { return { ...AUDIO_DEFAULTS, ...(this.store.get('audio') || {}) }; }

  // Whitelist dei file presenti (ricalcolata al massimo ogni 3 s).
  catalog({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 3000) return this.cache.files;
    const files = [];
    const walk = (dir, depth) => {
      if (depth > LIMITS.depth || files.length >= LIMITS.files) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));
      for (const e of entries) {
        if (files.length >= LIMITS.files) break;
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        const ext = extname(e.name).toLowerCase();
        if (!e.isFile() || !AUDIO_TYPES[ext]) continue;
        let st;
        try { st = lstatSync(full); } catch { continue; }
        if (!st.isFile() || st.size === 0 || st.size > LIMITS.sizeBytes) continue;
        const path = relative(this.dir, full).split(sep).join('/');
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        files.push({ id: fileId(path), path, name: basename(e.name, extname(e.name)).normalize('NFC'), folder: folder.normalize('NFC'), ext: ext.slice(1), type: AUDIO_TYPES[ext], size: st.size, mtimeMs: Math.round(st.mtimeMs), full });
      }
    };
    walk(this.dir, 0);
    this.cache = { at: Date.now(), files };
    return files;
  }

  byId(id) { return this.catalog().find((f) => f.id === id) || null; }
  url(f) { return `/audio/${f.id}.${f.ext}?v=${f.mtimeMs}`; }

  // Configurazione risolta sui file realmente presenti.
  resolve(s = this.settings()) {
    const files = this.catalog();
    const byPath = new Map(files.map((f) => [f.path, f]));
    const capture = s.captureFile != null ? byPath.get(s.captureFile) || null : files.find((f) => CAPTURE_AUTO.test(plain(f.name))) || null;
    const pool = s.spawnFiles != null
      ? s.spawnFiles.map((p) => byPath.get(p)).filter(Boolean)
      : files.filter((f) => SPAWN_AUTO.test(plain(f.name)) && f !== capture);
    const fixed = s.spawnFixed ? byPath.get(s.spawnFixed) || null : null;
    const missing = [...(s.spawnFiles || []), s.spawnFixed, s.captureFile].filter((p) => p && !byPath.has(p));
    return { files, capture, pool, fixed, missing, auto: { spawn: s.spawnFiles == null, capture: s.captureFile == null } };
  }

  // Suono di spawn: fisso, oppure a caso dalla lista evitando di ripetere l'ultimo.
  pickSpawn(s = this.settings(), r = this.resolve(s)) {
    if (s.spawnMode === 'fixed') return r.fixed || r.pool[0] || null;
    if (!r.pool.length) return null;
    const options = r.pool.length > 1 ? r.pool.filter((f) => f.path !== this.lastSpawn) : r.pool;
    const i = Math.min(options.length - 1, Math.max(0, Math.floor(this.rng() * options.length)));
    return options[i];
  }

  // Invia un evento "play" al canale audio. Ogni ID viene inviato una sola volta.
  emit(kind, file, eventId, { test = false } = {}) {
    if (this.sent.has(eventId)) { this.stats.skipped++; return null; }
    this.sent.set(eventId, Date.now());
    if (this.sent.size > SEEN_MAX) this.sent.delete(this.sent.keys().next().value);
    const s = this.settings();
    const ev = { id: eventId, kind, test, file: file.id, name: file.name, url: this.url(file), volume: s.volume, maxDurationS: s.maxDurationS, at: Date.now() };
    this.hub.audio('play', ev);
    this.stats.sent++;
    this.stats.last = { id: ev.id, kind, name: file.name, at: new Date(ev.at).toISOString(), listeners: this.listeners() };
    return ev;
  }

  guard(what, fn) {
    try { return fn(); } catch (e) {
      this.stats.errors++;
      this.stats.lastError = { at: new Date().toISOString(), what, message: e.message };
      this.log?.warn('Effetto sonoro non inviato (il gioco continua)', { what, message: e.message });
      return null;
    }
  }

  // Nuovo Pokémon generato dal motore (evento 'spawn').
  onSpawn(spawn) {
    return this.guard('spawn', () => {
      const s = this.settings();
      if (!spawn?.id || !s.enabled || !s.spawnEnabled) return null;
      if (spawn.demo && !s.includeDemo) return null;
      const id = `spawn-${spawn.id}`;
      if (this.sent.has(id)) { this.stats.skipped++; return null; }
      const f = this.pickSpawn(s);
      if (!f) return null;
      this.lastSpawn = f.path;
      return this.emit('spawn', f, id);
    });
  }

  // Tentativo elaborato dal motore (evento 'attempt'): solo catture riuscite e
  // ancora valide nel database (non fallite, rifiutate, duplicate o annullate).
  onAttempt(res) {
    return this.guard('capture', () => {
      if (!res || res.rejected || res.duplicate || res.ignored || !res.caught || !res.attemptId) return null;
      const s = this.settings();
      if (!s.enabled || !s.captureEnabled) return null;
      const row = this.db.get('SELECT outcome, is_demo FROM capture_attempts WHERE id = ?', res.attemptId);
      if (!row || row.outcome !== 'caught') return null;
      if (row.is_demo && !s.includeDemo) return null;
      const f = this.resolve(s).capture;
      if (!f) return null;
      return this.emit('capture', f, `capture-${res.attemptId}`);
    });
  }

  // Prova dalla dashboard: il suono parte solo nella Browser Source di OBS.
  test({ kind, fileId: fid = null }) {
    const s = this.settings();
    const r = this.resolve(s);
    let f;
    if (kind === 'spawn') f = this.pickSpawn(s, r);
    else if (kind === 'capture') f = r.capture;
    else if (kind === 'file') f = fid ? this.byId(String(fid)) : null;
    else throw new HttpError(400, 'Tipo di prova non valido');
    if (!f) throw new HttpError(409, kind === 'file' ? 'File audio non trovato' : 'Nessun file configurato per questo suono');
    const ev = this.emit(kind === 'file' ? 'test' : kind, f, `test-${randomBytes(6).toString('hex')}`, { test: true });
    return { event: ev, listeners: this.listeners() };
  }

  setSettings(input = {}) {
    const cur = this.settings();
    const paths = new Set(this.catalog({ fresh: true }).map((f) => f.path));
    const bool = (v, k) => { if (typeof v !== 'boolean') throw new HttpError(400, `Valore non valido: ${k}`); return v; };
    const int = (v, k, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${k}: valore tra ${min} e ${max}`); return n; };
    const file = (v, k) => {
      if (v == null || v === '') return null;
      if (typeof v !== 'string' || !paths.has(v)) throw new HttpError(400, `${k}: file non presente nella cartella audio`);
      return v;
    };
    const next = { ...cur };
    for (const k of ['enabled', 'spawnEnabled', 'captureEnabled', 'includeDemo']) if (input[k] !== undefined) next[k] = bool(input[k], k);
    if (input.volume !== undefined) next.volume = int(input.volume, 'Volume', 0, 100);
    if (input.maxDurationS !== undefined) next.maxDurationS = int(input.maxDurationS, 'Durata massima', 0, 300);
    if (input.spawnMode !== undefined) {
      if (!['random', 'fixed'].includes(input.spawnMode)) throw new HttpError(400, 'Modalità spawn non valida');
      next.spawnMode = input.spawnMode;
    }
    if (input.spawnFiles !== undefined) {
      if (input.spawnFiles === null) next.spawnFiles = null;
      else {
        if (!Array.isArray(input.spawnFiles) || input.spawnFiles.length > LIMITS.files) throw new HttpError(400, 'Elenco dei suoni di spawn non valido');
        next.spawnFiles = [...new Set(input.spawnFiles.map((p) => file(p, 'Suoni di spawn')).filter(Boolean))];
      }
    }
    if (input.spawnFixed !== undefined) next.spawnFixed = file(input.spawnFixed, 'Suono di spawn fisso');
    if (input.captureFile !== undefined) next.captureFile = file(input.captureFile, 'Musica di cattura');
    if (next.spawnMode === 'fixed' && !next.spawnFixed) throw new HttpError(400, 'Scegli il suono di spawn fisso');
    this.store.set('audio', next);
    this.hub.audio('settings', this.publicSettings(next));
    return next;
  }

  publicSettings(s = this.settings()) {
    return { enabled: s.enabled, spawnEnabled: s.spawnEnabled, captureEnabled: s.captureEnabled, volume: s.volume, maxDurationS: s.maxDurationS };
  }

  // Stato iniziale per la Browser Source: impostazioni e ora del server, MAI
  // eventi passati (dopo una riconnessione non si riascolta nulla).
  snapshot() { return { settings: this.publicSettings(), serverTime: Date.now() }; }

  listeners() { return this.hub.counts().audio || 0; }

  // Vista per la dashboard.
  view() {
    const s = this.settings();
    const r = this.resolve(s);
    const pub = (f) => (f ? { id: f.id, path: f.path, name: f.name, folder: f.folder, ext: f.ext, size: f.size } : null);
    const poolSet = new Set(r.pool.map((f) => f.path));
    return {
      settings: s,
      files: r.files.map((f) => ({ ...pub(f), spawn: poolSet.has(f.path), capture: r.capture?.path === f.path })),
      resolved: { capture: pub(r.capture), pool: r.pool.map(pub), fixed: pub(r.fixed), auto: r.auto, missing: r.missing },
      formats: Object.keys(AUDIO_TYPES).map((e) => e.slice(1)),
      listeners: this.listeners(),
      stats: { sent: this.stats.sent, skipped: this.stats.skipped, errors: this.stats.errors, last: this.stats.last, lastError: this.stats.lastError },
    };
  }
}
