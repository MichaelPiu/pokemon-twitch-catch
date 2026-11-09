import { imageUrl } from '../spawn/spawn.js';
// Statistiche: tutte le query escludono i dati DEMO e contano solo eventi
// avvenuti all'interno di sessioni LIVE.
const PERIODS = {
  day: { fmt: '%Y-%m-%d', defaultBack: 30 },
  week: { fmt: '%Y-W%W', defaultBack: 26 * 7 },
  month: { fmt: '%Y-%m', defaultBack: 365 },
};

export function periodStats(db, period = 'day', { days } = {}) {
  const p = PERIODS[period] || PERIODS.day;
  const since = new Date(Date.now() - (days || p.defaultBack) * 86400000).toISOString();
  const attempts = db.all(
    `SELECT strftime('${p.fmt}', created_at, 'localtime') AS bucket,
            COUNT(*) AS attempts, SUM(outcome = 'caught') AS captures, SUM(outcome = 'failed') AS failures,
            COUNT(DISTINCT user_id) AS participants
     FROM capture_attempts WHERE is_demo = 0 AND outcome != 'rejected' AND created_at >= ? GROUP BY bucket ORDER BY bucket`, since);
  const spawns = db.all(
    `SELECT strftime('${p.fmt}', started_at, 'localtime') AS bucket, COUNT(*) AS spawns, SUM(is_shiny) AS shiny
     FROM spawn_history WHERE is_demo = 0 AND started_at >= ? GROUP BY bucket`, since);
  const sessions = db.all(
    `SELECT strftime('${p.fmt}', started_at, 'localtime') AS bucket, COUNT(*) AS sessions, SUM(COALESCE(duration_s, 0)) AS duration
     FROM stream_sessions WHERE is_demo = 0 AND started_at >= ? GROUP BY bucket`, since);
  const map = new Map();
  const get = (b) => { if (!map.has(b)) map.set(b, { bucket: b, attempts: 0, captures: 0, failures: 0, participants: 0, spawns: 0, shiny: 0, sessions: 0, duration: 0 }); return map.get(b); };
  for (const r of attempts) Object.assign(get(r.bucket), { attempts: r.attempts, captures: r.captures, failures: r.failures, participants: r.participants });
  for (const r of spawns) Object.assign(get(r.bucket), { spawns: r.spawns, shiny: r.shiny });
  for (const r of sessions) Object.assign(get(r.bucket), { sessions: r.sessions, duration: r.duration });
  return [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export function totals(db, { sessionId = null } = {}) {
  // Con una sessione specifica il filtro DEMO è implicito nella sessione stessa.
  const w = sessionId ? 'session_id = ?' : 'is_demo = 0';
  const args = sessionId ? [sessionId] : [];
  const a = db.get(
    `SELECT COUNT(*) AS attempts, COALESCE(SUM(outcome = 'caught'), 0) AS captures, COALESCE(SUM(outcome = 'failed'), 0) AS failures,
            COUNT(DISTINCT user_id) AS participants
     FROM capture_attempts WHERE ${w} AND outcome != 'rejected'`, ...args);
  const s = db.get(`SELECT COUNT(*) AS spawns, COALESCE(SUM(is_shiny), 0) AS shiny FROM spawn_history WHERE ${w}`, ...args);
  const extra = sessionId ? {} : {
    sessions: db.get('SELECT COUNT(*) AS n FROM stream_sessions WHERE is_demo = 0').n,
    users: db.get('SELECT COUNT(*) AS n FROM twitch_users WHERE is_demo = 0').n,
    owned: db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE is_demo = 0').n,
    liveSeconds: db.get('SELECT COALESCE(SUM(duration_s), 0) AS n FROM stream_sessions WHERE is_demo = 0').n,
  };
  return { ...a, ...s, successRate: a.attempts ? a.captures / a.attempts : 0, ...extra };
}

export function topLists(db, { sessionId = null, limit = 10 } = {}) {
  const w = sessionId ? 'AND s.session_id = ?' : '';
  const wa = sessionId ? 'AND a.session_id = ?' : '';
  const args = sessionId ? [sessionId, limit] : [limit];
  const name = "COALESCE(p.name_it, p.name)";
  return {
    mostSpawned: db.all(
      `SELECT p.id, ${name} AS name, p.dex_number AS dex, COUNT(*) AS n FROM spawn_history s JOIN pokemon p ON p.id = s.pokemon_id
       WHERE s.is_demo = 0 ${w} GROUP BY p.id ORDER BY n DESC LIMIT ?`, ...args),
    mostCaught: db.all(
      `SELECT p.id, ${name} AS name, p.dex_number AS dex, COUNT(*) AS n FROM capture_attempts a JOIN spawn_history s ON s.id = a.spawn_id
       JOIN pokemon p ON p.id = s.pokemon_id WHERE a.is_demo = 0 AND a.outcome = 'caught' ${wa} GROUP BY p.id ORDER BY n DESC LIMIT ?`, ...args),
    hardest: db.all(
      `SELECT p.id, ${name} AS name, p.dex_number AS dex, COUNT(*) AS attempts, SUM(a.outcome = 'caught') AS captures,
              1.0 * SUM(a.outcome = 'caught') / COUNT(*) AS rate
       FROM capture_attempts a JOIN spawn_history s ON s.id = a.spawn_id JOIN pokemon p ON p.id = s.pokemon_id
       WHERE a.is_demo = 0 AND a.outcome != 'rejected' ${wa} GROUP BY p.id HAVING attempts >= 3 ORDER BY rate ASC, attempts DESC LIMIT ?`, ...args),
    activeUsers: db.all(
      `SELECT u.id, u.display_name AS name, COUNT(*) AS attempts, SUM(a.outcome = 'caught') AS captures
       FROM capture_attempts a JOIN twitch_users u ON u.id = a.user_id
       WHERE a.is_demo = 0 AND a.outcome != 'rejected' ${wa} GROUP BY u.id ORDER BY attempts DESC LIMIT ?`, ...args),
    balls: db.all(
      `SELECT b.id, b.name, b.color, COUNT(*) AS used, SUM(a.outcome = 'caught') AS captures
       FROM capture_attempts a JOIN ball_types b ON b.id = a.ball_type_id
       WHERE a.is_demo = 0 AND a.outcome != 'rejected' ${wa} GROUP BY b.id ORDER BY used DESC LIMIT ?`, ...args),
    shiny: db.all(
      `SELECT s.id, ${name} AS name, p.dex_number AS dex, s.started_at, s.status, u.display_name AS caught_by
       FROM spawn_history s JOIN pokemon p ON p.id = s.pokemon_id LEFT JOIN twitch_users u ON u.id = s.caught_by_user_id
       WHERE s.is_demo = 0 AND s.is_shiny = 1 ${w} ORDER BY s.started_at DESC LIMIT ?`, ...args),
  };
}

export function recentCaptures(db, { limit = 10, isDemo = false } = {}) {
  return db.all(
    `SELECT up.id, up.caught_at, up.is_shiny, up.ball_name, u.display_name AS user, COALESCE(p.name_it, p.name) AS name, p.dex_number AS dex, p.rarity,
            p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url, b.color AS ball_color
     FROM user_pokemon up JOIN twitch_users u ON u.id = up.user_id JOIN pokemon p ON p.id = up.pokemon_id
     LEFT JOIN ball_types b ON b.id = up.ball_type_id
     WHERE up.is_demo = ? AND up.source = 'capture' ORDER BY up.caught_at DESC, up.id DESC LIMIT ?`, isDemo ? 1 : 0, limit,
  ).map((r) => ({ ...r, image: imageUrl(r, !!r.is_shiny) }));
}

// Serie cumulative minuto per minuto della sessione (tentativi, catture, partecipanti).
export function sessionTimeline(db, sessionId, { minutes = 30, now = Date.now() } = {}) {
  const session = db.get('SELECT * FROM stream_sessions WHERE id = ?', sessionId);
  if (!session) return { points: [] };
  const end = session.ended_at ? Date.parse(session.ended_at) : now;
  const startSession = Date.parse(session.started_at);
  const start = minutes > 0 ? Math.max(startSession, end - minutes * 60000) : startSession;
  const rows = db.all(
    "SELECT user_id, outcome, created_at FROM capture_attempts WHERE session_id = ? AND outcome != 'rejected' ORDER BY created_at", sessionId);
  const span = Math.max(60000, end - start);
  const step = Math.max(60000, Math.ceil(span / 60 / 60000) * 60000); // al massimo ~60 punti
  const points = [];
  let i = 0, attempts = 0, captures = 0;
  const users = new Set();
  for (let t = start; ; t += step) {
    const tt = Math.min(t, end);
    while (i < rows.length && Date.parse(rows[i].created_at) <= tt) {
      attempts++;
      if (rows[i].outcome === 'caught') captures++;
      users.add(rows[i].user_id);
      i++;
    }
    points.push({ t: new Date(tt).toISOString(), attempts, captures, participants: users.size });
    if (tt >= end) break;
  }
  return { sessionId, start: new Date(start).toISOString(), end: new Date(end).toISOString(), points };
}

// Feed "Attività recente": spawn, catture, shiny, comandi chat, transizioni LIVE/OFFLINE.
export function activityFeed(db, { limit = 12, isDemo = false } = {}) {
  const d = isDemo ? 1 : 0;
  const items = [];
  for (const r of db.all(
    `SELECT s.started_at AS at, s.is_shiny, COALESCE(p.name_it, p.name) AS name FROM spawn_history s JOIN pokemon p ON p.id = s.pokemon_id
     WHERE s.is_demo = ? ORDER BY s.id DESC LIMIT ?`, d, limit)) {
    items.push({ at: r.at, kind: r.is_shiny ? 'shiny' : 'spawn', text: r.is_shiny ? `È apparso un Pokémon Shiny! (${r.name})` : `${r.name} è apparso!` });
  }
  for (const r of db.all(
    `SELECT up.caught_at AS at, u.display_name AS user, COALESCE(p.name_it, p.name) AS name FROM user_pokemon up
     JOIN twitch_users u ON u.id = up.user_id JOIN pokemon p ON p.id = up.pokemon_id
     WHERE up.is_demo = ? AND up.source = 'capture' ORDER BY up.id DESC LIMIT ?`, d, limit)) {
    items.push({ at: r.at, kind: 'capture', text: `${r.user} ha catturato ${r.name}!` });
  }
  if (!isDemo) {
    for (const r of db.all("SELECT received_at AS at, detail, payload FROM twitch_events WHERE event_type = 'channel.chat.message' AND detail LIKE 'comando %' ORDER BY id DESC LIMIT ?", limit)) {
      let user = '';
      try { user = JSON.parse(r.payload || '{}').chatter_user_name || ''; } catch { /* ignora */ }
      items.push({ at: r.at, kind: 'command', text: `Comando !${r.detail.replace('comando ', '')}${user ? ` da ${user}` : ''}` });
    }
    for (const r of db.all("SELECT created_at AS at, from_state, to_state FROM state_transitions WHERE to_state IN ('LIVE','OFFLINE','PAUSED') ORDER BY id DESC LIMIT ?", limit)) {
      const text = { LIVE: 'Motore di gioco attivato (LIVE)', OFFLINE: 'Motore di gioco fermato (OFFLINE)', PAUSED: 'Gioco in pausa (connessione Twitch persa)' }[r.to_state];
      items.push({ at: r.at, kind: r.to_state.toLowerCase(), text });
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export function sessionDetail(db, id) {
  const session = db.get('SELECT * FROM stream_sessions WHERE id = ?', id);
  if (!session) return null;
  const spawns = db.all(
    `SELECT s.id, s.started_at, s.ended_at, s.status, s.is_shiny, s.rarity, s.attempts, s.captures, s.source,
            COALESCE(p.name_it, p.name) AS name, p.dex_number AS dex, u.display_name AS caught_by
     FROM spawn_history s JOIN pokemon p ON p.id = s.pokemon_id LEFT JOIN twitch_users u ON u.id = s.caught_by_user_id
     WHERE s.session_id = ? ORDER BY s.started_at`, id);
  const leaderboard = db.all(
    `SELECT u.display_name AS name, COUNT(*) AS attempts, SUM(a.outcome = 'caught') AS captures
     FROM capture_attempts a JOIN twitch_users u ON u.id = a.user_id
     WHERE a.session_id = ? AND a.outcome != 'rejected' GROUP BY u.id ORDER BY captures DESC, attempts DESC LIMIT 20`, id);
  const rejected = db.all(
    `SELECT reject_reason AS reason, COUNT(*) AS n FROM capture_attempts WHERE session_id = ? AND outcome = 'rejected' GROUP BY reject_reason`, id);
  return { session, totals: totals(db, { sessionId: id }), top: topLists(db, { sessionId: id, limit: 5 }), spawns, leaderboard, rejected };
}
