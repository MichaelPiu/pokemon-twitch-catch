// Macchina a stati esplicita del ciclo di vita LIVE/OFFLINE.
// Tutte le transizioni avvengono lato backend e vengono registrate.
import { EventEmitter } from 'node:events';

export const STATES = Object.freeze({
  OFFLINE: 'OFFLINE',
  CONNECTING: 'CONNECTING',
  LIVE: 'LIVE',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
});

const ALLOWED = {
  OFFLINE: ['CONNECTING', 'LIVE', 'ERROR'],
  CONNECTING: ['OFFLINE', 'LIVE', 'ERROR'],
  LIVE: ['PAUSED', 'OFFLINE', 'ERROR'],
  PAUSED: ['LIVE', 'OFFLINE', 'ERROR'],
  ERROR: ['CONNECTING', 'OFFLINE'],
};

export class StateMachine extends EventEmitter {
  constructor({ db, log, initial = STATES.OFFLINE }) {
    super();
    this.db = db;
    this.log = log;
    this.state = initial;
    this.reason = 'startup';
    this.since = new Date().toISOString();
    this.history = [];
  }

  can(to) { return ALLOWED[this.state]?.includes(to); }

  // Ritorna true se la transizione è avvenuta. Le transizioni non ammesse
  // vengono ignorate (e registrate nel log) senza lanciare eccezioni.
  transition(to, reason = '') {
    if (to === this.state) return false;
    if (!this.can(to)) {
      this.log.warn(`Transizione non ammessa ${this.state} → ${to}`, { reason });
      return false;
    }
    const from = this.state;
    this.state = to;
    this.reason = reason;
    this.since = new Date().toISOString();
    const entry = { from, to, reason, at: this.since };
    this.history.push(entry);
    if (this.history.length > 100) this.history.shift();
    try {
      this.db.run('INSERT INTO state_transitions (from_state, to_state, reason) VALUES (?, ?, ?)', from, to, reason);
    } catch { /* il log delle transizioni non deve bloccare */ }
    this.log.info(`Stato: ${from} → ${to}${reason ? ` (${reason})` : ''}`);
    this.emit('transition', entry);
    return true;
  }

  // Forza uno stato attraversando gli stati intermedi ammessi (es. ERROR → CONNECTING → OFFLINE).
  goTo(to, reason) {
    if (to === this.state) return false;
    if (this.can(to)) return this.transition(to, reason);
    if (this.can('CONNECTING') && ALLOWED.CONNECTING.includes(to)) {
      this.transition('CONNECTING', reason);
      return this.transition(to, reason);
    }
    if (this.can('OFFLINE') && ALLOWED.OFFLINE.includes(to)) {
      this.transition('OFFLINE', reason);
      return this.transition(to, reason);
    }
    return this.transition(to, reason);
  }

  snapshot() { return { state: this.state, reason: this.reason, since: this.since }; }
}
