// Classifiche di sessione, risultati congelati, schermate dell'overlay, Hall of
// Fame, riepiloghi (Stream Recap) e profili dei giocatori.
//
// Fonte dei dati: la tabella leaderboard_events, alimentata dal motore di gioco a
// ogni cattura riuscita (vedi scoring.js). Nessuna seconda copia delle catture:
// le classifiche live si calcolano dagli eventi; le istantanee congelate e i
// riepiloghi sono copie definitive, immutabili o rigenerate solo su richiesta.
//
// Sessioni: solo TWITCH e MANUAL, sempre distinte (ogni sessione ha la propria
// classifica; la Hall of Fame si filtra per tipo). Le sessioni DEMO non entrano mai.
import { EventEmitter } from 'node:events';
import { SettingsStore, nowIso } from '../database/index.js';
import { sha256 } from '../security/crypto.js';
import { imageUrl } from '../spawn/spawn.js';
import { audit } from '../audit.js';
import { currentRules, validateRules, RARITY_RANK_SQL, SCORING_RARITIES } from './scoring.js';

export const SCREENS = ['board', 'podium', 'winner', 'recap', 'halloffame'];
export const BOARDS = ['captures', 'points'];
export const HOF_KINDS = ['all', 'twitch', 'manual'];
export const LEADERBOARD_DEFAULTS = {
  commands: {
    allowModerators: true, // i moderatori possono usare !leaderboard (tranne freeze)
    moderatorIds: [], // vuoto = tutti i moderatori; altrimenti solo questi Twitch User ID
    replies: true, // risposte brevi in chat
  },
  display: { visible: false, screen: 'board', board: 'points', sessionId: null, hofKind: 'all', shownAt: null, shownBy: null, via: null, rev: 0 },
};

const err = (status, message) => Object.assign(new Error(message), { status });
const KIND_LABEL = { twitch: 'Diretta Twitch', manual: 'Sessione manuale' };
const nameSql = 'COALESCE(u.custom_name, u.display_name)';
const notBanned = 'u.id NOT IN (SELECT user_id FROM user_bans WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?))';

const pokemonView = (r) => (r && r.pokemon_id ? {
  pokemonId: r.pokemon_id, dex: r.dex_number, name: r.pname_it || r.pname, rarity: r.rarity, shiny: !!r.is_shiny,
  image: imageUrl({ image_file: r.image_file, shiny_image_file: r.shiny_image_file, image_url: r.image_url, shiny_image_url: r.shiny_image_url }, !!r.is_shiny),
} : null);

// Ordinamenti (a parità: chi ci è arrivato prima, poi l'ID del profilo).
const SORT = {
  captures: (a, b) => b.captures - a.captures || b.points - a.points || a.lastCaptureAt.localeCompare(b.lastCaptureAt) || a.userId - b.userId,
  points: (a, b) => b.points - a.points || b.captures - a.captures || a.lastCaptureAt.localeCompare(b.lastCaptureAt) || a.userId - b.userId,
};
const ranked = (rows, board) => [...rows].sort(SORT[board]).map((r, i) => ({ ...r, rank: i + 1 }));

export class LeaderboardService extends EventEmitter {
  constructor({ db, hub, log, timers = true, currentSession = () => null }) {
    super();
    this.db = db;
    this.hub = hub;
    this.log = log;
    this.timers = timers;
    this.currentSession = currentSession; // sessione TWITCH/MANUAL aperta nel motore, se c'è
    this.settings = new SettingsStore(db, 'leaderboard_settings', LEADERBOARD_DEFAULTS);
    this.pushTimer = null;
    this.stats = { unauthorized: 0, chatActions: 0 };
    this.recapExtras = null; // (sessione) => eventi automatici della sessione, aggiunti allo Stream Recap
  }

  // --- Regole di punteggio -----------------------------------------------------------
  rules() { return currentRules(this.db); }

  ruleHistory(limit = 20) {
    return this.db.all('SELECT * FROM leaderboard_rule_versions ORDER BY id DESC LIMIT ?', limit)
      .map((r) => ({ version: r.id, ...JSON.parse(r.rules), createdAt: r.created_at, createdBy: r.created_by }));
  }

  // Nuova versione delle regole (solo se cambiano davvero). Le catture già
  // registrate conservano i punti della versione con cui sono state assegnate.
  setRules(input, { admin = null } = {}) {
    const { rules, errors } = validateRules(input);
    if (errors.length) throw err(400, errors.join('; '));
    return this.db.tx(() => {
      const cur = this.rules();
      const same = cur.base === rules.base && cur.shiny === rules.shiny && SCORING_RARITIES.every((k) => cur.rarity[k] === rules.rarity[k]);
      if (same) return { changed: false, rules: cur };
      const r = this.db.run('INSERT INTO leaderboard_rule_versions (rules, created_by) VALUES (?, ?)', JSON.stringify(rules), admin);
      audit(this.db, { admin, action: 'leaderboard_rules_update', targetType: 'leaderboard_rules', targetId: Number(r.lastInsertRowid),
        detail: { from: { version: cur.version, base: cur.base, rarity: cur.rarity, shiny: cur.shiny }, to: rules } }, this.log);
      return { changed: true, rules: this.rules() };
    });
  }

