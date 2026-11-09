// Motore di gioco: attivo SOLO durante le dirette (o in modalità DEMO separata).
// Gestisce sessione, timer di spawn, catture e notifiche overlay.
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { pickPokemon, createSpawn, activeSpawn, endSpawn, getSpawn, publicSpawn } from '../spawn/spawn.js';
import { processAttempt, handleRedemptionUpdate } from '../capture/capture.js';
import { SessionService } from './sessions.js';

export const secureRandom = () => randomInt(0, 2 ** 47) / 2 ** 47;

export class GameEngine extends EventEmitter {
  constructor({ db, gameSettings, hub, log, rng = secureRandom, timers = true }) {
    super();
    this.db = db;
    this.settings = gameSettings;
    this.hub = hub;
    this.log = log;
    this.rng = rng;
    this.timersEnabled = timers;
    this.sessions = new SessionService({ db, log });
    this.mode = null; // null | 'live' | 'demo'
    this.suspended = false;
    this.session = null;
    this.nextSpawnAt = null;
    this.spawnTimer = null;
    this.expiryTimer = null;
    this.lastError = null;
  }

  cfg() {
    return {
      spawn: this.settings.get('spawn'),
      rarityWeights: this.settings.get('rarityWeights'),
      rarityCatchBase: this.settings.get('rarityCatchBase'),
      shiny: this.settings.get('shiny'),
      capture: this.settings.get('capture'),
      event: this.settings.get('event'),
    };
  }

  // All'avvio del server: nessuno spawn può restare "attivo" da un'esecuzione precedente.
  recoverAfterRestart() {
    const r = this.db.run("UPDATE spawn_history SET status = 'interrupted', ended_at = ? WHERE status = 'active'", new Date().toISOString());
    if (r.changes) this.log.info(`Chiusi ${r.changes} spawn rimasti attivi dal riavvio precedente`);
    this.sessions.closeStaleDemo();
  }

  get running() { return !!this.mode && !this.suspended; }

  // Stato di accettazione dei tentativi.
  accepting(isDemo) {
    if (!this.mode) return { ok: false, reason: 'offline' };
    if (this.suspended) return { ok: false, reason: 'paused' };
    if ((this.mode === 'demo') !== !!isDemo) return { ok: false, reason: isDemo ? 'live_mode' : 'demo_mode' };
    return { ok: true };
  }

  // --- Ciclo di vita ---------------------------------------------------------
  activateLive({ broadcastId = null, title = null, startedAt = null } = {}) {
    if (this.mode === 'demo') this.stopDemo('live_started');
    const { session, resumed } = this.sessions.open({ broadcastId, title, startedAt, isDemo: false });
    this.session = session;
    this.mode = 'live';
    this.suspended = false;
    this.log.info(resumed ? `Motore ripreso sulla sessione #${session.id}` : `Motore avviato, sessione #${session.id}`);
    this.hub.overlay('state', { active: true, demo: false });
    this.scheduleNext(resumed ? null : this.cfg().spawn.firstSpawnDelayS);
    this.emitStatus();
    return { session, resumed };
  }

  // Sospensione sicura (disconnessione Twitch): la sessione resta aperta.
  suspend(reason = 'paused') {
    if (!this.mode || this.suspended) return;
    this.suspended = true;
    this.clearTimers();
    this.finishActiveSpawn('interrupted');
    this.hub.overlay('state', { active: false, paused: true });
    this.log.warn(`Motore sospeso (${reason})`);
    this.emitStatus();
  }

  resume() {
    if (!this.mode || !this.suspended) return;
    this.suspended = false;
    this.hub.overlay('state', { active: true, demo: this.mode === 'demo' });
    this.log.info('Motore ripreso');
    this.scheduleNext();
    this.emitStatus();
  }

  // Fine diretta: arresta tutto e chiude la sessione.
  deactivate(reason = 'stream_offline', endedAt = null) {
    const demo = this.mode === 'demo';
    if (!demo) {
      this.clearTimers();
      this.finishActiveSpawn('stream_ended');
    }
    const open = this.session?.is_demo ? null : (this.session || this.sessions.current(false));
    let closed = null;
    if (open) closed = this.sessions.close(open.id, reason, endedAt);
    if (this.mode === 'live') {
      this.mode = null;
      this.session = null;
    }
    if (!demo) {
      this.suspended = false;
      this.hub.overlay('state', { active: false });
      this.hub.overlay('clear', {});
    }
    if (closed) this.log.info('Motore di gioco arrestato');
    this.emitStatus();
    return closed;
  }

