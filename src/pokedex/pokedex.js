// Query sul Pokédex personale degli spettatori.
import { imageUrl } from '../spawn/spawn.js';

const RARITY_RANK = "CASE p.rarity WHEN 'mythical' THEN 6 WHEN 'legendary' THEN 5 WHEN 'epic' THEN 4 WHEN 'rare' THEN 3 WHEN 'uncommon' THEN 2 ELSE 1 END";

export function summary(db, userId, { isDemo = false } = {}) {
  const d = isDemo ? 1 : 0;
  const totals = db.get(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT pokemon_id) AS species, COALESCE(SUM(is_shiny), 0) AS shiny
     FROM user_pokemon WHERE user_id = ? AND is_demo = ?`, userId, d);
  const last = db.get(
    `SELECT up.*, p.name, p.name_it, p.dex_number FROM user_pokemon up JOIN pokemon p ON p.id = up.pokemon_id
     WHERE up.user_id = ? AND up.is_demo = ? ORDER BY up.caught_at DESC, up.id DESC LIMIT 1`, userId, d);
  const rarest = db.all(
    `SELECT p.id, p.name, p.name_it, p.dex_number, p.rarity, MAX(up.is_shiny) AS shiny, COUNT(*) AS count
     FROM user_pokemon up JOIN pokemon p ON p.id = up.pokemon_id
     WHERE up.user_id = ? AND up.is_demo = ? GROUP BY p.id ORDER BY ${RARITY_RANK} DESC, shiny DESC, p.dex_number LIMIT 5`, userId, d);
  const attempts = db.get(
    `SELECT COUNT(*) AS attempts, COALESCE(SUM(outcome = 'caught'), 0) AS caught, COALESCE(SUM(outcome = 'failed'), 0) AS failed
     FROM capture_attempts WHERE user_id = ? AND is_demo = ? AND outcome != 'rejected'`, userId, d);
  return {
    total: totals.total,
    species: totals.species,
    shiny: totals.shiny,
    attempts: attempts.attempts,
    caught: attempts.caught,
    failed: attempts.failed,
    successRate: attempts.attempts ? attempts.caught / attempts.attempts : 0,
    last: last ? { name: last.name_it || last.name, dex: last.dex_number, shiny: !!last.is_shiny, ball: last.ball_name, caughtAt: last.caught_at } : null,
    rarest: rarest.map((r) => ({ id: r.id, name: r.name_it || r.name, dex: r.dex_number, rarity: r.rarity, shiny: !!r.shiny, count: r.count })),
  };
}

export function collection(db, userId, { isDemo = false } = {}) {
  return db.all(
    `SELECT p.id, p.dex_number, p.name, p.name_it, p.rarity, p.types, p.form_name, p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url,
            COUNT(*) AS count, SUM(up.is_shiny) AS shiny_count, MIN(up.caught_at) AS first_caught, MAX(up.caught_at) AS last_caught
     FROM user_pokemon up JOIN pokemon p ON p.id = up.pokemon_id
     WHERE up.user_id = ? AND up.is_demo = ? GROUP BY p.id ORDER BY p.dex_number, p.id`, userId, isDemo ? 1 : 0,
  ).map((r) => ({
    id: r.id, dex: r.dex_number, name: r.name_it || r.name, form: r.form_name, rarity: r.rarity, types: JSON.parse(r.types || '[]'),
    count: r.count, shinyCount: r.shiny_count, duplicates: Math.max(0, r.count - 1), firstCaught: r.first_caught, lastCaught: r.last_caught,
    image: imageUrl(r, false), shinyImage: r.shiny_count ? imageUrl(r, true) : null,
  }));
}

export function captures(db, userId, { isDemo = false, limit = 100, offset = 0 } = {}) {
  return db.all(
    `SELECT up.id, up.caught_at, up.is_shiny, up.ball_name, up.source, up.session_id, p.id AS pokemon_id, p.name, p.name_it, p.dex_number, p.rarity
     FROM user_pokemon up JOIN pokemon p ON p.id = up.pokemon_id
     WHERE up.user_id = ? AND up.is_demo = ? ORDER BY up.caught_at DESC, up.id DESC LIMIT ? OFFSET ?`, userId, isDemo ? 1 : 0, limit, offset,
  ).map((r) => ({ id: r.id, caughtAt: r.caught_at, shiny: !!r.is_shiny, ball: r.ball_name, source: r.source, sessionId: r.session_id,
    pokemonId: r.pokemon_id, name: r.name_it || r.name, dex: r.dex_number, rarity: r.rarity }));
}

export function leaderboard(db, { limit = 10, isDemo = false, sessionId = null } = {}) {
  const params = [isDemo ? 1 : 0];
  let extra = '';
  if (sessionId) { extra = 'AND up.session_id = ?'; params.push(sessionId); }
  params.push(limit);
  return db.all(
    `SELECT u.id, u.login, u.display_name, COUNT(*) AS total, COUNT(DISTINCT up.pokemon_id) AS species, SUM(up.is_shiny) AS shiny
     FROM user_pokemon up JOIN twitch_users u ON u.id = up.user_id
     WHERE up.is_demo = ? ${extra} AND u.id NOT IN (SELECT user_id FROM user_bans WHERE active = 1)
     GROUP BY u.id ORDER BY total DESC, species DESC, u.display_name LIMIT ?`, ...params,
  ).map((r, i) => ({ rank: i + 1, id: r.id, login: r.login, displayName: r.display_name, total: r.total, species: r.species, shiny: r.shiny }));
}
