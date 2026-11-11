// Statistiche Community: curiosità calcolate dalle catture valide della tabella
// leaderboard_events (la stessa fonte delle classifiche: catture annullate escluse,
// sessioni DEMO mai incluse, catture storiche "backfill" comprese).
//
// - Nessuna copia dei dati: tutto si calcola al momento, quindi le statistiche
//   storiche restano finché restano le catture (la fine di una diretta, il
//   congelamento o un cambio di regole di punteggio non cancellano nulla).
// - Ogni classifica è deterministica: a parità di valore vince chi ci è arrivato
//   prima, e le parità al primo posto vengono sempre segnalate ("ties").
// - Lo "spettatore più fortunato" usa una metrica scelta dall'amministratore e
//   spiegata nel risultato (nessun criterio casuale).
import { nowIso } from '../database/index.js';
import { imageUrl } from '../spawn/spawn.js';
import { RARITY_RANK_SQL } from '../leaderboard/scoring.js';
import { RARITY_LABELS } from '../configuration/defaults.js';

export const PERIODS = {
  session: 'Sessione corrente',
  last: 'Ultima diretta',
  week: 'Ultimi 7 giorni',
  month: 'Ultimi 30 giorni',
  all: 'Storico complessivo',
};

// Metriche dello "spettatore più fortunato": tutte verificabili contando le catture.
export const LUCK_METRICS = {
  special: {
    label: 'Catture speciali',
    explain: 'Numero di catture rare o speciali: rarità Raro, Molto raro, Leggendario o Mitico, oppure shiny. Una cattura conta una volta sola.',
    sql: "(e.rarity IN ('rare','epic','legendary','mythical') OR e.is_shiny = 1)",
  },
  shiny: {
    label: 'Shiny',
    explain: 'Numero di Pokémon shiny catturati.',
    sql: 'e.is_shiny = 1',
  },
  legendary: {
    label: 'Leggendari e Mitici',
    explain: 'Numero di Pokémon di rarità Leggendario o Mitico catturati.',
    sql: "e.rarity IN ('legendary','mythical')",
  },
};

export const COMMUNITY_STATS_DEFAULTS = { luckMetric: 'special' };

const nameSql = 'COALESCE(u.custom_name, u.display_name)';
const notBanned = 'e.user_id NOT IN (SELECT user_id FROM user_bans WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?))';
const pcols = 'p.dex_number, p.name AS pname, p.name_it AS pname_it, p.types, p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url';

const pokemonView = (r, shiny = !!r.is_shiny) => ({
  pokemonId: r.pokemon_id, dex: r.dex_number, name: r.pname_it || r.pname, rarity: r.rarity || null,
  rarityLabel: RARITY_LABELS[r.rarity] || r.rarity || null, shiny,
  image: imageUrl({ image_file: r.image_file, shiny_image_file: r.shiny_image_file, image_url: r.image_url, shiny_image_url: r.shiny_image_url }, shiny),
});

const durationOf = (s, now) => (s.duration_s != null ? s.duration_s : Math.max(0, Math.round((Date.parse(s.ended_at || now) - Date.parse(s.started_at)) / 1000)));

// Primi a pari merito: tutti quelli con lo stesso valore del primo.
const leaders = (rows, key) => (rows.length && rows[0][key] > 0 ? rows.filter((r) => r[key] === rows[0][key]) : []);

export class CommunityStatsService {
  constructor({ db, settings, currentSession = () => null, now = () => Date.now() }) {
    this.db = db;
    this.store = settings; // SettingsStore admin_settings, chiave "communityStats"
    this.currentSession = currentSession;
    this.now = now;
  }

  settings() { return { ...COMMUNITY_STATS_DEFAULTS, ...(this.store.get('communityStats') || {}) }; }

  setSettings(input = {}) {
    const next = this.settings();
    if (input.luckMetric !== undefined) {
      if (!LUCK_METRICS[input.luckMetric]) throw Object.assign(new Error('Metrica non valida'), { status: 400 });
      next.luckMetric = input.luckMetric;
    }
    this.store.set('communityStats', next);
    return next;
  }

  // Filtro SQL del periodo, sempre sulla tabella leaderboard_events con alias "e".
  scope(period) {
    const nowIsoStr = new Date(this.now()).toISOString();
    if (period === 'session') {
      const s = this.currentSession();
      if (!s) return { where: '0', args: [], session: null, empty: 'Nessuna sessione in corso' };
      return { where: 'e.session_id = ?', args: [s.id], session: s };
    }
    if (period === 'last') {
      const s = this.db.get("SELECT * FROM stream_sessions WHERE kind = 'twitch' AND is_demo = 0 AND ended_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1");
      if (!s) return { where: '0', args: [], session: null, empty: 'Nessuna diretta Twitch conclusa' };
      return { where: 'e.session_id = ?', args: [s.id], session: s };
    }
    if (period === 'week' || period === 'month') {
      const days = period === 'week' ? 7 : 30;
      return { where: 'e.caught_at >= ?', args: [new Date(this.now() - days * 86400e3).toISOString()], since: new Date(this.now() - days * 86400e3).toISOString(), until: nowIsoStr };
    }
    if (period === 'all') return { where: '1', args: [] };
    throw Object.assign(new Error('Periodo non valido'), { status: 400 });
  }