  startDemo() {
    if (this.mode === 'live') throw new Error('Impossibile avviare la DEMO durante una diretta');
    if (this.mode === 'demo') return this.session;
    const { session } = this.sessions.open({ isDemo: true, title: 'DEMO' });
    this.session = session;
    this.mode = 'demo';
    this.suspended = false;
    this.hub.overlay('state', { active: true, demo: true });
    this.log.info(`Modalità DEMO avviata (sessione demo #${session.id})`);
    this.scheduleNext(this.cfg().spawn.firstSpawnDelayS);
    this.emitStatus();
    return session;
  }

  stopDemo(reason = 'demo_stopped') {
    if (this.mode !== 'demo') return;
    this.clearTimers();
    this.finishActiveSpawn('cancelled');
    this.sessions.close(this.session.id, reason);
    this.mode = null;
    this.session = null;
    this.hub.overlay('state', { active: false });
    this.hub.overlay('clear', {});
    this.log.info('Modalità DEMO terminata');
    this.emitStatus();
  }

  // --- Spawn -----------------------------------------------------------------
  clearTimers() {
    clearTimeout(this.spawnTimer);
    clearTimeout(this.expiryTimer);
    this.spawnTimer = null;
    this.expiryTimer = null;
    this.nextSpawnAt = null;
  }

  scheduleNext(delayS = null) {
    clearTimeout(this.spawnTimer);
    this.spawnTimer = null;
    this.nextSpawnAt = null;
    if (!this.running) return;
    const s = this.cfg().spawn;
    if (!s.enabled) { this.emitStatus(); return; }
    let d = delayS;
    if (d == null) {
      const min = Math.max(5, Math.min(s.minIntervalS, s.maxIntervalS));
      const max = Math.max(min, s.maxIntervalS);
      d = min + this.rng() * (max - min);
    }
    this.nextSpawnAt = new Date(Date.now() + d * 1000).toISOString();
    if (this.timersEnabled) {
      this.spawnTimer = setTimeout(() => this.tick(), d * 1000);
      this.spawnTimer.unref?.();
    }
    this.emitStatus();
  }

  // Un "giro" del timer di spawn.
  tick() {
    this.spawnTimer = null;
    if (!this.running) return null;
    const s = this.cfg().spawn;
    if (!s.enabled) return null;
    if (activeSpawn(this.db)) { this.scheduleNext(); return null; }
    if (this.rng() >= s.spawnChance) { this.scheduleNext(); return null; }
    const sp = this.spawn({ source: this.mode === 'demo' ? 'demo' : 'auto' });
    if (!sp) this.scheduleNext();
    return sp;
  }

  spawn({ source = 'auto', pokemonId = null, shiny = null } = {}) {
    if (!this.running) throw new Error('Il motore di gioco non è attivo (canale offline)');
    const cfg = this.cfg();
    let pick;
    if (pokemonId) {
      const p = this.db.get('SELECT * FROM pokemon WHERE id = ?', pokemonId);
      if (!p) throw new Error('Pokémon non trovato');
      const isShiny = shiny == null ? !!(cfg.shiny.enabled && p.shiny_enabled && this.rng() < cfg.shiny.chance) : !!shiny;
      pick = { pokemon: p, isShiny };
    } else {
      pick = pickPokemon(this.db, cfg, this.rng);
      if (pick && shiny != null) pick.isShiny = !!shiny; // es. "Genera shiny" dalla dashboard
    }
    if (!pick) {
      this.lastError = 'Nessun Pokémon disponibile: importa i dati da PokéAPI o abilita qualche Pokémon';
      this.log.warn(this.lastError);
      return null;
    }
    const sp = createSpawn(this.db, {
      sessionId: this.session.id,
      pokemon: pick.pokemon,
      isShiny: pick.isShiny,
      source: this.mode === 'demo' ? 'demo' : source,
      durationS: cfg.spawn.durationS,
      captureMode: cfg.capture.mode === 'multi' ? 'multi' : 'single',
      isDemo: this.mode === 'demo',
    });
    if (!sp) return null;
    clearTimeout(this.spawnTimer);
    this.spawnTimer = null;
    this.nextSpawnAt = null;
    clearTimeout(this.expiryTimer);
    if (this.timersEnabled) {
      this.expiryTimer = setTimeout(() => this.expire(sp.id), cfg.spawn.durationS * 1000 + 250);
      this.expiryTimer.unref?.();
    }
    const pub = publicSpawn(sp);
    this.hub.overlay('spawn', pub);
    this.hub.admin('spawn', pub);
    this.log.info(`Spawn: #${sp.dex_number} ${pub.name}${sp.is_shiny ? ' ✨' : ''} (${sp.rarity})`);
    this.emit('spawn', pub);
    this.emitStatus();
    return pub;
  }

