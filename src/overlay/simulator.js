// Simulatore dell'overlay per l'Overlay Designer.
//
// Genera spawn, lanci, catture, fughe e notifiche FINTI, con lo stesso formato
// degli eventi reali del motore di gioco. Isolamento dai dati reali:
//  - legge soltanto (SELECT) l'elenco dei Pokémon e delle Poké Ball per avere
//    nomi e immagini realistici; non scrive MAI nel database;
//  - non passa dal motore di gioco, dalle catture o dalle statistiche;
//  - destinazione "preview": gli eventi tornano alla dashboard e vengono
//    mostrati solo nell'anteprima (nessun invio a OBS);
//  - destinazione "obs" (overlay pubblico): gli eventi vengono inviati agli
//    overlay collegati, marcati sim: true, e SOLO a gioco fermo: mai con una
//    diretta LIVE o PAUSED, mai con il motore attivo o sospeso (diretta o DEMO),
//    mai in ERROR/CONNECTING se Twitch ha segnalato il canale in diretta;
//  - quando il gioco si attiva, gli elementi simulati ancora visibili vengono
//    rimossi dagli overlay (evento "sim_clear": tocca solo ciò che è simulato).
import { STATES } from '../game_engine/stateMachine.js';

export const SIM_KINDS = ['spawn', 'shiny', 'legendary', 'catch', 'fail', 'flee', 'expire', 'notify', 'sequence', 'clear'];

const SAMPLE_MONS = [
  { dex: 25, name: 'Pikachu', types: ['electric'], rarity: 'uncommon' },
  { dex: 133, name: 'Eevee', types: ['normal'], rarity: 'rare' },
  { dex: 4, name: 'Charmander', types: ['fire'], rarity: 'uncommon' },
  { dex: 150, name: 'Mewtwo', types: ['psychic'], rarity: 'legendary' },
];
const SAMPLE_BALLS = [
  { name: 'Poké Ball', code: 'pokeball', color: '#e3350d' },
  { name: 'Mega Ball', code: 'greatball', color: '#3b82f6' },
  { name: 'Ultra Ball', code: 'ultraball', color: '#f2c200' },
];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
const TYPES = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
const IMAGE_RE = /^(\/images\/[A-Za-z0-9._-]{1,120}|\/assets\/img\/[A-Za-z0-9._-]{1,60}|https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9._\/-]{1,300})$/;
const CTRL_RE = /[\u0000-\u001f\u007f<>]/; // senza "g": usato con test(), nessuno stato tra chiamate
const USERS = ['AshFan99', 'MistyWave', 'BrockSolid', 'Lucia_Gym', 'TeamRocketJess', 'OakResearch'];

let simCounter = 0;

export class SimulationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class OverlaySimulator {
  constructor({ db, hub, engine, sm = null, log, timers = true, rng = Math.random, channelLive = () => false }) {
    Object.assign(this, { db, hub, engine, sm, log, timers, rng, channelLive });
    this.obsSpawn = null;
    this.pending = [];
    this.obsDirty = false; // ci sono elementi simulati sugli overlay pubblici
  }

