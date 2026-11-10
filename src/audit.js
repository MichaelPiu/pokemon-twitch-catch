// Registro delle operazioni amministrative (tabella admin_audit): chi, quando,
// cosa è cambiato. I dettagli vengono ripuliti da qualsiasi campo che possa
// contenere segreti, e un errore di scrittura del registro non blocca mai
// l'operazione principale.
const SECRET_KEY = /pass|secret|token|cookie|csrf|key|authorization/i;

function scrub(v, depth = 0) {
  if (v == null || typeof v !== 'object') return typeof v === 'string' ? v.slice(0, 500) : v;
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[omesso]' : scrub(x, depth + 1);
  return out;
}

export function audit(db, { admin = null, action, targetType = null, targetId = null, detail = null }, log = null) {
  try {
    db.run('INSERT INTO admin_audit (admin, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)',
      admin, action, targetType, targetId == null ? null : String(targetId), detail == null ? null : JSON.stringify(scrub(detail)));
  } catch (e) {
    log?.warn('Registro operazioni non aggiornato', { action, message: e.message });
  }
}

export function auditList(db, { limit = 100, targetType = null, targetId = null } = {}) {
  const where = [];
  const args = [];
  if (targetType) { where.push('target_type = ?'); args.push(targetType); }
  if (targetId != null) { where.push('target_id = ?'); args.push(String(targetId)); }
  return db.all(`SELECT * FROM admin_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...args, limit)
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
