import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon } from './helpers.js';
import { summary, leaderboard, collection } from '../src/pokedex/pokedex.js';

describe('Comandi chat e Pokédex', () => {
  let ctx, app, mario, luigi;
  const msg = (text, u = mario) => ({ text, user: { twitchId: u.twitch_id, login: u.login, displayName: u.display_name } });

  beforeEach(async () => {
    ctx = await makeApp({ configureTwitch: false });
    app = ctx.app;
    seedPokemon(app.db);
    app.db.run("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('1', 'mario', 'Mario'), ('2', 'luigi', 'Luigi')");
    mario = app.db.get("SELECT * FROM twitch_users WHERE login = 'mario'");
    luigi = app.db.get("SELECT * FROM twitch_users WHERE login = 'luigi'");
    // Mario: 3 esemplari (2 specie, 1 shiny, 1 doppione). Luigi: 1.
    app.db.run("INSERT INTO user_pokemon (user_id, pokemon_id, is_shiny, ball_name, caught_at) VALUES (?, 1, 0, 'Poké Ball', '2026-01-01T10:00:00Z'), (?, 1, 0, 'Poké Ball', '2026-01-02T10:00:00Z'), (?, 4, 1, 'Ultra Ball', '2026-01-03T10:00:00Z')", mario.id, mario.id, mario.id);
    app.db.run("INSERT INTO user_pokemon (user_id, pokemon_id) VALUES (?, 2)", luigi.id);
  });
  afterEach(async () => { await app.close(); cleanup(ctx.dir); });

  test('Pokédex personale: totale, specie, shiny, doppioni, più rari', () => {
    const s = summary(app.db, mario.id);
    assert.equal(s.total, 3);
    assert.equal(s.species, 2);
    assert.equal(s.shiny, 1);
    assert.equal(s.rarest[0].rarity, 'legendary');
    assert.equal(s.last.name, 'Testmon D');
    const c = collection(app.db, mario.id);
    assert.equal(c.find((x) => x.id === 1).duplicates, 1);
    const lb = leaderboard(app.db);
    assert.equal(lb[0].login, 'mario');
    assert.equal(lb[0].rank, 1);
  });

  test('!pokedex riconosce automaticamente chi scrive', () => {
    const r = app.commands.handle(msg('!pokedex'));
    assert.equal(r.reply, '@Mario hai catturato 3 Pokémon e scoperto 2 specie! (1 shiny)');
  });

  test('!pokemon, !dex @utente, !ultimocatturato, !classifica, !help', () => {
    app.gameSettings.set('commands', { ...app.gameSettings.get('commands'), userMaxPerWindow: 50 });
    assert.match(app.commands.handle(msg('!pokemon')).reply, /possiedi 3 Pokémon/);
    assert.match(app.commands.handle(msg('!dex @luigi')).reply, /Luigi ha catturato 1 Pokémon/);
    assert.match(app.commands.handle(msg('!ultimocatturato')).reply, /Testmon D ✨ \(Ultra Ball/);
    assert.match(app.commands.handle(msg('!classifica')).reply, /1\. Mario \(3\) · 2\. Luigi \(1\)/);
    const help = app.commands.handle(msg('!help')).reply;
    assert.match(help, /!pokedex/);
    assert.match(help, /!dex @utente/);
  });

  test('utente senza catture riceve la risposta "vuota"', () => {
    const nuovo = { twitch_id: '99', login: 'nuovo', display_name: 'Nuovo' };
    assert.match(app.commands.handle(msg('!pokedex', nuovo)).reply, /ancora vuoto/);
  });

  test('cooldown per utente e globale, anti-spam', () => {
    const t0 = 1_000_000;
    assert.ok(app.commands.handle(msg('!pokedex'), { now: t0 }).reply);
    assert.equal(app.commands.handle(msg('!pokedex'), { now: t0 + 1000 }).ignored, 'global_cooldown');
    assert.equal(app.commands.handle(msg('!pokedex'), { now: t0 + 5000 }).ignored, 'user_cooldown');
    assert.ok(app.commands.handle(msg('!pokedex', luigi), { now: t0 + 5000 }).reply, 'altro utente dopo il cooldown globale');
    // Anti-spam: max 3 comandi/minuto per utente.
    app.db.run('UPDATE command_settings SET global_cooldown_s = 0, user_cooldown_s = 0');
    let ok = 0, spam = 0;
    for (let i = 0; i < 6; i++) {
      const r = app.commands.handle(msg('!pokemon', luigi), { now: t0 + 10000 + i });
      if (r?.reply) ok++; else if (r?.ignored === 'spam') spam++;
    }
    assert.equal(ok, 2); // 1 già usato prima nella stessa finestra
    assert.equal(spam, 4);
  });

  test('comandi disattivati, alias, prefisso personalizzato, utenti esclusi', () => {
    app.db.run("UPDATE command_settings SET enabled = 0 WHERE command = 'pokemon'");
    assert.equal(app.commands.handle(msg('!pokemon')), null);
    assert.ok(app.commands.handle(msg('!top')).reply, 'alias di classifica');
    app.gameSettings.set('commands', { ...app.gameSettings.get('commands'), prefix: '?' });
    assert.equal(app.commands.handle(msg('!pokedex', luigi)), null);
    assert.ok(app.commands.handle(msg('?pokedex', luigi)).reply);
    app.db.run('INSERT INTO user_bans (user_id) VALUES (?)', mario.id);
    assert.equal(app.commands.handle(msg('?ultimo')), null);
  });

  test('!dex @utente disattivabile', () => {
    app.db.run(`UPDATE command_settings SET options = '{"allowOthers":false}' WHERE command = 'dex'`);
    assert.equal(app.commands.handle(msg('!dex @luigi')), null);
  });
});
