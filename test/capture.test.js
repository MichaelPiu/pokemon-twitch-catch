import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, linkReward, seqRng } from './helpers.js';
import { captureProbability } from '../src/capture/capture.js';
import { GAME_DEFAULTS } from '../src/configuration/defaults.js';

const user = (n = 1) => ({ twitchId: String(2000 + n), login: `user${n}`, displayName: `User${n}` });

describe('Sistema di cattura', () => {
  let ctx, app, rng, reward;
  beforeEach(async () => {
    rng = seqRng();
    ctx = await makeApp({ configureTwitch: false, rng });
    app = ctx.app;
    seedPokemon(app.db);
    reward = linkReward(app, 'pokeball');
    app.engine.activateLive({ broadcastId: 'b1' });
  });
  afterEach(async () => { await app.close(); cleanup(ctx.dir); });

  const spawnCommon = () => app.engine.spawn({ pokemonId: 1, shiny: false });

  test('cattura riuscita: aggiunge al Pokédex con ball, data e sessione', () => {
    spawnCommon();
    rng.push(0.0); // roll < probabilità
    const r = app.engine.attempt({ redemptionId: 'r1', rewardId: reward.rewardId, user: user(1), redeemedAt: new Date().toISOString() });
    assert.equal(r.caught, true);
    const up = app.db.get('SELECT * FROM user_pokemon WHERE id = ?', r.userPokemonId);
    assert.equal(up.pokemon_id, 1);
    assert.equal(up.ball_name, 'Poké Ball');
    assert.equal(up.session_id, app.engine.session.id);
    assert.ok(up.caught_at);
    const s = app.engine.sessions.byId(app.engine.session.id);
    assert.equal(s.captures, 1);
    assert.equal(s.attempts, 1);
    assert.equal(s.participants, 1);
    // Modalità un solo vincitore: lo spawn termina.
    assert.equal(app.db.get('SELECT status FROM spawn_history WHERE id = ?', r.spawnId).status, 'caught');
  });

  test('cattura fallita: tentativo registrato, Pokémon resta in campo', () => {
    spawnCommon();
    rng.push(0.99);
    const r = app.engine.attempt({ redemptionId: 'r1', rewardId: reward.rewardId, user: user(1), redeemedAt: new Date().toISOString() });
    assert.equal(r.caught, false);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);
    const a = app.db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', 'r1');
    assert.equal(a.outcome, 'failed');
    assert.equal(app.engine.sessions.byId(app.engine.session.id).failures, 1);
    assert.equal(app.db.get('SELECT status FROM spawn_history WHERE id = ?', r.spawnId).status, 'active');
  });

  test('evento duplicato (stessa riscossione) elaborato una sola volta', () => {
    spawnCommon();
    rng.push(0.99, 0.0);
    const a = app.engine.attempt({ redemptionId: 'dup', rewardId: reward.rewardId, user: user(1) });
    const b = app.engine.attempt({ redemptionId: 'dup', rewardId: reward.rewardId, user: user(1) });
    assert.equal(a.caught, false);
    assert.equal(b.duplicate, true);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM capture_attempts').n, 1);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);
  });

  test('catture simultanee in modalità un solo vincitore: un solo vincitore', async () => {
    spawnCommon();
    rng.push(0.0, 0.0, 0.0, 0.0, 0.0);
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => Promise.resolve().then(() =>
      app.engine.attempt({ redemptionId: `s${n}`, rewardId: reward.rewardId, user: user(n) }))));
    const winners = results.filter((r) => r.caught);
    assert.equal(winners.length, 1);
    assert.equal(results.filter((r) => r.rejected && ['already_caught', 'no_spawn'].includes(r.reason)).length, 4);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1);
  });

  test('cattura multipla: più spettatori catturano lo stesso Pokémon, una volta ciascuno', () => {
    app.gameSettings.set('capture', { ...GAME_DEFAULTS.capture, mode: 'multi' });
    spawnCommon();
    rng.push(0.0, 0.0, 0.0);
    assert.equal(app.engine.attempt({ redemptionId: 'm1', rewardId: reward.rewardId, user: user(1) }).caught, true);
    assert.equal(app.engine.attempt({ redemptionId: 'm2', rewardId: reward.rewardId, user: user(2) }).caught, true);
    const again = app.engine.attempt({ redemptionId: 'm3', rewardId: reward.rewardId, user: user(1) });
    assert.equal(again.reason, 'already_caught');
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 2);
  });

  test('rifiuta tentativi senza spawn, a motore spento, da utenti esclusi e con ricompense non di gioco', () => {
    let r = app.engine.attempt({ redemptionId: 'x1', rewardId: reward.rewardId, user: user(1) });
    assert.equal(r.reason, 'no_spawn');
    r = app.engine.attempt({ redemptionId: 'x2', rewardId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', user: user(1) });
    assert.equal(r.ignored, true);
    spawnCommon();
    const u = app.db.get('SELECT id FROM twitch_users WHERE twitch_id = ?', user(1).twitchId);
    app.db.run('INSERT INTO user_bans (user_id) VALUES (?)', u.id);
    r = app.engine.attempt({ redemptionId: 'x3', rewardId: reward.rewardId, user: user(1) });
    assert.equal(r.reason, 'banned');
    app.engine.deactivate('test');
    r = app.engine.attempt({ redemptionId: 'x4', rewardId: reward.rewardId, user: user(2) });
    assert.equal(r.reason, 'offline');
  });

  test('eventi in ritardo: riscossione precedente allo spawn o dopo la scadenza', () => {
    const sp = spawnCommon();
    const before = new Date(Date.parse(sp.startedAt) - 60000).toISOString();
    assert.equal(app.engine.attempt({ redemptionId: 'l1', rewardId: reward.rewardId, user: user(1), redeemedAt: before }).reason, 'late');
    app.db.run("UPDATE spawn_history SET expires_at = ? WHERE id = ?", new Date(Date.now() - 60000).toISOString(), sp.id);
    assert.equal(app.engine.attempt({ redemptionId: 'l2', rewardId: reward.rewardId, user: user(1) }).reason, 'expired');
  });

  test('limite tentativi per utente e fuga dopo il massimo per spawn', () => {
    app.gameSettings.set('spawn', { ...GAME_DEFAULTS.spawn, maxAttemptsPerUser: 1, maxAttemptsPerSpawn: 2 });
    spawnCommon();
    rng.push(0.99, 0.99);
    app.engine.attempt({ redemptionId: 'a1', rewardId: reward.rewardId, user: user(1) });
    assert.equal(app.engine.attempt({ redemptionId: 'a2', rewardId: reward.rewardId, user: user(1) }).reason, 'user_limit');
    const r = app.engine.attempt({ redemptionId: 'a3', rewardId: reward.rewardId, user: user(2) });
    assert.equal(r.spawnEnded, 'fled');
    assert.equal(app.db.get('SELECT status FROM spawn_history WHERE id = ?', r.spawnId).status, 'fled');
  });

  test('Master Ball cattura sempre se abilitata', () => {
    const master = linkReward(app, 'masterball', '22222222-2222-2222-2222-222222222222');
    app.engine.spawn({ pokemonId: 4, shiny: false }); // leggendario
    rng.push(0.999999);
    const r = app.engine.attempt({ redemptionId: 'mb', rewardId: master.rewardId, user: user(1) });
    assert.equal(r.probability, 1);
    assert.equal(r.caught, true);
  });

  test('calcolo probabilità: rarità × difficoltà × ball × modificatori, con limiti', () => {
    const s = structuredClone(GAME_DEFAULTS);
    const ball = { multiplier: 2, guaranteed: 0 };
    assert.equal(captureProbability({ settings: s, rarity: 'rare', catchModifier: 1, ball, isShiny: false }), 0.6);
    assert.equal(captureProbability({ settings: s, rarity: 'common', catchModifier: 1, ball, isShiny: false }), s.capture.maxChance);
    const p = captureProbability({ settings: s, rarity: 'legendary', catchModifier: 0.5, ball: { multiplier: 1 }, isShiny: true });
    assert.ok(Math.abs(p - 0.08 * 0.5 * 0.85) < 1e-9);
    s.event.enabled = true; s.event.catchModifier = 2;
    assert.ok(Math.abs(captureProbability({ settings: s, rarity: 'rare', catchModifier: 1, ball: { multiplier: 1 } }) - 0.6) < 1e-9);
  });

  test('riscossione annullata da un moderatore revoca la cattura se configurato', () => {
    app.gameSettings.set('capture', { ...GAME_DEFAULTS.capture, revokeOnCancel: true });
    spawnCommon();
    rng.push(0.0);
    app.engine.attempt({ redemptionId: 'c1', rewardId: reward.rewardId, user: user(1) });
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1);
    const r = app.engine.redemptionUpdated({ redemptionId: 'c1', status: 'canceled' });
    assert.equal(r.revoked, true);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);
  });

  test('DEMO separata: tentativi demo rifiutati in LIVE e statistiche reali non contaminate', () => {
    spawnCommon();
    const r = app.engine.attempt({ redemptionId: 'd1', ballTypeId: reward.ball.id, user: { twitchId: 'demo:x', login: 'x', displayName: 'x' }, isDemo: true });
    assert.equal(r.reason, 'live_mode');
    app.engine.deactivate('fine');
    app.engine.startDemo();
    app.engine.spawn({ pokemonId: 1 });
    rng.push(0.0);
    const d = app.engine.attempt({ redemptionId: 'd2', ballTypeId: reward.ball.id, user: { twitchId: 'demo:x', login: 'x', displayName: 'x' }, isDemo: true });
    assert.equal(d.caught, true);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE is_demo = 0').n, 0);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE is_demo = 0 AND outcome != 'rejected'").n, 0);
  });
});