  compute(period = 'all', { luckMetric = null, topN = 10 } = {}) {
    if (!PERIODS[period]) throw Object.assign(new Error('Periodo non valido'), { status: 400 });
    const metricKey = luckMetric || this.settings().luckMetric;
    const metric = LUCK_METRICS[metricKey];
    if (!metric) throw Object.assign(new Error('Metrica non valida'), { status: 400 });
    const sc = this.scope(period);
    const now = nowIso();
    const W = `e.voided_at IS NULL AND ${sc.where}`;
    const A = sc.args;
    const all = (sql, ...extra) => this.db.all(sql, ...A, ...extra);
    const one = (sql, ...extra) => this.db.get(sql, ...A, ...extra);

    const totals = one(
      `SELECT COUNT(*) AS captures, COALESCE(SUM(e.is_shiny), 0) AS shiny,
              COALESCE(SUM(CASE WHEN e.rarity IN ('legendary','mythical') THEN 1 ELSE 0 END), 0) AS legendary,
              COUNT(DISTINCT e.user_id) AS trainers, COUNT(DISTINCT e.pokemon_id) AS species, COUNT(DISTINCT e.session_id) AS sessions
       FROM leaderboard_events e WHERE ${W}`);

    // Pokémon più catturati (a parità: catturato per primo, poi numero del Pokédex).
    const topPokemon = all(
      `SELECT e.pokemon_id, MAX(e.rarity) AS rarity, COUNT(*) AS n, COUNT(DISTINCT e.user_id) AS trainers, MIN(e.caught_at) AS first_at, ${pcols}
       FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id WHERE ${W}
       GROUP BY e.pokemon_id ORDER BY n DESC, first_at ASC, p.dex_number ASC LIMIT ?`, topN)
      .map((r) => ({ ...pokemonView(r, false), count: r.n, trainers: r.trainers, firstAt: r.first_at }));
    const mostCaughtTop = leaders(topPokemon, 'count');
    let mostCaught = null;
    if (mostCaughtTop.length) {
      const first = mostCaughtTop[0];
      const names = all(
        `SELECT ${nameSql} AS name, COUNT(*) AS n, MIN(e.caught_at) AS first_at FROM leaderboard_events e JOIN twitch_users u ON u.id = e.user_id
         WHERE ${W} AND e.pokemon_id = ? GROUP BY e.user_id ORDER BY n DESC, first_at ASC LIMIT 10`, first.pokemonId);
      mostCaught = { ...first, trainerNames: names.map((x) => ({ name: x.name, count: x.n })), ties: mostCaughtTop.slice(1).map((p) => p.name) };
    }

    // Classifiche per allenatore (bannati esclusi, come nelle classifiche).
    const byTrainer = (expr) => all(
      `SELECT e.user_id, ${nameSql} AS name, SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END) AS v, COUNT(*) AS captures,
              MIN(CASE WHEN ${expr} THEN e.caught_at END) AS first_at
       FROM leaderboard_events e JOIN twitch_users u ON u.id = e.user_id
       WHERE ${W} AND ${notBanned} GROUP BY e.user_id
       HAVING v > 0 ORDER BY v DESC, first_at ASC, e.user_id ASC LIMIT 10`, now)
      .map((r) => ({ userId: r.user_id, name: r.name, value: r.v, captures: r.captures }));
    const winner = (rows, unit) => {
      const top = leaders(rows, 'value');
      if (!top.length) return null;
      return { ...top[0], unit, tie: top.length > 1, tiedWith: top.slice(1).map((r) => r.name), top: rows.slice(0, 5) };
    };
    const lucky = winner(byTrainer(metric.sql), metric.label.toLowerCase());
    const luckiest = {
      metric: metricKey, label: metric.label, explain: metric.explain,
      winner: lucky,
      reason: lucky ? `${lucky.name}: ${lucky.value} ${lucky.value === 1 ? 'cattura' : 'catture'} (${metric.label.toLowerCase()})${lucky.tie ? `, a pari merito con ${lucky.tiedWith.join(', ')}` : ''}` : null,
    };
    const topTrainer = winner(byTrainer('1'), 'catture');
    const topShinyTrainer = winner(byTrainer('e.is_shiny = 1'), 'shiny');

    // Pokémon più raro catturato: rarità, poi shiny, poi il primo in ordine di tempo.
    const rare = one(
      `SELECT e.pokemon_id, e.is_shiny, e.rarity, e.caught_at, ${nameSql} AS player, ${pcols}
       FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id JOIN twitch_users u ON u.id = e.user_id
       WHERE ${W} ORDER BY ${RARITY_RANK_SQL('e.rarity')} DESC, e.is_shiny DESC, e.caught_at ASC, e.id ASC LIMIT 1`);
    const rarest = rare ? { ...pokemonView(rare), player: rare.player, caughtAt: rare.caught_at } : null;

    // Tipo più catturato: un Pokémon a doppio tipo conta per entrambi i tipi.
    const typeCount = new Map();
    for (const r of all(`SELECT p.types, COUNT(*) AS n FROM leaderboard_events e JOIN pokemon p ON p.id = e.pokemon_id WHERE ${W} GROUP BY p.types`)) {
      let types = [];
      try { types = JSON.parse(r.types || '[]'); } catch { /* tipi non leggibili: ignorati */ }
      for (const t of types) typeCount.set(t, (typeCount.get(t) || 0) + r.n);
    }
    const types = [...typeCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type, count]) => ({ type, count }));
    const topTypeLeaders = types.length ? types.filter((t) => t.count === types[0].count) : [];
    const topType = topTypeLeaders.length ? { ...topTypeLeaders[0], tie: topTypeLeaders.length > 1, tiedWith: topTypeLeaders.slice(1).map((t) => t.type), top: types.slice(0, 5) } : null;

    // Sessioni record: più catture e più Leggendari/Mitici (a parità: la prima).
    const sessionRows = (expr) => all(
      `SELECT e.session_id, SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END) AS v FROM leaderboard_events e
       WHERE ${W} GROUP BY e.session_id HAVING v > 0 ORDER BY v DESC, e.session_id ASC LIMIT 10`);
    const sessionView = (id, value) => {
      const s = this.db.get('SELECT * FROM stream_sessions WHERE id = ?', id);
      if (!s) return null;
      const players = this.db.all(
        `SELECT ${nameSql} AS name, COUNT(*) AS n FROM leaderboard_events e JOIN twitch_users u ON u.id = e.user_id
         WHERE e.session_id = ? AND e.voided_at IS NULL GROUP BY e.user_id ORDER BY n DESC, MIN(e.caught_at) ASC LIMIT 20`, id);
      return {
        sessionId: s.id, kind: s.kind, title: s.title, startedAt: s.started_at, endedAt: s.ended_at, open: !s.ended_at,
        durationS: durationOf(s, now), value, participants: players.map((p) => p.name),
      };
    };
    const record = (expr) => {
      const rows = sessionRows(expr);
      const top = rows.length ? rows.filter((r) => r.v === rows[0].v) : [];
      if (!top.length) return null;
      return { ...sessionView(top[0].session_id, top[0].v), tie: top.length > 1, tiedSessions: top.slice(1).map((r) => r.session_id) };
    };

    return {
      period, periodLabel: PERIODS[period],
      session: sc.session ? { id: sc.session.id, kind: sc.session.kind, startedAt: sc.session.started_at, endedAt: sc.session.ended_at } : null,
      since: sc.since || null, until: sc.until || null, empty: totals.captures === 0, emptyReason: totals.captures === 0 ? (sc.empty || 'Nessuna cattura nel periodo') : null,
      totals,
      mostCaught, topPokemon,
      luckiest,
      rarest,
      topTrainer, topShinyTrainer,
      topType, types: types.slice(0, 18),
      recordSession: record('1'),
      legendarySession: record("e.rarity IN ('legendary','mythical')"),
      generatedAt: now,
    };
  }

  // Selezione compatta per l'overlay (stessi calcoli, meno dati).
  overlay(period = 'session') {
    const s = this.compute(period, { topN: 5 });
    return {
      period: s.period, periodLabel: s.periodLabel, empty: s.empty, totals: s.totals,
      mostCaught: s.mostCaught && { name: s.mostCaught.name, image: s.mostCaught.image, count: s.mostCaught.count, trainers: s.mostCaught.trainers },
      luckiest: s.luckiest.winner && { name: s.luckiest.winner.name, value: s.luckiest.winner.value, label: s.luckiest.label, tie: s.luckiest.winner.tie },
      topTrainer: s.topTrainer && { name: s.topTrainer.name, value: s.topTrainer.value, tie: s.topTrainer.tie },
      rarest: s.rarest && { name: s.rarest.name, image: s.rarest.image, rarity: s.rarest.rarity, shiny: s.rarest.shiny, player: s.rarest.player },
      topType: s.topType && { type: s.topType.type, count: s.topType.count },
    };
  }
}
