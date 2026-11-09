// Selezione e creazione degli spawn.
import { RARITIES } from '../configuration/defaults.js';
import { nowIso } from '../database/index.js';

export function weightedPick(items, weightOf, rng) {
  const total = items.reduce((s, it) => s + Math.max(0, weightOf(it)), 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const it of items) {
    r -= Math.max(0, weightOf(it));
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

export function eligiblePokemon(db, settings) {
  const gens = settings.spawn.allowedGenerations || [];
  let list = db.all('SELECT * FROM pokemon WHERE enabled = 1 AND spawn_weight > 0');
  if (gens.length) list = list.filter((p) => gens.includes(p.generation));
  const ev = settings.event;
  if (ev?.enabled && ev.types?.length) {
    const filtered = list.filter((p) => JSON.parse(p.types || '[]').some((t) => ev.types.includes(t)));
    if (filtered.length) list = filtered;
  }
  return list;
}

// Sceglie rarità (pesi configurabili) e poi un Pokémon di quella rarità.
export function pickPokemon(db, settings, rng = Math.random) {
  const pool = eligiblePokemon(db, settings);
  if (!pool.length) return null;
  const byRarity = new Map();
  for (const p of pool) {
    if (!byRarity.has(p.rarity)) byRarity.set(p.rarity, []);
    byRarity.get(p.rarity).push(p);
  }
  const ev = settings.event?.enabled ? settings.event : null;
  const rarities = RARITIES.filter((r) => byRarity.has(r));
  const rarity = weightedPick(rarities, (r) => (settings.rarityWeights[r] ?? 0) * (ev?.rarityBoost?.[r] ?? 1), rng);
  if (!rarity) return null;
  const pokemon = weightedPick(byRarity.get(rarity), (p) => p.spawn_weight, rng);
  let shinyChance = settings.shiny.enabled && pokemon.shiny_enabled ? settings.shiny.chance : 0;
  if (ev) shinyChance *= ev.shinyMultiplier ?? 1;
  const isShiny = rng() < Math.min(1, shinyChance);
  return { pokemon, isShiny };
}

export function createSpawn(db, { sessionId, pokemon, isShiny, source, durationS, captureMode, isDemo }) {
  const started = new Date();
  const expires = new Date(started.getTime() + durationS * 1000);
  return db.tx(() => {
    const active = db.get("SELECT id FROM spawn_history WHERE status = 'active'");
    if (active) return null; // già presente uno spawn attivo
    const r = db.run(
      `INSERT INTO spawn_history (session_id, pokemon_id, is_shiny, is_demo, rarity, source, capture_mode, started_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId, pokemon.id, isShiny ? 1 : 0, isDemo ? 1 : 0, pokemon.rarity, source, captureMode, started.toISOString(), expires.toISOString(),
    );
    db.run('UPDATE stream_sessions SET spawns = spawns + 1, shiny_spawns = shiny_spawns + ? WHERE id = ?', isShiny ? 1 : 0, sessionId);
    return getSpawn(db, Number(r.lastInsertRowid));
  });
}

export function getSpawn(db, id) {
  return db.get(
    `SELECT s.*, p.dex_number, p.name, p.name_it, p.slug, p.types, p.form_name, p.catch_modifier,
            p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url
     FROM spawn_history s JOIN pokemon p ON p.id = s.pokemon_id WHERE s.id = ?`, id) || null;
}

export function activeSpawn(db) {
  const row = db.get("SELECT id FROM spawn_history WHERE status = 'active' LIMIT 1");
  return row ? getSpawn(db, row.id) : null;
}

// Termina uno spawn solo se ancora attivo (controllo di concorrenza).
export function endSpawn(db, id, status) {
  const r = db.run("UPDATE spawn_history SET status = ?, ended_at = ? WHERE id = ? AND status = 'active'", status, nowIso(), id);
  return r.changes === 1;
}

export function imageUrl(p, shiny) {
  const file = shiny ? p.shiny_image_file || p.image_file : p.image_file;
  if (file) return `/images/${file}`;
  const remote = shiny ? p.shiny_image_url || p.image_url : p.image_url;
  return remote || '/assets/img/unknown.svg';
}

export function publicSpawn(s, extra = {}) {
  if (!s) return null;
  return {
    id: s.id,
    pokemonId: s.pokemon_id,
    dex: s.dex_number,
    name: s.name_it || s.name,
    form: s.form_name || null,
    types: JSON.parse(s.types || '[]'),
    rarity: s.rarity,
    shiny: !!s.is_shiny,
    image: imageUrl(s, !!s.is_shiny),
    startedAt: s.started_at,
    expiresAt: s.expires_at,
    attempts: s.attempts,
    captures: s.captures,
    status: s.status,
    mode: s.capture_mode,
    demo: !!s.is_demo,
    ...extra,
  };
}