  // --- Sessioni ------------------------------------------------------------------------
  session(id) {
    const s = this.db.get("SELECT * FROM stream_sessions WHERE id = ? AND is_demo = 0 AND kind IN ('twitch','manual')", id);
    if (!s) throw err(404, 'Sessione non trovata (le sessioni DEMO non hanno classifiche)');
    return s;
  }

  // "current" = la sessione TWITCH o MANUAL aperta adesso. Nessun ripiego su una
  // sessione precedente: senza sessione in corso la richiesta viene rifiutata.
  resolveSession(ref) {
    if (ref === 'current' || ref == null || ref === '') {
      const cur = this.currentSession();
      if (!cur) throw err(409, 'Nessuna sessione in corso: scegli una sessione precedente');
      return this.session(cur.id);
    }
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1) throw err(400, 'Sessione non valida');
    return this.session(n);
  }

  activeSnapshot(sessionId) {
    return this.db.get("SELECT * FROM leaderboard_snapshots WHERE session_id = ? AND status = 'active'", sessionId) || null;
  }

  sessionMeta(s) {
    const snap = this.activeSnapshot(s.id);
    const status = snap ? 'frozen' : s.ended_at ? 'final' : 'live';
    return {
      id: s.id, kind: s.kind, kindLabel: KIND_LABEL[s.kind], title: s.title, startedAt: s.started_at, endedAt: s.ended_at,
      open: !s.ended_at, status,
      frozen: snap ? { snapshotId: snap.id, version: snap.version, at: snap.created_at, by: snap.created_by, via: snap.created_via } : null,
    };
  }

  listSessions({ kind = null, limit = 50 } = {}) {
    const where = ["is_demo = 0", "kind IN ('twitch','manual')"];
    const args = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    return this.db.all(`SELECT * FROM stream_sessions WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`, ...args, limit)
      .map((s) => ({
        ...this.sessionMeta(s),
        participants: this.db.get('SELECT COUNT(DISTINCT user_id) AS n FROM leaderboard_events WHERE session_id = ? AND voided_at IS NULL', s.id).n,
        captures: this.db.get('SELECT COUNT(*) AS n FROM leaderboard_events WHERE session_id = ? AND voided_at IS NULL', s.id).n,
        hasRecap: !!this.db.get('SELECT 1 FROM stream_recaps WHERE session_id = ?', s.id),
      }));
  }

  // --- Classifica live (dagli eventi) --------------------------------------------------
  liveRows(sessionId) {
    const rows = this.db.all(
      `SELECT e.user_id, ${nameSql} AS name, u.origin, u.twitch_id, COUNT(*) AS captures, SUM(e.points) AS points,
              SUM(e.is_shiny) AS shiny, COUNT(DISTINCT e.pokemon_id) AS species, MAX(e.caught_at) AS last_at
       FROM leaderboard_events e JOIN twitch_users u ON u.id = e.user_id
       WHERE e.session_id = ? AND e.voided_at IS NULL AND ${notBanned}
       GROUP BY e.user_id`, sessionId, nowIso());
    const rarest = this.rarestByUser('e.session_id = ?', [sessionId]);
    return rows.map((r) => ({
      userId: r.user_id, name: r.name, origin: r.origin, captures: r.captures, points: r.points, shiny: r.shiny,
      species: r.species, lastCaptureAt: r.last_at, rarest: rarest.get(r.user_id) || null,
    }));
  }

  // Pokémon più raro di ogni giocatore (rarità, poi shiny, poi punti, poi il primo catturato).
  rarestByUser(where, args) {
    const rows = this.db.all(
      `SELECT * FROM (
         SELECT e.user_id, e.pokemon_id, e.is_shiny, e.rarity, p.dex_number, p.name AS pname, p.name_it AS pname_it,
                p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url,
                ROW_NUMBER() OVER (PARTITION BY e.user_id ORDER BY ${RARITY_RANK_SQL('e.rarity')} DESC, e.is_shiny DESC, e.points DESC, e.caught_at ASC, e.id ASC) AS rn
         FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id
         WHERE e.voided_at IS NULL AND ${where}) WHERE rn = 1`, ...args);
    return new Map(rows.map((r) => [r.user_id, pokemonView(r)]));
  }

  totals(sessionId) {
    const t = this.db.get(
      `SELECT COUNT(*) AS captures, COALESCE(SUM(points), 0) AS points, COALESCE(SUM(is_shiny), 0) AS shiny,
              COUNT(DISTINCT user_id) AS participants, COUNT(DISTINCT pokemon_id) AS species
       FROM leaderboard_events WHERE session_id = ? AND voided_at IS NULL`, sessionId);
    return t;
  }

  liveBoard(sessionId) {
    const rows = this.liveRows(sessionId);
    return { captures: ranked(rows, 'captures'), points: ranked(rows, 'points'), totals: this.totals(sessionId) };
  }

  // Classifica effettiva: l'istantanea congelata, se c'è, altrimenti quella live.
  view(ref, { limit = 100, player = null } = {}) {
    const s = typeof ref === 'object' && ref ? ref : this.resolveSession(ref);
    const meta = this.sessionMeta(s);
    let data;
    if (meta.frozen) {
      const snap = this.activeSnapshot(s.id);
      data = JSON.parse(snap.data);
      data.source = 'snapshot';
    } else {
      data = { ...this.liveBoard(s.id), source: 'live' };
    }
    const q = player ? String(player).toLowerCase() : null;
    const filt = (list) => (q ? list.filter((r) => r.name.toLowerCase().includes(q)) : list).slice(0, limit);
    return {
      session: meta, source: data.source, totals: data.totals, rulesVersion: data.rulesVersion ?? this.rules().version,
      captures: filt(data.captures), points: filt(data.points),
      pendingSinceFreeze: meta.frozen ? this.db.get('SELECT COUNT(*) AS n FROM leaderboard_events WHERE session_id = ? AND voided_at IS NULL AND id > ?',
        s.id, JSON.parse(this.activeSnapshot(s.id).data).lastEventId || 0).n : 0,
    };
  }

  // --- Congelamento ------------------------------------------------------------------
  freeze(ref, { admin = null, via = 'dashboard' } = {}) {
    const out = this.db.tx(() => {
      const s = this.resolveSession(ref);
      const existing = this.activeSnapshot(s.id);
      // Mai sovrascrivere un'istantanea congelata: prima va sbloccata esplicitamente.
      if (existing) throw err(409, `Risultati della sessione #${s.id} già congelati (versione ${existing.version}): sbloccali prima di congelarli di nuovo`);
      const board = this.liveBoard(s.id);
      const lastEventId = this.db.get('SELECT MAX(id) AS m FROM leaderboard_events WHERE session_id = ?', s.id).m || 0;
      const data = { ...board, rulesVersion: this.rules().version, frozenAt: nowIso(), lastEventId,
        session: { id: s.id, kind: s.kind, title: s.title, startedAt: s.started_at, endedAt: s.ended_at } };
      const json = JSON.stringify(data);
      const version = (this.db.get('SELECT MAX(version) AS v FROM leaderboard_snapshots WHERE session_id = ?', s.id).v || 0) + 1;
      const r = this.db.run(
        `INSERT INTO leaderboard_snapshots (session_id, session_kind, version, data, checksum, rules_version, created_by, created_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, s.id, s.kind, version, json, sha256(json), data.rulesVersion, admin, via);
      audit(this.db, { admin, action: 'leaderboard_freeze', targetType: 'session', targetId: s.id,
        detail: { via, snapshotId: Number(r.lastInsertRowid), version, participants: board.totals.participants, captures: board.totals.captures, top: board.points.slice(0, 3).map((x) => ({ name: x.name, points: x.points })) } }, this.log);
      return { sessionId: s.id, snapshotId: Number(r.lastInsertRowid), version };
    });
    this.changed(out.sessionId);
    return out;
  }

  unfreeze(ref, { admin = null, reason } = {}) {
    const why = String(reason || '').trim();
    if (why.length < 5 || why.length > 300) throw err(400, 'Indica la motivazione dello sblocco (da 5 a 300 caratteri)');
    const out = this.db.tx(() => {
      const s = this.resolveSession(ref);
      const snap = this.activeSnapshot(s.id);
      if (!snap) throw err(409, 'I risultati di questa sessione non sono congelati');
      const live = this.liveBoard(s.id);
      const frozen = JSON.parse(snap.data);
      const top = (b) => b.slice(0, 10).map((x) => `${x.userId}:${x.captures}:${x.points}`).join('|');
      this.db.run("UPDATE leaderboard_snapshots SET status = 'unlocked', unlocked_at = ?, unlocked_by = ?, unlock_reason = ? WHERE id = ? AND status = 'active'",
        nowIso(), admin, why, snap.id);
      audit(this.db, { admin, action: 'leaderboard_unfreeze', targetType: 'session', targetId: s.id,
        detail: { reason: why, snapshotId: snap.id, version: snap.version,
          changesSinceFreeze: { captures: live.totals.captures - frozen.totals.captures, points: live.totals.points - frozen.totals.points, rankingChanged: top(live.points) !== top(frozen.points) } } }, this.log);
      return { sessionId: s.id, snapshotId: snap.id, version: snap.version };
    });
    this.changed(out.sessionId);
    return out;
  }

  snapshots(sessionId) {
    return this.db.all('SELECT id, session_id, session_kind, version, status, checksum, rules_version, created_at, created_by, created_via, unlocked_at, unlocked_by, unlock_reason FROM leaderboard_snapshots WHERE session_id = ? ORDER BY version DESC', sessionId);
  }

  // Verifica che l'istantanea non sia stata alterata (checksum del contenuto).
  verifySnapshot(id) {
    const s = this.db.get('SELECT data, checksum FROM leaderboard_snapshots WHERE id = ?', id);
    return !!s && sha256(s.data) === s.checksum;
  }

  // --- Hall of Fame --------------------------------------------------------------------
  hallOfFame({ kind = 'all', limit = 10 } = {}) {
    if (!HOF_KINDS.includes(kind)) throw err(400, 'Filtro non valido: all, twitch o manual');
    const kw = kind === 'all' ? "e.session_kind IN ('twitch','manual')" : 'e.session_kind = ?';
    const ka = kind === 'all' ? [] : [kind];
    const rows = this.db.all(
      `SELECT e.user_id, ${nameSql} AS name, u.origin, COUNT(*) AS captures, SUM(e.points) AS points, SUM(e.is_shiny) AS shiny,
              COUNT(DISTINCT e.pokemon_id) AS species, MAX(e.caught_at) AS last_at
       FROM leaderboard_events e JOIN twitch_users u ON u.id = e.user_id
       WHERE e.voided_at IS NULL AND ${kw} AND ${notBanned} GROUP BY e.user_id`, ...ka, nowIso());
    const sessions = new Map(this.db.all(
      `SELECT a.user_id, COUNT(DISTINCT a.session_id) AS n FROM capture_attempts a JOIN stream_sessions ss ON ss.id = a.session_id
       WHERE a.outcome != 'rejected' AND a.is_demo = 0 AND ss.is_demo = 0 AND ${kind === 'all' ? "ss.kind IN ('twitch','manual')" : 'ss.kind = ?'}
       GROUP BY a.user_id`, ...ka).map((r) => [r.user_id, r.n]));
    const rarest = this.rarestByUser(kw, ka);
    const list = rows.map((r) => ({
      userId: r.user_id, name: r.name, origin: r.origin, captures: r.captures, points: r.points, shiny: r.shiny, species: r.species,
      sessions: sessions.get(r.user_id) || 0, lastCaptureAt: r.last_at, rarest: rarest.get(r.user_id) || null,
    }));
    const totals = this.db.get(
      `SELECT COUNT(*) AS captures, COALESCE(SUM(e.is_shiny), 0) AS shiny, COUNT(DISTINCT e.user_id) AS players, COUNT(DISTINCT e.session_id) AS sessions
       FROM leaderboard_events e WHERE e.voided_at IS NULL AND ${kw}`, ...ka);
    const rarestOverall = this.db.all(
      `SELECT e.user_id, ${nameSql} AS player, e.pokemon_id, e.is_shiny, e.rarity, e.caught_at, e.session_kind, p.dex_number, p.name AS pname, p.name_it AS pname_it,
              p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url
       FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id JOIN twitch_users u ON u.id = e.user_id
       WHERE e.voided_at IS NULL AND ${kw} AND ${notBanned}
       ORDER BY ${RARITY_RANK_SQL('e.rarity')} DESC, e.is_shiny DESC, e.caught_at ASC LIMIT 5`, ...ka, nowIso())
      .map((r) => ({ ...pokemonView(r), player: r.player, userId: r.user_id, caughtAt: r.caught_at, sessionKind: r.session_kind }));
    return {
      kind, totals, rarest: rarestOverall,
      byCaptures: ranked(list, 'captures').slice(0, limit),
      byPoints: ranked(list, 'points').slice(0, limit),
    };
  }

  // --- Stream Recap ------------------------------------------------------------------
  buildRecap(s) {
    const v = this.view(s, { limit: 10 });
    const ev = (sql, ...a) => this.db.get(sql, s.id, ...a);
    const captures = ev('SELECT COUNT(*) AS n FROM leaderboard_events WHERE session_id = ? AND voided_at IS NULL').n;
    const attempts = ev("SELECT COUNT(*) AS n FROM capture_attempts WHERE session_id = ? AND outcome != 'rejected'").n;
    const participants = ev("SELECT COUNT(DISTINCT user_id) AS n FROM capture_attempts WHERE session_id = ? AND outcome != 'rejected'").n;
    const encounters = ev('SELECT COUNT(*) AS n FROM spawn_history WHERE session_id = ?').n;
    const shinyEncounters = ev('SELECT COUNT(*) AS n FROM spawn_history WHERE session_id = ? AND is_shiny = 1').n;
    const shiny = ev('SELECT COUNT(*) AS n FROM leaderboard_events WHERE session_id = ? AND voided_at IS NULL AND is_shiny = 1').n;
    const pj = `JOIN pokemon p ON p.id = e.pokemon_id`;
    const pcols = 'p.dex_number, p.name AS pname, p.name_it AS pname_it, p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url';
    const rarest = this.db.all(
      `SELECT e.pokemon_id, e.is_shiny, e.rarity, e.caught_at, ${nameSql} AS player, ${pcols}
       FROM leaderboard_events e ${pj} JOIN twitch_users u ON u.id = e.user_id
       WHERE e.session_id = ? AND e.voided_at IS NULL ORDER BY ${RARITY_RANK_SQL('e.rarity')} DESC, e.is_shiny DESC, e.caught_at ASC LIMIT 5`, s.id)
      .map((r) => ({ ...pokemonView(r), player: r.player, caughtAt: r.caught_at }));
    const most = this.db.get(
      `SELECT e.pokemon_id, 0 AS is_shiny, MAX(e.rarity) AS rarity, COUNT(*) AS n, ${pcols}
       FROM leaderboard_events e ${pj} WHERE e.session_id = ? AND e.voided_at IS NULL
       GROUP BY e.pokemon_id ORDER BY n DESC, MIN(e.caught_at) ASC LIMIT 1`, s.id);
    const end = s.ended_at || nowIso();
    return {
      session: { id: s.id, kind: s.kind, kindLabel: KIND_LABEL[s.kind], title: s.title, startedAt: s.started_at, endedAt: s.ended_at, endReason: s.end_reason, open: !s.ended_at },
      durationS: s.duration_s ?? Math.max(0, Math.round((Date.parse(end) - Date.parse(s.started_at)) / 1000)),
      participants, encounters, shinyEncounters, attempts, captures, shiny,
      captureRate: attempts ? captures / attempts : 0,
      rarest,
      mostCaught: most ? { ...pokemonView(most), count: most.n } : null,
      winners: { captures: v.captures[0] || null, points: v.points[0] || null },
      top10: { captures: v.captures.slice(0, 10), points: v.points.slice(0, 10) },
      leaderboardSource: v.source,
      frozen: v.session.frozen,
      rulesVersion: v.rulesVersion,
      events: this.recapEvents(s),
      generatedAt: nowIso(),
    };
  }

  // Eventi automatici della sessione (Evento Leggendario, Bonus Shiny, obiettivi):
  // un errore qui non deve impedire il salvataggio del riepilogo.
  recapEvents(s) {
    if (!this.recapExtras) return [];
    try { return this.recapExtras(s) || []; } catch (e) {
      this.log?.warn('Eventi della sessione non aggiunti al riepilogo', { message: e.message });
      return [];
    }
  }

  // Generato alla chiusura della sessione (e rigenerabile esplicitamente).
  generateRecap(sessionId, { by = 'sistema' } = {}) {
    return this.db.tx(() => {
      const s = this.session(sessionId);
      const data = this.buildRecap(s);
      const json = JSON.stringify(data);
      this.db.run(
        `INSERT INTO stream_recaps (session_id, session_kind, data, source, generated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, source = excluded.source, updated_at = ?, generated_by = excluded.generated_by`,
        s.id, s.kind, json, data.leaderboardSource, by, nowIso());
      return data;
    });
  }

  recap(sessionId) {
    const r = this.db.get('SELECT * FROM stream_recaps WHERE session_id = ?', sessionId);
    if (r) return { ...JSON.parse(r.data), stored: true, createdAt: r.created_at, updatedAt: r.updated_at, generatedBy: r.generated_by };
    // Sessione ancora aperta (o chiusa prima di questa versione): riepilogo provvisorio, non salvato.
    return { ...this.buildRecap(this.session(sessionId)), stored: false };
  }

  listRecaps({ kind = null, limit = 50 } = {}) {
    const args = [];
    let w = '';
    if (kind) { w = 'WHERE session_kind = ?'; args.push(kind); }
    return this.db.all(`SELECT session_id, session_kind, data, created_at, updated_at FROM stream_recaps ${w} ORDER BY session_id DESC LIMIT ?`, ...args, limit)
      .map((r) => {
        const d = JSON.parse(r.data);
        return {
          sessionId: r.session_id, kind: r.session_kind, startedAt: d.session.startedAt, endedAt: d.session.endedAt, durationS: d.durationS,
          participants: d.participants, captures: d.captures, shiny: d.shiny,
          winnerCaptures: d.winners.captures?.name || null, winnerPoints: d.winners.points?.name || null, createdAt: r.created_at,
        };
      });
  }

  onSessionClosed(s) {
    if (!s || s.is_demo || !['twitch', 'manual'].includes(s.kind)) return;
    this.generateRecap(s.id);
    this.log.info(`Riepilogo della sessione #${s.id} (${s.kind.toUpperCase()}) salvato`);
    this.changed(s.id);
  }

  // --- Giocatori -----------------------------------------------------------------------
  listPlayers({ q = '', origin = null, limit = 50 } = {}) {
    const where = ['u.is_demo = 0'];
    const args = [];
    if (origin) { where.push('u.origin = ?'); args.push(origin); }
    const term = String(q || '').trim().toLowerCase();
    if (term) {
      where.push(`(u.login LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(u.custom_name, '')) LIKE ? ESCAPE '\\' OR u.twitch_id = ?
                  OR u.id IN (SELECT user_id FROM player_aliases WHERE LOWER(display_name) LIKE ? ESCAPE '\\'))`);
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like, term, like);
    }
    return this.db.all(
      `SELECT u.id, u.twitch_id, u.origin, u.login, u.display_name, u.custom_name, ${nameSql} AS name, u.last_seen_at,
              (SELECT COUNT(*) FROM leaderboard_events e WHERE e.user_id = u.id AND e.voided_at IS NULL) AS captures,
              (SELECT COALESCE(SUM(points), 0) FROM leaderboard_events e WHERE e.user_id = u.id AND e.voided_at IS NULL) AS points
       FROM twitch_users u WHERE ${where.join(' AND ')} ORDER BY points DESC, u.last_seen_at DESC LIMIT ?`, ...args, limit)
      .map((u) => this.identity(u));
  }

  identity(u) {
    return {
      id: u.id, origin: u.origin, name: u.custom_name || u.display_name, twitchName: u.origin === 'twitch' ? u.display_name : null,
      login: u.login, customName: u.custom_name || null,
      // Il Twitch User ID esiste solo per gli spettatori Twitch; i giocatori locali hanno un ID locale.
      twitchId: u.origin === 'twitch' ? u.twitch_id : null, localId: u.origin === 'local' ? u.twitch_id : null,
      captures: u.captures, points: u.points, lastSeenAt: u.last_seen_at,
    };
  }

  player(id) {
    const u = this.db.get('SELECT * FROM twitch_users WHERE id = ? AND is_demo = 0', id);
    if (!u) throw err(404, 'Giocatore non trovato');
    const stat = (kind) => this.db.get(
      `SELECT COUNT(*) AS captures, COALESCE(SUM(points), 0) AS points, COALESCE(SUM(is_shiny), 0) AS shiny, COUNT(DISTINCT pokemon_id) AS species,
              COUNT(DISTINCT session_id) AS sessionsWithCaptures
       FROM leaderboard_events WHERE user_id = ? AND voided_at IS NULL ${kind ? 'AND session_kind = ?' : ''}`, id, ...(kind ? [kind] : []));
    const sessions = this.db.all(
      `SELECT ss.id, ss.kind, ss.started_at, ss.ended_at,
              (SELECT COUNT(*) FROM leaderboard_events e WHERE e.session_id = ss.id AND e.user_id = ?1 AND e.voided_at IS NULL) AS captures,
              (SELECT COALESCE(SUM(points), 0) FROM leaderboard_events e WHERE e.session_id = ss.id AND e.user_id = ?1 AND e.voided_at IS NULL) AS points,
              (SELECT COUNT(*) FROM capture_attempts a WHERE a.session_id = ss.id AND a.user_id = ?1 AND a.outcome != 'rejected') AS attempts
       FROM stream_sessions ss WHERE ss.is_demo = 0 AND ss.kind IN ('twitch','manual')
         AND ss.id IN (SELECT session_id FROM capture_attempts WHERE user_id = ?1 AND outcome != 'rejected')
       ORDER BY ss.started_at DESC LIMIT 50`, id);
    const recent = this.db.all(
      `SELECT e.id, e.session_id, e.session_kind, e.is_shiny, e.rarity, e.base_points, e.rarity_bonus, e.shiny_bonus, e.points, e.rules_version,
              e.source, e.caught_at, e.voided_at, e.void_reason, COALESCE(p.name_it, p.name) AS pokemon, p.dex_number AS dex
       FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 30`, id);
    const all = stat(null);
    return {
      ...this.identity({ ...u, captures: all.captures, points: all.points }),
      firstSeenAt: u.first_seen_at,
      customNameAt: u.custom_name_at, customNameBy: u.custom_name_by,
      aliases: this.db.all('SELECT kind, login, display_name, first_seen_at, last_seen_at, changed_by FROM player_aliases WHERE user_id = ? ORDER BY id DESC LIMIT 50', id),
      stats: { all, twitch: stat('twitch'), manual: stat('manual') },
      sessions, recent,
    };
  }

  // Nome visualizzato scelto dall'amministratore (null = torna al nickname Twitch).
  // Non modifica eventi, catture o istantanee congelate.
  renamePlayer(id, name, { admin = null } = {}) {
    let next = name == null ? null : String(name).trim().replace(/\s+/g, ' ');
    if (next === '') next = null;
    if (next != null && !/^[\p{L}\p{N} _.\-]{1,25}$/u.test(next)) throw err(400, 'Nome non valido: da 1 a 25 caratteri tra lettere, numeri, spazi e _ . -');
    const out = this.db.tx(() => {
      const u = this.db.get('SELECT * FROM twitch_users WHERE id = ? AND is_demo = 0', id);
      if (!u) throw err(404, 'Giocatore non trovato');
      if ((u.custom_name || null) === next) return { changed: false };
      const now = nowIso();
      this.db.run('UPDATE twitch_users SET custom_name = ?, custom_name_at = ?, custom_name_by = ? WHERE id = ?', next, next ? now : null, next ? admin : null, id);
      this.db.run("INSERT INTO player_aliases (user_id, kind, login, display_name, first_seen_at, last_seen_at, changed_by) VALUES (?, 'admin', ?, ?, ?, ?, ?)",
        id, u.login, next ?? `(ripristinato: ${u.display_name})`, now, now, admin);
      audit(this.db, { admin, action: 'player_rename', targetType: 'player', targetId: id,
        detail: { origin: u.origin, from: u.custom_name || u.display_name, to: next || u.display_name, twitchName: u.display_name } }, this.log);
      return { changed: true };
    });
    if (out.changed) this.changed(null);
    return this.player(id);
  }

  // --- Schermata nell'overlay ------------------------------------------------------------
  display() { return this.settings.get('display'); }

  show({ sessionId = 'current', screen = 'board', board = null, hofKind = null, admin = null, via = 'dashboard' } = {}) {
    if (!SCREENS.includes(screen)) throw err(400, `Schermata non valida: ${SCREENS.join(', ')}`);
    if (board != null && !BOARDS.includes(board)) throw err(400, 'Classifica non valida: captures o points');
    if (hofKind != null && !HOF_KINDS.includes(hofKind)) throw err(400, 'Filtro non valido: all, twitch o manual');
    const cur = this.display();
    let sid = null;
    if (screen !== 'halloffame') sid = this.resolveSession(sessionId).id; // sessione esplicita, mai indovinata
    const next = {
      visible: true, screen, board: board || cur.board || 'points', sessionId: sid, hofKind: hofKind || cur.hofKind || 'all',
      shownAt: nowIso(), shownBy: admin, via, rev: (cur.rev || 0) + 1,
    };
    this.settings.set('display', next);
    audit(this.db, { admin, action: 'leaderboard_show', targetType: sid ? 'session' : 'halloffame', targetId: sid ?? next.hofKind, detail: { screen, board: next.board, via } }, this.log);
    this.pushOverlay();
    return next;
  }

  hide({ admin = null, via = 'dashboard' } = {}) {
    const cur = this.display();
    const next = { ...cur, visible: false, rev: (cur.rev || 0) + 1, hiddenAt: nowIso(), hiddenBy: admin };
    this.settings.set('display', next);
    if (cur.visible) audit(this.db, { admin, action: 'leaderboard_hide', targetType: cur.sessionId ? 'session' : 'halloffame', targetId: cur.sessionId ?? cur.hofKind, detail: { screen: cur.screen, via } }, this.log);
    this.pushOverlay();
    return next;
  }

  // Contenuto di una schermata (usato per l'overlay e per l'anteprima della dashboard).
  screenPayload(d) {
    const base = { visible: true, screen: d.screen, board: d.board, rev: d.rev, shownAt: d.shownAt };
    if (d.screen === 'halloffame') return { ...base, hallOfFame: this.hallOfFame({ kind: d.hofKind, limit: 10 }) };
    const s = this.session(d.sessionId);
    const v = this.view(s, { limit: 10 });
    const out = { ...base, session: v.session, source: v.source, totals: v.totals, captures: v.captures, points: v.points };
    if (d.screen === 'recap') out.recap = this.recap(s.id);
    if (d.screen === 'winner') out.winner = (d.board === 'captures' ? v.captures : v.points)[0] || null;
    return out;
  }

  overlayPayload() {
    const d = this.display();
    if (!d.visible) return { visible: false, rev: d.rev || 0 };
    try {
      return this.screenPayload(d);
    } catch (e) {
      // Sessione non più disponibile (es. dopo il ripristino di un backup più vecchio).
      this.log.warn('Schermata classifica non disponibile', { message: e.message });
      return { visible: false, rev: d.rev || 0, error: e.message };
    }
  }

  preview({ sessionId = 'current', screen = 'board', board = 'points', hofKind = 'all' } = {}) {
    if (!SCREENS.includes(screen)) throw err(400, 'Schermata non valida');
    if (!BOARDS.includes(board)) throw err(400, 'Classifica non valida');
    if (!HOF_KINDS.includes(hofKind)) throw err(400, 'Filtro non valido');
    const sid = screen === 'halloffame' ? null : this.resolveSession(sessionId).id;
    return { ...this.screenPayload({ screen, board, hofKind, sessionId: sid, rev: 0, shownAt: null }), preview: true };
  }

  pushOverlay() {
    clearTimeout(this.pushTimer);
    this.pushTimer = null;
    if (!this.db?.db) return;
    this.hub.overlay('leaderboard', this.overlayPayload());
    this.hub.admin('leaderboard', { display: this.display() });
  }

  // Qualcosa è cambiato (cattura, annullamento, congelamento, rinomina): la
  // dashboard si aggiorna e, se una schermata è visibile, anche l'overlay.
  // Con i timer attivi gli aggiornamenti ravvicinati vengono raggruppati.
  changed(sessionId) {
    this.hub.admin('leaderboard', { sessionId, display: this.display() });
    if (!this.display().visible) return;
    if (!this.timers) { this.pushOverlay(); return; }
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => this.pushOverlay(), 300);
    this.pushTimer.unref?.();
  }

  onCapture(event) {
    this.emit('capture', event); // punto di estensione (achievement, obiettivi comunitari)
    this.changed(event.session_id);
  }

  // --- Comando chat !leaderboard -------------------------------------------------------
  // Autorizzazione calcolata lato server dall'evento Twitch (ID di chi scrive,
  // badge del canale): mai dal nickname.
  authorize({ isBroadcaster = false, isModerator = false, twitchId = null }, sub) {
    if (isBroadcaster) return true;
    if (sub === 'freeze') return false;
    const c = this.settings.get('commands');
    if (!c.allowModerators || !isModerator) return false;
    return !c.moderatorIds?.length || c.moderatorIds.includes(String(twitchId));
  }

  chatCommand(sub, { user }) {
    const cur = this.currentSession();
    if (!cur || cur.kind !== 'twitch') return null; // solo durante una diretta Twitch
    const who = `twitch:${user.login || user.twitchId}`;
    const replies = this.settings.get('commands').replies !== false;
    this.stats.chatActions++;
    try {
      switch (sub) {
        case '':
        case 'show':
          this.show({ sessionId: cur.id, screen: 'board', admin: who, via: 'chat' });
          return replies ? '🏆 Classifica della diretta sullo schermo!' : null;
        case 'hide':
          this.hide({ admin: who, via: 'chat' });
          return replies ? 'Classifica nascosta.' : null;
        case 'freeze': {
          const f = this.freeze(cur.id, { admin: who, via: 'chat' });
          return replies ? `🔒 Risultati congelati (versione ${f.version}).` : null;
        }
        case 'winner': {
          const d = this.show({ sessionId: cur.id, screen: 'winner', admin: who, via: 'chat' });
          const w = this.screenPayload(d).winner;
          return replies ? (w ? `🏆 Vincitore: ${w.name} (${w.points} punti, ${w.captures} catture)!` : 'Nessuna cattura in questa diretta.') : null;
        }
        default:
          return replies ? 'Uso: !leaderboard [hide|freeze|winner]' : null;
      }
    } catch (e) {
      if (e.status === 409) return replies ? e.message.split(':')[0] : null;
      throw e;
    }
  }

  // --- Impostazioni dei comandi ----------------------------------------------------------
  commandSettings() { return this.settings.get('commands'); }

  setCommandSettings(b, { admin = null } = {}) {
    const cur = this.commandSettings();
    const ids = b.moderatorIds === undefined ? cur.moderatorIds : b.moderatorIds;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((x) => !/^\d{1,20}$/.test(String(x)))) throw err(400, 'ID moderatori non validi: elenco di Twitch User ID numerici');
    const next = {
      allowModerators: b.allowModerators === undefined ? cur.allowModerators : !!b.allowModerators,
      moderatorIds: [...new Set(ids.map(String))],
      replies: b.replies === undefined ? cur.replies : !!b.replies,
    };
    this.settings.set('commands', next);
    audit(this.db, { admin, action: 'leaderboard_commands_update', targetType: 'leaderboard_settings', targetId: 'commands', detail: { from: cur, to: next } }, this.log);
    return next;
  }

  shutdown() { clearTimeout(this.pushTimer); this.pushTimer = null; }
}
