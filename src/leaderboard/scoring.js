// Punteggi delle classifiche e registrazione degli eventi di cattura.
//
// Regole fondamentali:
// - un evento nasce SOLO da una cattura riuscita del motore di gioco
//   (processAttempt), nella stessa transazione della cattura;
// - solo sessioni TWITCH e MANUAL: mai DEMO, registrazioni manuali del Pokédex,
//   importazioni o modifiche amministrative;
// - capture_attempt_id univoco: la stessa cattura non assegna mai punti due volte;
// - punti, bonus, rarità e versione delle regole sono salvati nell'evento e non
//   vengono più ricalcolati (un cambio delle regole vale solo per le catture future).
import { nowIso } from '../database/index.js';

export const SCORING_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
export const RARITY_RANK = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythical: 6 };
export const DEFAULT_RULES = Object.freeze({
  base: 10,
  rarity: Object.freeze({ common: 0, uncommon: 5, rare: 15, epic: 30, legendary: 50, mythical: 50 }),
  shiny: 50,
});
export const MAX_POINTS = 10000;

// Espressione SQL dell'ordine di rarità (per "Pokémon più raro").
export const RARITY_RANK_SQL = (col) => `CASE ${col} ${Object.entries(RARITY_RANK).map(([k, n]) => `WHEN '${k}' THEN ${n}`).join(' ')} ELSE 0 END`;

export function currentRules(db) {
  const row = db.get('SELECT * FROM leaderboard_rule_versions ORDER BY id DESC LIMIT 1');
  if (!row) return { version: null, ...structuredClone(DEFAULT_RULES) };
  const r = JSON.parse(row.rules);
  return { version: row.id, base: r.base, rarity: { ...DEFAULT_RULES.rarity, ...r.rarity }, shiny: r.shiny, createdAt: row.created_at, createdBy: row.created_by };
}

// Valida le regole inviate dalla dashboard: interi tra 0 e MAX_POINTS.
export function validateRules(input) {
  const errors = [];
  const int = (x, name) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0 || n > MAX_POINTS) { errors.push(`${name}: intero tra 0 e ${MAX_POINTS}`); return 0; }
    return n;
  };
  const src = input && typeof input === 'object' ? input : {};
  const out = { base: int(src.base, 'Punti base'), rarity: {}, shiny: int(src.shiny, 'Bonus shiny') };
  const rar = src.rarity && typeof src.rarity === 'object' ? src.rarity : {};
  for (const k of SCORING_RARITIES) out.rarity[k] = int(rar[k] ?? 0, `Bonus rarità ${k}`);
  if (out.base < 1 && !errors.length) errors.push('Punti base: almeno 1 (ogni cattura deve valere qualcosa)');
  return { rules: out, errors };
}

// Calcolo dei punti di una cattura. Rarità sconosciuta o assente: solo punti base.
export function computePoints(rules, { rarity, shiny }) {
  const base = rules.base;
  const rarityBonus = rarity && Object.hasOwn(rules.rarity, rarity) ? rules.rarity[rarity] : 0;
  const shinyBonus = shiny ? rules.shiny : 0;
  return { base, rarityBonus, shinyBonus, total: base + rarityBonus + shinyBonus };
}

// Registra l'evento di classifica di una cattura riuscita. Va chiamata dentro la
// transazione della cattura. Ritorna l'evento creato, oppure null se la sessione
// non partecipa alle classifiche (DEMO) o se l'evento esisteva già (duplicato).
export function recordCaptureEvent(db, { attemptId, userPokemonId, sessionId, userId, spawnId, pokemonId, isShiny, rarity, caughtAt }) {
  if (!attemptId || !sessionId) return null;
  const s = db.get('SELECT kind, is_demo FROM stream_sessions WHERE id = ?', sessionId);
  if (!s || s.is_demo || !['twitch', 'manual'].includes(s.kind)) return null;
  const rules = currentRules(db);
  if (!rules.version) return null;
  const pts = computePoints(rules, { rarity, shiny: !!isShiny });
  const r = db.run(
    `INSERT INTO leaderboard_events (capture_attempt_id, user_pokemon_id, session_id, session_kind, user_id, spawn_id, pokemon_id,
       is_shiny, rarity, base_points, rarity_bonus, shiny_bonus, points, rules_version, source, caught_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)
     ON CONFLICT(capture_attempt_id) DO NOTHING`,
    attemptId, userPokemonId ?? null, sessionId, s.kind, userId, spawnId ?? null, pokemonId, isShiny ? 1 : 0, rarity || null,
    pts.base, pts.rarityBonus, pts.shinyBonus, pts.total, rules.version, caughtAt || nowIso());
  if (r.changes !== 1) return null;
  return db.get('SELECT * FROM leaderboard_events WHERE id = ?', Number(r.lastInsertRowid));
}

// Cattura annullata (riscatto revocato su Twitch): l'evento esce dalle classifiche
// live ma resta nel database. Le istantanee già congelate non cambiano.
export function voidCaptureEvent(db, attemptId, reason = 'canceled') {
  const r = db.run('UPDATE leaderboard_events SET voided_at = ?, void_reason = ? WHERE capture_attempt_id = ? AND voided_at IS NULL',
    nowIso(), reason, attemptId);
  return r.changes === 1 ? db.get('SELECT * FROM leaderboard_events WHERE capture_attempt_id = ?', attemptId) : null;
}
