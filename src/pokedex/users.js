// Spettatori Twitch, identificati dall'ID Twitch univoco (il nome può cambiare).
import { nowIso } from '../database/index.js';

// origin: 'twitch' (spettatore reale), 'local' (giocatore delle sessioni manuali,
// twitch_id con prefisso "local:"), 'demo'. L'origine non cambia dopo la creazione.
export function upsertUser(db, { twitchId, login, displayName, isDemo = false, origin = null }) {
  const now = nowIso();
  const lg = String(login || '').toLowerCase();
  const dn = displayName || login || twitchId;
  const org = isDemo ? 'demo' : origin || (String(twitchId).startsWith('local:') ? 'local' : 'twitch');
  // Cambio di nickname su Twitch: stesso profilo (stesso Twitch User ID), il nome
  // precedente resta nello storico dei nomi.
  const prev = db.get('SELECT id, login, display_name, origin, last_seen_at FROM twitch_users WHERE twitch_id = ?', String(twitchId));
  if (prev && prev.origin === 'twitch' && (prev.display_name !== dn || prev.login !== lg)) {
    db.run("INSERT INTO player_aliases (user_id, kind, login, display_name, last_seen_at) VALUES (?, 'twitch', ?, ?, ?)",
      prev.id, prev.login, prev.display_name, now);
  }
  db.run(
    `INSERT INTO twitch_users (twitch_id, login, display_name, is_demo, first_seen_at, last_seen_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET login = excluded.login, display_name = excluded.display_name, last_seen_at = excluded.last_seen_at`,
    String(twitchId), lg, dn, isDemo ? 1 : 0, now, now, org,
  );
  return db.get('SELECT * FROM twitch_users WHERE twitch_id = ?', String(twitchId));
}

export function findUserByLogin(db, login, { includeDemo = false } = {}) {
  const lg = String(login || '').replace(/^@/, '').toLowerCase();
  return db.get(
    `SELECT * FROM twitch_users WHERE login = ? ${includeDemo ? '' : 'AND is_demo = 0'} ORDER BY last_seen_at DESC LIMIT 1`, lg,
  ) || null;
}

export function isBanned(db, userId) {
  const ban = db.get(
    `SELECT * FROM user_bans WHERE user_id = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    userId, nowIso(),
  );
  return ban || null;
}
