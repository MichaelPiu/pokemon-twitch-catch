// Sessioni di gioco con contatori aggiornati in tempo reale. Tre tipi (kind):
//   twitch — una per diretta Twitch;
//   manual — avviata dalla dashboard senza Twitch, con dati reali (Pokédex e statistiche);
//   demo   — prova separata, dati marcati is_demo e mai mescolati con quelli reali.
// Il database ammette una sola sessione aperta per is_demo: una sessione manuale
// e una diretta Twitch non possono quindi essere aperte contemporaneamente.
import { nowIso } from '../database/index.js';

export const SESSION_KINDS = Object.freeze(['twitch', 'manual', 'demo']);

// Compatibilità: current(false) = diretta Twitch, current(true) = DEMO.
const kindOf = (k) => (k === true ? 'demo' : k === false || k == null ? 'twitch' : k);

export class SessionService {
  constructor({ db, log }) {
    this.db = db;
    this.log = log;
  }

  open({ broadcastId = null, title = null, startedAt = null, isDemo = false, kind = null }) {
    const k = kindOf(kind ?? isDemo);
    if (!SESSION_KINDS.includes(k)) throw new Error(`Tipo di sessione non valido: ${k}`);
    return this.db.tx(() => {
      const existing = this.current(k);
      if (existing) {
        // Stessa diretta (es. dopo una disconnessione o un riavvio): riprende la sessione.
        if (k === 'twitch' && (!broadcastId || !existing.broadcast_id || existing.broadcast_id === broadcastId)) {
          if (broadcastId && !existing.broadcast_id) this.db.run('UPDATE stream_sessions SET broadcast_id = ? WHERE id = ?', broadcastId, existing.id);
          return { session: this.byId(existing.id), resumed: true };
        }
        if (k !== 'twitch') return { session: existing, resumed: true };
        this.close(existing.id, 'new_broadcast');
      }
      // Un'altra sessione dello stesso gruppo (reale) ancora aperta bloccherebbe l'indice
      // univoco: il chiamante deve chiuderla prima (vedi GameEngine), qui lo verifichiamo.
      const other = this.db.get('SELECT * FROM stream_sessions WHERE ended_at IS NULL AND is_demo = ? LIMIT 1', k === 'demo' ? 1 : 0);
      if (other) throw new Error(`Sessione #${other.id} (${other.kind}) ancora aperta`);
      const r = this.db.run(
        'INSERT INTO stream_sessions (broadcast_id, title, started_at, is_demo, kind) VALUES (?, ?, ?, ?, ?)',
        k === 'twitch' ? broadcastId : null, title, startedAt || nowIso(), k === 'demo' ? 1 : 0, k,
      );
      this.log.info(`Nuova sessione ${k.toUpperCase()} #${r.lastInsertRowid}`, { broadcastId: k === 'twitch' ? broadcastId : null });
      return { session: this.byId(Number(r.lastInsertRowid)), resumed: false };
    });
  }

  current(kind = 'twitch') {
    return this.db.get('SELECT * FROM stream_sessions WHERE ended_at IS NULL AND kind = ? ORDER BY id DESC LIMIT 1', kindOf(kind)) || null;
  }

  byId(id) { return this.db.get('SELECT * FROM stream_sessions WHERE id = ?', id) || null; }

  refreshCounters(id) {
    this.db.run(`UPDATE stream_sessions SET
      spawns = (SELECT COUNT(*) FROM spawn_history WHERE session_id = ?1),
      shiny_spawns = (SELECT COUNT(*) FROM spawn_history WHERE session_id = ?1 AND is_shiny = 1),
      attempts = (SELECT COUNT(*) FROM capture_attempts WHERE session_id = ?1 AND outcome != 'rejected'),
      captures = (SELECT COUNT(*) FROM capture_attempts WHERE session_id = ?1 AND outcome = 'caught'),
      failures = (SELECT COUNT(*) FROM capture_attempts WHERE session_id = ?1 AND outcome = 'failed'),
      participants = (SELECT COUNT(DISTINCT user_id) FROM capture_attempts WHERE session_id = ?1 AND outcome != 'rejected')
      WHERE id = ?1`, id);
  }

  // Errore registrato sulla sessione (es. nessun Pokémon disponibile): non la interrompe.
  recordError(id, message) {
    if (!id) return;
    this.db.run('UPDATE stream_sessions SET errors = errors + 1, last_error = ? WHERE id = ?', String(message).slice(0, 300), id);
  }

  close(id, reason = 'stream_offline', endedAt = null) {
    return this.db.tx(() => {
      const s = this.byId(id);
      if (!s || s.ended_at) return s;
      const end = endedAt || nowIso();
      const duration = Math.max(0, Math.round((Date.parse(end) - Date.parse(s.started_at)) / 1000));
      this.refreshCounters(id);
      this.db.run('UPDATE stream_sessions SET ended_at = ?, duration_s = ?, end_reason = ? WHERE id = ?', end, duration, reason, id);
      this.log.info(`Sessione #${id} chiusa (${reason})`, { durationS: duration });
      return this.byId(id);
    });
  }

  // Al riavvio: le sessioni DEMO e MANUALI rimaste aperte vengono chiuse come
  // interrotte (i dati già registrati restano). La diretta Twitch invece viene
  // ripresa o chiusa dal monitor in base allo stato reale del canale.
  closeStale(reason = 'restart') {
    const closed = [];
    for (const k of ['demo', 'manual']) {
      const s = this.current(k);
      if (s) closed.push(this.close(s.id, reason));
    }
    return closed;
  }

  closeStaleDemo() { return this.closeStale(); }
}