  // Lo spawn visibile nell'anteprima arriva dal browser: viene accettato solo se
  // ogni campo è valido, altrimenti la simulazione riparte da uno spawn nuovo.
  static cleanSpawn(sp) {
    if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return null;
    const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
    const iso = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined);
    const out = {
      id: int(sp.id, -1e9, -1),
      pokemonId: sp.pokemonId === null ? null : int(sp.pokemonId, 1, 1e7),
      dex: int(sp.dex, 0, 100000),
      name: typeof sp.name === 'string' && sp.name.length <= 40 && !CTRL_RE.test(sp.name) && sp.name.trim() ? sp.name : undefined,
      types: Array.isArray(sp.types) && sp.types.length <= 3 && sp.types.every((t) => TYPES.includes(t)) ? [...sp.types] : undefined,
      rarity: RARITIES.includes(sp.rarity) ? sp.rarity : undefined,
      shiny: typeof sp.shiny === 'boolean' ? sp.shiny : undefined,
      image: typeof sp.image === 'string' && IMAGE_RE.test(sp.image) && !sp.image.includes('..') ? sp.image : undefined,
      startedAt: iso(sp.startedAt),
      expiresAt: iso(sp.expiresAt),
      attempts: int(sp.attempts ?? 0, 0, 10000),
    };
    if (Object.values(out).some((v) => v === undefined) || !out.name) return null;
    return { ...out, form: null, captures: 0, status: 'active', mode: 'single', demo: false, sim: true };
  }

  pick(arr) { return arr[Math.floor(this.rng() * arr.length) % arr.length]; }

  // Pokémon reale dal catalogo (solo lettura) oppure un esempio se il catalogo è vuoto.
  randomMon({ rarity } = {}) {
    let row = null;
    try {
      row = rarity === 'legendary'
        ? this.db.get("SELECT * FROM pokemon WHERE enabled = 1 AND rarity IN ('legendary','mythical') ORDER BY RANDOM() LIMIT 1")
        : this.db.get('SELECT * FROM pokemon WHERE enabled = 1 ORDER BY RANDOM() LIMIT 1');
    } catch { row = null; }
    if (!row) {
      const s = rarity === 'legendary' ? SAMPLE_MONS[3] : this.pick(SAMPLE_MONS.slice(0, 3));
      return { pokemonId: null, dex: s.dex, name: s.name, types: s.types, rarity: s.rarity, image: '/assets/img/unknown.svg', shinyImage: '/assets/img/unknown.svg' };
    }
    const file = (f) => (f ? `/images/${f}` : null);
    return {
      pokemonId: row.id, dex: row.dex_number, name: row.name_it || row.name, types: safeTypes(row.types), rarity: row.rarity,
      image: file(row.image_file) || row.image_url || '/assets/img/unknown.svg',
      shinyImage: file(row.shiny_image_file) || row.shiny_image_url || file(row.image_file) || row.image_url || '/assets/img/unknown.svg',
    };
  }

  randomBall() {
    let rows = [];
    try { rows = this.db.all('SELECT name, code, color FROM ball_types WHERE enabled = 1 ORDER BY sort_order'); } catch { rows = []; }
    return this.pick(rows.length ? rows : SAMPLE_BALLS);
  }

  makeSpawn({ shiny = false, rarity, durationS = 60 } = {}) {
    const m = this.randomMon({ rarity });
    const now = Date.now();
    return {
      id: -(++simCounter), pokemonId: m.pokemonId, dex: m.dex, name: m.name, form: null, types: m.types,
      rarity: rarity === 'legendary' && !['legendary', 'mythical'].includes(m.rarity) ? 'legendary' : m.rarity,
      shiny, image: shiny ? m.shinyImage : m.image,
      startedAt: new Date(now).toISOString(), expiresAt: new Date(now + durationS * 1000).toISOString(),
      attempts: 0, captures: 0, status: 'active', mode: 'single', demo: false, sim: true,
    };
  }

  throwEvent(spawn, { caught, fled = false }) {
    spawn.attempts = (spawn.attempts || 0) + 1;
    return {
      spawnId: spawn.id, user: this.pick(USERS), ball: this.randomBall(), caught, fled,
      pokemon: { name: spawn.name, dex: spawn.dex, shiny: spawn.shiny, rarity: spawn.rarity }, probability: null,
      attempts: spawn.attempts, sim: true,
    };
  }

  // Costruisce la sequenza di eventi per una simulazione. `spawn` è lo spawn
  // simulato attualmente visibile (null se nessuno). Restituisce gli eventi con
  // il ritardo da applicare e il nuovo spawn visibile.
  build(kind, { spawn = null, text, durationS = 60 } = {}) {
    if (!SIM_KINDS.includes(kind)) throw new SimulationError(400, `Simulazione sconosciuta: ${kind}`);
    const ev = [];
    let cur = OverlaySimulator.cleanSpawn(spawn);
    const ensure = () => {
      if (!cur) { cur = this.makeSpawn({ durationS }); ev.push({ type: 'spawn', data: cur, delayMs: 0 }); }
      return cur;
    };
    switch (kind) {
      case 'spawn': cur = this.makeSpawn({ durationS }); ev.push({ type: 'spawn', data: cur, delayMs: 0 }); break;
      case 'shiny': cur = this.makeSpawn({ durationS, shiny: true }); ev.push({ type: 'spawn', data: cur, delayMs: 0 }); break;
      case 'legendary': cur = this.makeSpawn({ durationS, rarity: 'legendary' }); ev.push({ type: 'spawn', data: cur, delayMs: 0 }); break;
      case 'fail': { const s = ensure(); ev.push({ type: 'throw', data: this.throwEvent(s, { caught: false }), delayMs: ev.length ? 900 : 0 }); break; }
      case 'catch': {
        const s = ensure();
        ev.push({ type: 'throw', data: this.throwEvent(s, { caught: true }), delayMs: ev.length ? 900 : 0 });
        ev.push({ type: 'despawn', data: { id: s.id, reason: 'caught', sim: true }, delayMs: 100 });
        cur = null;
        break;
      }
      case 'flee': {
        const s = ensure();
        ev.push({ type: 'throw', data: this.throwEvent(s, { caught: false, fled: true }), delayMs: ev.length ? 900 : 0 });
        ev.push({ type: 'despawn', data: { id: s.id, reason: 'fled', sim: true }, delayMs: 100 });
        cur = null;
        break;
      }
      case 'expire': { const s = ensure(); ev.push({ type: 'despawn', data: { id: s.id, reason: 'expired', name: s.name, sim: true }, delayMs: ev.length ? 1500 : 0 }); cur = null; break; }
      case 'notify': {
        const msg = typeof text === 'string' && text.trim() ? text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140) : 'Notifica di prova: il simulatore funziona!';
        ev.push({ type: 'notice', data: { text: msg, kind: 'info', sim: true }, delayMs: 0 });
        break;
      }
      case 'sequence': {
        // Una "mini diretta": spawn, due tentativi falliti, cattura, poi uno shiny che fugge.
        const a = this.makeSpawn({ durationS });
        ev.push({ type: 'spawn', data: a, delayMs: 0 });
        ev.push({ type: 'throw', data: this.throwEvent(a, { caught: false }), delayMs: 1800 });
        ev.push({ type: 'throw', data: this.throwEvent(a, { caught: false }), delayMs: 2600 });
        ev.push({ type: 'throw', data: this.throwEvent(a, { caught: true }), delayMs: 2600 });
        ev.push({ type: 'despawn', data: { id: a.id, reason: 'caught', sim: true }, delayMs: 100 });
        const b = this.makeSpawn({ durationS, shiny: true });
        ev.push({ type: 'spawn', data: b, delayMs: 3500 });
        ev.push({ type: 'throw', data: this.throwEvent(b, { caught: false, fled: true }), delayMs: 2200 });
        ev.push({ type: 'despawn', data: { id: b.id, reason: 'fled', sim: true }, delayMs: 100 });
        cur = null;
        break;
      }
      case 'clear': ev.push({ type: 'clear', data: { sim: true }, delayMs: 0 }); cur = null; break;
      default: break;
    }
    return { events: ev, spawn: cur };
  }

  // L'overlay pubblico è "in uso" se c'è una diretta (LIVE o PAUSED) oppure se
  // il motore ha una modalità attiva, anche sospesa (diretta interrotta, DEMO).
  publicOverlayBusy() {
    const state = this.sm?.state;
    if (state === STATES.LIVE || state === STATES.PAUSED) return `diretta ${state}`;
    if (this.engine?.mode === 'live') return 'diretta in corso';
    if (this.engine?.mode === 'demo') return 'modalità DEMO attiva';
    if (this.engine?.mode === 'manual') return 'sessione manuale attiva';
    // In ERROR o CONNECTING il gioco è fermo, ma il canale può essere davvero in
    // onda (es. EventSub non ancora collegato): l'ultima informazione nota da
    // Twitch dice che la diretta è attiva, quindi niente simulazioni in onda.
    if ((state === STATES.ERROR || state === STATES.CONNECTING) && this.channelLive()) return 'il canale risulta in diretta su Twitch';
    return null;
  }

  // Invio all'overlay pubblico (OBS). Rifiutato se l'overlay è in uso.
  sendToObs(kind, opts = {}) {
    const busy = this.publicOverlayBusy();
    if (busy) throw new SimulationError(409, `Overlay pubblico in uso (${busy}): le simulazioni su OBS sono disponibili solo a gioco fermo. L'anteprima privata del Designer resta disponibile.`);
    if (kind === 'clear') this.cancelPending();
    const { events, spawn } = this.build(kind, { ...opts, spawn: this.obsSpawn });
    this.obsSpawn = spawn;
    this.obsDirty = kind !== 'clear';
    this.log?.info(`Simulazione inviata all'overlay pubblico: ${kind} (${events.length} eventi, ${this.hub.counts().overlay} overlay collegati)`);
    let at = 0;
    for (const e of events) {
      at += e.delayMs;
      if (at === 0 || !this.timers) this.emit(e);
      else {
        const t = setTimeout(() => { this.pending = this.pending.filter((x) => x !== t); this.emit(e); }, at);
        t.unref?.();
        this.pending.push(t);
      }
    }
    return { events, spawn, target: 'obs', overlays: this.hub.counts().overlay };
  }

  emit(e) {
    // Se nel frattempo il gioco è partito, la simulazione si interrompe.
    if (this.publicOverlayBusy()) { this.purge('gioco attivo'); return; }
    this.hub.overlay(e.type, e.data);
  }

  // Il gioco si è attivato: interrompe le simulazioni e toglie dagli overlay gli
  // elementi simulati. Gli overlay rimuovono solo ciò che è marcato sim: true.
  purge(reason = 'gioco attivo') {
    const had = this.obsDirty || this.pending.length > 0;
    this.cancelPending();
    this.obsSpawn = null;
    this.obsDirty = false;
    if (had) {
      this.hub.overlay('sim_clear', { reason });
      this.log?.info(`Elementi simulati rimossi dagli overlay (${reason})`);
    }
    return had;
  }

  cancelPending() {
    for (const t of this.pending) clearTimeout(t);
    this.pending = [];
  }

  stop() { this.cancelPending(); }
}

function safeTypes(s) { try { const t = JSON.parse(s || '[]'); return Array.isArray(t) ? t.map(String).slice(0, 3) : []; } catch { return []; } }
