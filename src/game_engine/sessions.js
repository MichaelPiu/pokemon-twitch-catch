// Sessioni LIVE: una per diretta, con contatori aggiornati in tempo reale.
import { nowIso } from '../database/index.js';

export class SessionService {
  constructor({ db, log }) {
    this.db = db;
    this.log = log;
  }

  open({ broadcastId = null, title = null, startedAt = null, isDemo = false }) {
    return this.db.tx(() => {
      const existing = this.current(isDemo);
      if (existing) {
        // Stessa diretta (es. dopo una disconnessione o un riavvio): riprende la sessione.
        if (!broadcastId || !existing.broadcast_id || existing.broadcast_id === broadcastId) {
          if (broadcastId && !existing.broadcast_id) this.db.run('UPDATE stream_sessions SET broadcast_id = ? WHERE id = ?', broadcastId, existing.id);
          return { session: this.byId(existing.id), resumed: true };
        }
        this.close(existing.id, 'new_broadcast');
      }
      const r = this.db.run(
        'INSERT INTO stream_sessions (broadcast_id, title, started_at, is_demo) VALUES (?, ?, ?, ?)',
        broadcastId, title, startedAt || nowIso(), isDemo ? 1 : 0,
      );
      this.log.info(`Nuova sessione ${isDemo ? 'DEMO' : 'LIVE'} #${r.lastInsertRowid}`, { broadcastId });
      return { session: this.byId(Number(r.lastInsertRowid)), resumed: false };
    });
  }

  current(isDemo = false) {
    return this.db.get('SELECT * FROM stream_sessions WHERE ended_at IS NULL AND is_demo = ? ORDER BY id DESC LIMIT 1', isDemo ? 1 : 0) || null;
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

  // Al riavvio: la sessione demo eventualmente aperta viene chiusa.
  closeStaleDemo() {
    const d = this.current(true);
    if (d) this.close(d.id, 'restart');
  }
}
