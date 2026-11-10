// Lettore degli effetti sonori della Browser Source /overlay/audio.
// Indipendente dal DOM (testabile in Node): riceve gli eventi "play" del canale
// WebSocket audio e li riproduce con HTML5 Audio.
//
// Garanzie:
// - ogni evento (ID univoco dal server) suona al massimo una volta, anche se
//   arriva di nuovo (messaggio ripetuto, riconnessione);
// - eventi vecchi (es. consegnati in ritardo dopo una riconnessione) vengono
//   scartati: conta l'ora del server, non quella del PC di OBS;
// - solo URL della whitelist del server (/audio/<id>.<ext>);
// - un errore di caricamento o di riproduzione viene registrato e basta.

export const MAX_AGE_MS = 10000; // oltre questo ritardo un evento non suona più
const MAX_SEEN = 500;
const MAX_PLAYING = 4;
const FADE_MS = 600;
const URL_OK = /^\/audio\/[a-f0-9]{16}\.[a-z0-9]{2,4}(\?v=\d+)?$/;

export class AudioPlayer {
  constructor({ AudioCtor = globalThis.Audio, now = () => Date.now(), timers = globalThis, onChange = () => {} } = {}) {
    this.AudioCtor = AudioCtor;
    this.now = now;
    this.timers = timers;
    this.onChange = onChange;
    this.offset = 0; // ora del server - ora locale
    this.settings = null;
    this.seen = new Set();
    this.playing = new Set();
    this.stats = { received: 0, played: 0, duplicates: 0, stale: 0, invalid: 0, errors: 0, blocked: 0 };
    this.log = []; // ultimi eventi (diagnostica)
    this.lastError = null;
  }

  // Messaggio "snapshot" (connessione o riconnessione): solo impostazioni e ora
  // del server; nessun evento passato da riprodurre.
  snapshot(data, serverTs) {
    if (Number.isFinite(serverTs)) this.offset = serverTs - this.now();
    if (data?.settings) this.settings = data.settings;
    this.onChange();
  }

  setSettings(s) { if (s) this.settings = s; this.onChange(); }

  serverNow() { return this.now() + this.offset; }

  remember(id) {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value);
  }

  note(ev, outcome, detail = null) {
    this.log.unshift({ id: ev?.id ?? null, kind: ev?.kind ?? null, name: ev?.name ?? null, outcome, detail, at: this.now() });
    this.log.length = Math.min(this.log.length, 20);
    this.onChange();
  }

  // Evento "play" dal server. Ritorna l'esito (per test e diagnostica).
  handle(ev) {
    this.stats.received++;
    if (!ev || typeof ev.id !== 'string' || typeof ev.url !== 'string' || !URL_OK.test(ev.url)) {
      this.stats.invalid++; this.note(ev, 'invalid'); return 'invalid';
    }
    if (this.seen.has(ev.id)) { this.stats.duplicates++; return 'duplicate'; }
    this.remember(ev.id);
    const age = this.serverNow() - Number(ev.at);
    if (!Number.isFinite(age) || age > MAX_AGE_MS) { this.stats.stale++; this.note(ev, 'stale', `${Math.round(age / 1000)} s`); return 'stale'; }
    return this.play(ev);
  }

  play(ev) {
    if (!this.AudioCtor) { this.stats.errors++; this.note(ev, 'error', 'HTML5 Audio non disponibile'); return 'error'; }
    if (this.playing.size >= MAX_PLAYING) this.stop([...this.playing][0]);
    let a;
    try {
      a = new this.AudioCtor(ev.url);
      a.preload = 'auto';
      a.volume = Math.min(1, Math.max(0, Number(ev.volume ?? 70) / 100));
    } catch (e) {
      this.fail(ev, e); return 'error';
    }
    const done = () => this.playing.delete(a);
    a.onended = done;
    a.onerror = () => { done(); this.fail(ev, new Error(`file non caricato (${a.error?.code ?? '?'})`)); };
    this.playing.add(a);
    let p;
    try { p = a.play(); } catch (e) { done(); this.fail(ev, e); return 'error'; }
    if (p && typeof p.then === 'function') {
      p.then(() => {}, (e) => { done(); this.fail(ev, e); });
    }
    const max = Number(ev.maxDurationS) || 0;
    if (max > 0) this.timers.setTimeout(() => this.fadeOut(a), max * 1000);
    this.stats.played++;
    this.note(ev, 'played');
    return 'played';
  }

  fail(ev, e) {
    const blocked = e?.name === 'NotAllowedError';
    if (blocked) this.stats.blocked++; else this.stats.errors++;
    this.lastError = { id: ev?.id, name: ev?.name, message: blocked ? 'riproduzione bloccata dal browser (autoplay)' : String(e?.message || e), blocked };
    this.note(ev, blocked ? 'blocked' : 'error', this.lastError.message);
  }

  fadeOut(a) {
    if (!this.playing.has(a)) return;
    const start = a.volume;
    const steps = 6;
    let i = 0;
    const tick = () => {
      i++;
      a.volume = Math.max(0, start * (1 - i / steps));
      if (i < steps) this.timers.setTimeout(tick, FADE_MS / steps);
      else this.stop(a);
    };
    tick();
  }

  stop(a) {
    try { a.pause(); } catch { /* ignora */ }
    this.playing.delete(a);
  }

  state() {
    return { settings: this.settings, offsetMs: this.offset, playing: this.playing.size, stats: { ...this.stats }, lastError: this.lastError, log: this.log.slice(0, 10) };
  }
}
