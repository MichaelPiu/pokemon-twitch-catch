// Modifica manuale del Pokédex dalla dashboard: ricerca, filtri, correzioni,
// registrazioni manuali, rimozioni, duplicati, validazione, concorrenza, origine dei dati.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, tempDir, adminClient, seqRng } from './helpers.js';

describe('Modifica manuale del Pokédex', () => {
  let ctx, app, client, trainer, mons, root;

  beforeEach(async () => {
    root = tempDir();
    ctx = await makeApp({ configureTwitch: false, rng: seqRng(), env: { BACKUP_TARGET_ROOT: root } });
    app = ctx.app;
    mons = seedPokemon(app.db, [
      { dex: 1, slug: 'bulbasaur', name: 'Bulbasaur', rarity: 'common' },
      { dex: 25, slug: 'pikachu', name: 'Pikachu', rarity: 'uncommon' },
      { dex: 25, slug: 'pikachu-alola-cap', name: 'Pikachu', rarity: 'uncommon' },
      { dex: 150, slug: 'mewtwo', name: 'Mewtwo', rarity: 'legendary' },
    ]);
    app.db.run("UPDATE pokemon SET form_name = 'Berretto di Alola', is_default_form = 0 WHERE slug = 'pikachu-alola-cap'");
    app.db.run("UPDATE pokemon SET name_it = 'Pikachu' WHERE dex_number = 25");
    app.db.run("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('2001', 'mario', 'Mario')");
    trainer = app.db.get("SELECT * FROM twitch_users WHERE login = 'mario'");
    client = await adminClient(app);
  });

  afterEach(async () => { await app.close(); cleanup(ctx.dir); cleanup(root); });

  const byslug = (s) => mons.find((m) => m.slug === s).id;
  const register = (pokemonId, extra = {}) => client.req('POST', `/api/admin/pokedex/${trainer.id}/entries`, { pokemonId, ...extra });
  const list = (qs = '') => client.req('GET', `/api/admin/pokedex?user=${trainer.id}${qs}`);
  // Cattura "vera" durante una sessione manuale e una durante una diretta Twitch simulata.
  const captureVia = (source, pokemonId) => {
    if (source === 'manual') app.engine.startManual(); else app.engine.activateLive({ broadcastId: `b-${pokemonId}` });
    app.engine.spawn({ source: 'manual', pokemonId });
    app.engine.rng = () => 0;
    const ball = app.db.get("SELECT id FROM ball_types WHERE code = 'pokeball'").id;
    if (source === 'twitch') {
      app.db.run("INSERT OR IGNORE INTO twitch_rewards (reward_id, ball_type_id, title, managed_by_app) VALUES ('rw-1', ?, 'Poké Ball', 1)", ball);
    }
    const res = app.engine.attempt(source === 'manual'
      ? { redemptionId: `m-${pokemonId}`, ballTypeId: ball, user: { twitchId: '2001', login: 'mario', displayName: 'Mario' }, isDemo: false, source: 'manual' }
      : { redemptionId: `t-${pokemonId}`, rewardId: 'rw-1', user: { twitchId: '2001', login: 'mario', displayName: 'Mario' }, redeemedAt: new Date().toISOString(), isDemo: false });
    assert.equal(res.caught, true, JSON.stringify(res));
    if (source === 'manual') app.engine.stopManual(); else app.engine.deactivate('stream_offline');
  };

  test('1. ricerca per nome e numero, filtri per stato', async () => {
    captureVia('twitch', byslug('pikachu'));
    app.engine.startManual();
    app.engine.spawn({ source: 'manual', pokemonId: byslug('mewtwo') });
    app.engine.rng = () => 0.99;
    app.engine.attempt({ redemptionId: 'm-miss', ballTypeId: 1, user: { twitchId: '2001', login: 'mario', displayName: 'Mario' }, isDemo: false, source: 'manual' });
    app.engine.stopManual();
    const all = await list();
    assert.equal(all.status, 200);
    assert.equal(all.data.total, 4);
    assert.equal((await list('&q=pika')).data.total, 2);
    assert.equal((await list('&q=25')).data.total, 2);
    assert.equal((await list('&q=%23150')).data.items[0].name, 'Mewtwo');
    const caught = await list('&status=caught');
    assert.deepEqual(caught.data.items.map((x) => x.pokemonId), [byslug('pikachu')]);
    assert.deepEqual((await list('&status=seen')).data.items.map((x) => x.pokemonId), [byslug('mewtwo')], 'visto ma non catturato');
    assert.equal((await list('&status=missing')).data.total, 2);
    assert.equal((await list('&status=twitch')).data.total, 1);
    assert.equal((await list('&status=bogus')).status, 400);
  });

  test('2. modifica di un record con anteprima delle modifiche e storico', async () => {
    captureVia('twitch', byslug('pikachu'));
    const e = app.db.get('SELECT * FROM user_pokemon');
    const preview = await client.req('PATCH', `/api/admin/pokedex/entries/${e.id}`, { rev: e.rev, dryRun: true, changes: { shiny: true, note: 'Primo Pikachu', pokemonId: byslug('pikachu-alola-cap') } });
    assert.equal(preview.data.dryRun, true);
    assert.deepEqual(preview.data.diff.map((d) => d.field).sort(), ['is_shiny', 'note', 'pokemon_id']);
    assert.equal(app.db.get('SELECT is_shiny FROM user_pokemon WHERE id = ?', e.id).is_shiny, 0, 'l\'anteprima non salva');
    const r = await client.req('PATCH', `/api/admin/pokedex/entries/${e.id}`, { rev: e.rev, changes: { shiny: true, note: 'Primo Pikachu', pokemonId: byslug('pikachu-alola-cap') } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const after = app.db.get('SELECT * FROM user_pokemon WHERE id = ?', e.id);
    assert.equal(after.is_shiny, 1);
    assert.equal(after.pokemon_id, byslug('pikachu-alola-cap'));
    assert.equal(after.origin, 'twitch', 'l\'origine della cattura resta quella reale');
    assert.equal(after.rev, 1);
    assert.equal(after.updated_by, 'admin');
    assert.ok(after.updated_at);
    const detail = await client.req('GET', `/api/admin/pokedex/${trainer.id}/${byslug('pikachu')}`);
    assert.equal(detail.data.entries[0].corrected, true);
    assert.equal(detail.data.variants.length, 2);
    assert.equal(detail.data.history[0].action, 'pokedex_edit');
    assert.equal(detail.data.history[0].admin, 'admin');
    // Il cambio verso un Pokémon di un'altra specie non è una correzione di forma.
    const other = await client.req('PATCH', `/api/admin/pokedex/entries/${e.id}`, { rev: 1, changes: { pokemonId: byslug('mewtwo') } });
    assert.equal(other.status, 400);
  });

  test('3. registrazione manuale identificabile come tale', async () => {
    const r = await register(byslug('bulbasaur'), { ball: 'Mega Ball', caughtAt: '2026-10-01T18:00:00.000Z', note: 'catturato offline' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const e = app.db.get('SELECT * FROM user_pokemon WHERE id = ?', r.data.entry.id);
    assert.equal(e.origin, 'admin');
    assert.equal(e.source, 'admin');
    assert.equal(e.ball_name, 'Mega Ball');
    assert.equal(e.caught_at, '2026-10-01T18:00:00.000Z');
    assert.equal(e.session_id, null, 'nessuna sessione inventata');
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM capture_attempts').n, 0, 'nessun lancio inventato');
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'pokedex_register'"));
  });

  test('4. rimozione con conferma e revisione', async () => {
    const r = await register(byslug('bulbasaur'));
    const eid = r.data.entry.id;
    assert.equal((await client.req('POST', `/api/admin/pokedex/entries/${eid}/delete`, { rev: 0 })).status, 400, 'senza conferma');
    assert.equal((await client.req('POST', `/api/admin/pokedex/entries/${eid}/delete`, { rev: 5, confirm: true })).status, 409, 'revisione non aggiornata');
    assert.equal((await client.req('POST', `/api/admin/pokedex/entries/${eid}/delete`, { rev: 0, confirm: true })).status, 200);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'pokedex_remove'"));
  });

  test('5. prevenzione dei duplicati: doppione solo in modo esplicito', async () => {
    assert.equal((await register(byslug('bulbasaur'))).status, 200);
    const dup = await register(byslug('bulbasaur'));
    assert.equal(dup.status, 409);
    assert.match(dup.data.error, /già nel Pokédex/);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 1);
    // La forma diversa è un altro record del modello: ammessa.
    assert.equal((await register(byslug('pikachu'))).status, 200);
    assert.equal((await register(byslug('pikachu-alola-cap'))).status, 200);
    assert.equal((await register(byslug('bulbasaur'), { additional: true })).status, 200);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE pokemon_id = ?', byslug('bulbasaur')).n, 2);
  });

  test('6. validazione dei dati e concorrenza', async () => {
    assert.equal((await register(999999)).status, 404);
    assert.equal((await register('abc')).status, 400);
    assert.equal((await register(byslug('bulbasaur'), { caughtAt: '2999-01-01T00:00:00Z' })).status, 400);
    assert.equal((await register(byslug('bulbasaur'), { caughtAt: 'ieri' })).status, 400);
    assert.equal((await register(byslug('bulbasaur'), { note: 'x'.repeat(501) })).status, 400);
    assert.equal((await client.req('POST', '/api/admin/pokedex/999/entries', { pokemonId: byslug('bulbasaur') })).status, 404);
    app.db.run("UPDATE pokemon SET shiny_enabled = 0 WHERE slug = 'mewtwo'");
    assert.equal((await register(byslug('mewtwo'), { shiny: true })).status, 400);
    const r = await register(byslug('bulbasaur'));
    const eid = r.data.entry.id;
    // Due modifiche dalla stessa revisione: la seconda viene rifiutata, nessuna sovrascrittura.
    assert.equal((await client.req('PATCH', `/api/admin/pokedex/entries/${eid}`, { rev: 0, changes: { note: 'A' } })).status, 200);
    const second = await client.req('PATCH', `/api/admin/pokedex/entries/${eid}`, { rev: 0, changes: { note: 'B' } });
    assert.equal(second.status, 409);
    assert.equal(app.db.get('SELECT note FROM user_pokemon WHERE id = ?', eid).note, 'A');
    assert.equal(second.data.details.current.rev, 1);
    // Campi non previsti ignorati (niente modifiche di colonne arbitrarie).
    const inj = await client.req('PATCH', `/api/admin/pokedex/entries/${eid}`, { rev: 1, changes: { origin: 'twitch', user_id: 1, 'note = 1; --': 'x' } });
    assert.equal(inj.data.unchanged, true);
    assert.equal(app.db.get('SELECT origin FROM user_pokemon WHERE id = ?', eid).origin, 'admin');
    assert.equal((await client.req('PATCH', `/api/admin/pokedex/entries/${eid}`, { changes: { note: 'x' } })).status, 400, 'revisione obbligatoria');
    // Protezione delle API.
    assert.equal((await client.req('GET', `/api/admin/pokedex?user=${trainer.id}`, undefined, { auth: false })).status, 401);
    assert.equal((await client.req('POST', `/api/admin/pokedex/${trainer.id}/entries`, { pokemonId: byslug('mewtwo') }, { csrfToken: 'x' })).status, 403);
  });

  test('7. persistenza dopo il riavvio', async () => {
    const r = await register(byslug('bulbasaur'), { note: 'resta' });
    await app.close();
    ({ app } = await makeApp({ dir: ctx.dir, configureTwitch: false, env: { BACKUP_TARGET_ROOT: root } }));
    const e = app.db.get('SELECT * FROM user_pokemon WHERE id = ?', r.data.entry.id);
    assert.equal(e.note, 'resta');
    assert.equal(e.origin, 'admin');
  });

  test('8. separazione TWITCH, MANUAL e registrazioni amministrative; storico dei lanci intatto', async () => {
    captureVia('twitch', byslug('pikachu'));
    captureVia('manual', byslug('bulbasaur'));
    await register(byslug('mewtwo'));
    const sum = (await list()).data.summary;
    assert.deepEqual({ twitch: sum.twitch, manual: sum.manual, admin: sum.admin }, { twitch: 1, manual: 1, admin: 1 });
    const kinds = app.db.all('SELECT up.origin, s.kind FROM user_pokemon up LEFT JOIN stream_sessions s ON s.id = up.session_id ORDER BY up.id');
    assert.deepEqual(kinds.map((k) => [k.origin, k.kind]), [['twitch', 'twitch'], ['manual', 'manual'], ['admin', null]]);
    const attemptsBefore = JSON.stringify(app.db.all('SELECT * FROM capture_attempts ORDER BY id'));
    const sessionsBefore = JSON.stringify(app.db.all('SELECT * FROM stream_sessions ORDER BY id'));
    const twitchEntry = app.db.get("SELECT * FROM user_pokemon WHERE origin = 'twitch'");
    await client.req('POST', `/api/admin/pokedex/entries/${twitchEntry.id}/delete`, { rev: twitchEntry.rev, confirm: true });
    assert.equal(JSON.stringify(app.db.all('SELECT * FROM capture_attempts ORDER BY id')).replace(/"user_pokemon_id":\d+/g, '"user_pokemon_id":null'),
      attemptsBefore.replace(/"user_pokemon_id":\d+/g, '"user_pokemon_id":null'), 'storico dei lanci non riscritto');
    assert.equal(JSON.stringify(app.db.all('SELECT * FROM stream_sessions ORDER BY id')), sessionsBefore, 'sessioni invariate');
    const sessions = await client.req('GET', '/api/admin/sessions?kind=real');
    assert.deepEqual(sessions.data.items.map((s) => s.kind).sort(), ['manual', 'twitch']);
  });

  test('9. la dashboard viene avvisata delle modifiche', async () => {
    const events = [];
    const orig = app.hub.admin.bind(app.hub);
    app.hub.admin = (type, data) => { events.push([type, data]); return orig(type, data); };
    await register(byslug('bulbasaur'));
    assert.ok(events.some(([t, d]) => t === 'pokedex' && d.userId === trainer.id));
  });

  test('10. backup e ripristino delle modifiche al Pokédex', async () => {
    const r = await register(byslug('bulbasaur'), { note: 'nel backup' });
    const b = await app.networkBackups.create('manual');
    await client.req('POST', `/api/admin/pokedex/entries/${r.data.entry.id}/delete`, { rev: 0, confirm: true });
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);
    const v = await client.req('POST', `/api/admin/backups/network/${b.file}/verify`, {});
    assert.equal(v.data.ok, true);
    assert.equal(v.data.contents.pokedexEntries, 1);
    const res = await client.req('POST', `/api/admin/backups/network/${b.file}/restore`, { confirm: 'RIPRISTINA', sha256: v.data.manifest.archive.sha256 });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const e = app.db.get('SELECT * FROM user_pokemon');
    assert.equal(e.note, 'nel backup');
    assert.equal(e.origin, 'admin');
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'pokedex_register'"), 'storico delle modifiche ripristinato');
  });
});
