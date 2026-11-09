import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, seqRng } from './helpers.js';
import { pickPokemon, weightedPick } from '../src/spawn/spawn.js';
import { GAME_DEFAULTS } from '../src/configuration/defaults.js';
import { rarityFromSpecies } from '../src/pokemon_data/importer.js';

describe('Sistema di spawn', () => {
  let ctx, app;
  beforeEach(async () => {
    ctx = await makeApp({ configureTwitch: false });
    app = ctx.app;
    seedPokemon(app.db);
  });
  afterEach(async () => { await app.close(); cleanup(ctx.dir); });

  test('nessuno spawn se il motore non è attivo (canale offline)', () => {
    assert.equal(app.engine.tick(), null);
    assert.throws(() => app.engine.spawn({}), /non è attivo/);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM spawn_history').n, 0);
  });

  test('spawn in LIVE, un solo spawn attivo alla volta, scadenza', () => {
    app.engine.activateLive({ broadcastId: 'x' });
    const a = app.engine.tick();
    assert.ok(a);
    assert.equal(app.engine.tick(), null, 'non genera un secondo spawn');
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM spawn_history WHERE status = 'active'").n, 1);
    assert.ok(app.engine.nextSpawnAt, 'riprogramma il timer');
    app.engine.expire(a.id);
    assert.equal(app.db.get('SELECT status FROM spawn_history WHERE id = ?', a.id).status, 'expired');
    assert.ok(app.engine.tick(), 'dopo la scadenza può apparire il successivo');
    assert.equal(app.engine.sessions.byId(app.engine.session.id).spawns, 2);
  });

  test('vincolo database: impossibile avere due spawn attivi', () => {
    app.engine.activateLive({ broadcastId: 'x' });
    app.engine.tick();
    assert.throws(() => app.db.run("INSERT INTO spawn_history (session_id, pokemon_id, rarity, started_at, expires_at) VALUES (1, 1, 'common', 'a', 'b')"), /UNIQUE/);
  });

  test('probabilità di spawn 0 e sistema disattivato', () => {
    app.engine.activateLive({ broadcastId: 'x' });
    app.gameSettings.set('spawn', { ...GAME_DEFAULTS.spawn, spawnChance: 0 });
    assert.equal(app.engine.tick(), null);
    app.gameSettings.set('spawn', { ...GAME_DEFAULTS.spawn, enabled: false });
    assert.equal(app.engine.tick(), null);
    app.engine.scheduleNext();
    assert.equal(app.engine.nextSpawnAt, null);
  });

  test('selezione per rarità rispetta i pesi e ignora i Pokémon disabilitati', () => {
    const s = { ...structuredClone(GAME_DEFAULTS) };
    s.rarityWeights = { common: 0, uncommon: 0, rare: 1, epic: 0, legendary: 0, mythical: 0 };
    for (let i = 0; i < 20; i++) assert.equal(pickPokemon(app.db, s).pokemon.rarity, 'rare');
    app.db.run("UPDATE pokemon SET enabled = 0 WHERE rarity = 'rare'");
    s.rarityWeights.common = 1;
    for (let i = 0; i < 20; i++) assert.equal(pickPokemon(app.db, s).pokemon.rarity, 'common');
    app.db.run('UPDATE pokemon SET enabled = 0');
    assert.equal(pickPokemon(app.db, s), null);
  });

  test('distribuzione statistica dei pesi', () => {
    const items = ['a', 'b'];
    let a = 0;
    for (let i = 0; i < 4000; i++) if (weightedPick(items, (x) => (x === 'a' ? 3 : 1), Math.random) === 'a') a++;
    assert.ok(a / 4000 > 0.7 && a / 4000 < 0.8, `quota a=${a / 4000}`);
  });

  test('shiny con probabilità indipendente e filtro per generazione', () => {
    const s = structuredClone(GAME_DEFAULTS);
    s.shiny.chance = 1;
    assert.equal(pickPokemon(app.db, s, seqRng([0.1, 0.1, 0.1])).isShiny, true);
    s.shiny.chance = 0;
    assert.equal(pickPokemon(app.db, s).isShiny, false);
    s.spawn.allowedGenerations = [5];
    assert.equal(pickPokemon(app.db, s), null);
  });

  test('rarità derivata dai dati PokéAPI', () => {
    assert.equal(rarityFromSpecies({ is_mythical: true }), 'mythical');
    assert.equal(rarityFromSpecies({ is_legendary: true }), 'legendary');
    assert.equal(rarityFromSpecies({ capture_rate: 255 }), 'common');
    assert.equal(rarityFromSpecies({ capture_rate: 90 }), 'uncommon');
    assert.equal(rarityFromSpecies({ capture_rate: 45 }), 'rare');
    assert.equal(rarityFromSpecies({ capture_rate: 3 }), 'epic');
  });
});