  expire(spawnId) {
    if (endSpawn(this.db, spawnId, 'expired')) {
      const sp = publicSpawn(getSpawn(this.db, spawnId));
      this.hub.overlay('despawn', { id: spawnId, reason: 'expired', name: sp.name });
      this.hub.admin('despawn', { id: spawnId, reason: 'expired' });
      this.emit('despawn', { id: spawnId, reason: 'expired' });
    }
    this.expiryTimer = null;
    this.scheduleNext();
  }

  finishActiveSpawn(status) {
    const a = activeSpawn(this.db);
    if (a && endSpawn(this.db, a.id, status)) {
      this.hub.overlay('despawn', { id: a.id, reason: status });
      this.hub.admin('despawn', { id: a.id, reason: status });
    }
  }

  // Terminazione manuale dalla dashboard.
  cancelSpawn() {
    const a = activeSpawn(this.db);
    if (!a) return false;
    if (!endSpawn(this.db, a.id, 'cancelled')) return false;
    clearTimeout(this.expiryTimer);
    this.hub.overlay('despawn', { id: a.id, reason: 'cancelled' });
    this.hub.admin('despawn', { id: a.id, reason: 'cancelled' });
    this.scheduleNext();
    return true;
  }

  // --- Catture ---------------------------------------------------------------
  attempt({ redemptionId, rewardId, ballTypeId, user, redeemedAt, isDemo = false, source = 'eventsub' }) {
    const cfg = this.cfg();
    const res = processAttempt(this.db, cfg, {
      redemptionId, rewardId, ballTypeId, user, redeemedAt, isDemo, source,
      accepting: this.accepting(isDemo),
      sessionId: this.session?.id ?? null,
    }, this.rng);
    if (res.duplicate || res.ignored) return res;

    if (res.rejected) {
      this.log.info(`Tentativo rifiutato (${res.reason}) da ${res.user.display_name}`);
      this.hub.admin('attempt', { rejected: true, reason: res.reason, user: res.user.display_name });
      this.emit('attempt', res);
      return res;
    }

    const notif = {
      spawnId: res.spawnId,
      user: res.user.display_name,
      ball: { name: res.ball.name, code: res.ball.code, color: res.ball.color },
      caught: res.caught,
      pokemon: res.pokemon,
      probability: res.probability,
      fled: res.spawnEnded === 'fled',
    };
    const sp = getSpawn(this.db, res.spawnId);
    this.hub.overlay('throw', { ...notif, attempts: sp.attempts });
    this.hub.admin('attempt', notif);
    this.log.info(`${res.user.display_name} lancia ${res.ball.name}: ${res.caught ? 'CATTURATO' : 'fallito'} (p=${res.probability.toFixed(2)})`);

    if (res.spawnEnded) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
      this.hub.overlay('despawn', { id: res.spawnId, reason: res.spawnEnded, by: res.caught ? res.user.display_name : null });
      this.hub.admin('despawn', { id: res.spawnId, reason: res.spawnEnded });
      this.scheduleNext();
    }
    this.emit('attempt', res);
    this.emitStatus();
    return res;
  }

  redemptionUpdated({ redemptionId, status }) {
    const r = handleRedemptionUpdate(this.db, this.cfg(), { redemptionId, status });
    if (r.revoked) this.log.info(`Cattura revocata per riscossione annullata ${redemptionId}`);
    return r;
  }

  // --- Stato -----------------------------------------------------------------
  status() {
    const sp = activeSpawn(this.db);
    const session = this.session ? this.sessions.byId(this.session.id) : null;
    return {
      mode: this.mode,
      running: this.running,
      suspended: this.suspended,
      session,
      activeSpawn: publicSpawn(sp),
      nextSpawnAt: this.nextSpawnAt,
      spawnEnabled: this.cfg().spawn.enabled,
      lastError: this.lastError,
    };
  }

  overlaySnapshot() {
    const sp = this.running ? activeSpawn(this.db) : null;
    return { active: this.running, demo: this.mode === 'demo', spawn: publicSpawn(sp) };
  }

  emitStatus() {
    this.emit('status');
  }

  shutdown() {
    this.clearTimers();
  }
}
