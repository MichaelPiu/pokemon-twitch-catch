// Coda degli eventi animati dell'overlay (spawn, lanci, fughe).
//
// Gli eventi vengono eseguiti in ordine, uno alla volta, per non sovrapporre le
// animazioni. Per evitare che una raffica di riscatti accumuli ritardo:
//  - "normal": nessun arretrato, animazioni alla velocità del tema;
//  - "fast": arretrato ≥ metà del limite, animazioni 3 volte più rapide;
//  - "instant": arretrato ≥ limite, nessuna attesa (lo stato e le notifiche
//    vengono comunque aggiornati: nessun evento viene scartato).
// Ogni evento ha un tempo massimo: un'animazione bloccata non ferma la coda.
// Il modulo non dipende dal DOM: viene usato dall'overlay e dai test.

export const MODES = { normal: 1, fast: 3, instant: Infinity };

export class EventQueue {
  constructor({ limit = 6, jobTimeoutMs = 8000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.limit = Math.max(1, Math.floor(limit));
    this.jobTimeoutMs = jobTimeoutMs;
    // Chiamati sempre come funzioni libere: nel browser setTimeout/clearTimeout
    // invocati come metodi di un altro oggetto danno "Illegal invocation".
    this.setTimer = (fn, ms) => setTimer(fn, ms);
    this.clearTimer = (t) => clearTimer(t);
    this.jobs = [];
    this.running = false;
    this.stats = { processed: 0, fast: 0, instant: 0, timeouts: 0, errors: 0, maxBacklog: 0 };
    this.idleWaiters = [];
  }

  get size() { return this.jobs.length; }
  get busy() { return this.running || this.jobs.length > 0; }

  setLimit(n) { this.limit = Math.max(1, Math.floor(Number(n) || 6)); }

  modeFor(backlog) {
    if (backlog >= this.limit) return 'instant';
    if (backlog >= Math.ceil(this.limit / 2)) return 'fast';
    return 'normal';
  }

  // job: async (ctx) => {}, ctx = { mode, wait(ms) }. meta: { sim, important }.
  push(job, meta = {}) {
    this.jobs.push({ job, ...meta });
    this.stats.maxBacklog = Math.max(this.stats.maxBacklog, this.jobs.length);
    this.drain();
  }

  // Rimuove gli eventi in attesa (tutti o quelli che soddisfano il filtro).
  clear(filter = null) {
    const before = this.jobs.length;
    this.jobs = filter ? this.jobs.filter((j) => !filter(j)) : [];
    return before - this.jobs.length;
  }

  whenIdle() { return this.busy ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve(); }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const item = this.jobs.shift();
        const mode = this.modeFor(this.jobs.length);
        if (mode !== 'normal') this.stats[mode]++;
        const factor = MODES[mode];
        const ctx = {
          mode,
          wait: (ms) => (factor === Infinity || ms <= 0 ? Promise.resolve() : new Promise((r) => this.setTimer(r, ms / factor))),
        };
        let timer;
        const timeout = new Promise((r) => { timer = this.setTimer(() => { this.stats.timeouts++; r(); }, this.jobTimeoutMs); });
        try {
          await Promise.race([Promise.resolve().then(() => item.job(ctx)), timeout]);
        } catch {
          this.stats.errors++;
        } finally {
          this.clearTimer(timer);
        }
        this.stats.processed++;
      }
    } finally {
      this.running = false;
      const w = this.idleWaiters.splice(0);
      for (const r of w) r();
    }
  }
}
