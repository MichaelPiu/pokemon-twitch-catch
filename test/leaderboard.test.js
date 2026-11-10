// Classifiche, risultati congelati, comando !leaderboard, overlay, Hall of Fame,
// Stream Recap, profili dei giocatori, backup e migrazione.
// Le catture passano sempre dal vero motore (EventSub simulato per le dirette,
// API della dashboard per le sessioni manuali): nessun evento inventato.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID, adminClient,
  legacyDatabase, tempDir,
} from './helpers.js';
import { overlaySocket } from './overlay-helpers.js';
import { installDom, loadOverlay } from './dom-shim.js';
import { computePoints, recordCaptureEvent, DEFAULT_RULES } from '../src/leaderboard/scoring.js';
import { Database } from '../src/database/index.js';
import { LATEST_SCHEMA } from '../src/database/migrations.js';
import { effectiveSettings, defaultConfig } from '../public/assets/js/overlay/theme-core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pokémon di prova: 1 comune, 2 non comune, 3 raro, 4 leggendario.
const MON = { common: 1, uncommon: 2, rare: 3, legendary: 4 };

describe('Classifiche', () => {
  let ctx, app, tw, es, rng, client, reward, seq;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    rng = seqRng();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    app = ctx.app;
    seedPokemon(app.db);
    reward = linkReward(app, 'pokeball');
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE', { message: 'stato OFFLINE' });
    client = await adminClient(app);
    seq = 0;
  });

  afterEach(async () => {
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const goLive = async (id = 'b-live') => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE', { message: 'stato LIVE' });
  };
  const goOffline = async () => {
    tw.live = null;
    es.notify('stream.offline', { broadcaster_user_id: BROADCASTER_ID });
    await waitFor(() => app.sm.state === 'OFFLINE' && !app.engine.sessions.current('twitch'), { message: 'stato OFFLINE' });
  };
  const events = () => app.db.get('SELECT COUNT(*) AS n FROM leaderboard_events').n;
  const spawn = async (pokemonId, shiny = false) => {
    const r = await client.req('POST', '/api/admin/spawn/manual', { pokemonId, shiny });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  // Cattura reale durante una diretta: riscatto dei punti canale via EventSub.
  const twitchCatch = async (user, pokemonId, { shiny = false, id = `red-${++seq}` } = {}) => {
    await spawn(pokemonId, shiny);
    rng.push(0.0);
    const before = app.db.get('SELECT COUNT(*) AS n FROM capture_attempts').n;
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id, rewardId: reward.rewardId, userId: user.id, login: user.login, name: user.name }));
    await waitFor(() => app.db.get('SELECT COUNT(*) AS n FROM capture_attempts').n > before, { message: 'riscatto elaborato' });
    return id;
  };
  // Cattura durante una sessione manuale (lancio dalla dashboard).
  const manualCatch = async (body, pokemonId, { shiny = false } = {}) => {
    await spawn(pokemonId, shiny);
    rng.push(0.0);
    const r = await client.req('POST', '/api/admin/game/manual/throw', { ballTypeId: reward.ball.id, ...body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.caught, true);
    return r.data;
  };
  // Messaggio in chat consegnato da EventSub; attende che il monitor l'abbia elaborato.
  const chat = async (user, text, { badges = [] } = {}) => {
    const before = tw.chat.length;
    const mid = es.notify('channel.chat.message', { broadcaster_user_id: BROADCASTER_ID, chatter_user_id: user.id, chatter_user_login: user.login, chatter_user_name: user.name, message_id: `chat-${++seq}`, message: { text }, badges });
    await waitFor(() => app.db.get("SELECT detail FROM twitch_events WHERE message_id = ? AND status != 'received'", mid), { message: 'chat elaborata' });
    await sleep(30); // invio della risposta (coda della chat)
    return tw.chat.slice(before);
  };
  const MARIO = { id: '2001', login: 'mario', name: 'Mario' };
  const LUIGI = { id: '2002', login: 'luigi', name: 'Luigi' };
  const PEACH = { id: '2003', login: 'peach', name: 'Peach' };
  const STREAMER = { id: BROADCASTER_ID, login: 'streamer', name: 'Streamer' };
  const MOD = { id: '2100', login: 'moddy', name: 'Moddy' };
  const MODBADGE = [{ set_id: 'moderator', id: '1', info: '' }];
  const board = async (sessionId = 'current') => (await client.req('GET', `/api/admin/leaderboard?sessionId=${sessionId}`)).data;

  test('1. classifica catture: una cattura = un punto, indipendente dalla rarità', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.common);
    await twitchCatch(MARIO, MON.common);
    await twitchCatch(MARIO, MON.common);
    await twitchCatch(LUIGI, MON.legendary);
    const d = await board();
    assert.deepEqual(d.view.captures.map((r) => [r.rank, r.name, r.captures]), [[1, 'Mario', 3], [2, 'Luigi', 1]]);
    assert.equal(d.view.session.kind, 'twitch');
    assert.equal(d.view.session.status, 'live');
    assert.equal(d.view.totals.participants, 2);
  });

  test('2. classifica punti: base + rarità + shiny, ordine diverso da quella catture', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.common); // 10
    await twitchCatch(MARIO, MON.common); // 10
    await twitchCatch(LUIGI, MON.legendary); // 60
    const d = await board();
    assert.deepEqual(d.view.points.map((r) => [r.rank, r.name, r.points]), [[1, 'Luigi', 60], [2, 'Mario', 20]]);
    assert.deepEqual(d.view.captures.map((r) => r.name), ['Mario', 'Luigi']);
    assert.equal(d.view.points[0].rarest.rarity, 'legendary', 'Pokémon più raro dal dato reale');
    assert.equal(d.view.points[1].species, 1);
  });

  test('3. bonus rarità dai dati reali del Pokémon; rarità assente = solo punti base', async () => {
    await goLive();
    for (const [user, mon] of [[MARIO, MON.common], [LUIGI, MON.uncommon], [PEACH, MON.rare]]) await twitchCatch(user, mon);
    const rows = app.db.all('SELECT rarity, base_points, rarity_bonus, points FROM leaderboard_events ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.rarity, r.base_points, r.rarity_bonus, r.points]), [['common', 10, 0, 10], ['uncommon', 10, 5, 15], ['rare', 10, 15, 25]]);
    const rules = app.leaderboard.rules();
    assert.deepEqual(computePoints(rules, { rarity: 'epic', shiny: false }), { base: 10, rarityBonus: 30, shinyBonus: 0, total: 40 });
    assert.deepEqual(computePoints(rules, { rarity: 'legendary', shiny: false }).total, 60);
    assert.deepEqual(computePoints(rules, { rarity: null, shiny: false }), { base: 10, rarityBonus: 0, shinyBonus: 0, total: 10 });
    assert.deepEqual(computePoints(rules, { rarity: 'sconosciuta', shiny: false }).total, 10);
    assert.deepEqual(DEFAULT_RULES.rarity, { common: 0, uncommon: 5, rare: 15, epic: 30, legendary: 50, mythical: 50 });
  });

  test('4. bonus shiny', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.common, { shiny: true });
    const e = app.db.get('SELECT * FROM leaderboard_events');
    assert.equal(e.is_shiny, 1);
    assert.equal(e.shiny_bonus, 50);
    assert.equal(e.points, 60);
    const d = await board();
    assert.equal(d.view.points[0].shiny, 1);
    assert.equal(d.view.totals.shiny, 1);
  });

  test('5. punteggi salvati alla cattura: nuove regole non cambiano i punti già assegnati', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const r = await client.req('PUT', '/api/admin/leaderboard/rules', { base: 100, shiny: 0, rarity: { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythical: 5 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.changed, true);
    assert.equal(r.data.rules.version, 2);
    await twitchCatch(LUIGI, MON.rare);
    const rows = app.db.all('SELECT user_id, points, rules_version FROM leaderboard_events ORDER BY id');
    assert.deepEqual(rows.map((x) => [x.points, x.rules_version]), [[25, 1], [102, 2]]);
    const d = await board();
    assert.deepEqual(d.view.points.map((x) => [x.name, x.points]), [['Luigi', 102], ['Mario', 25]]);
    // Gli eventi non si possono riscrivere, nemmeno con SQL diretto.
    assert.throws(() => app.db.run('UPDATE leaderboard_events SET points = 999, base_points = 999 WHERE id = 1'), /immutabile/);
    assert.equal((await client.req('PUT', '/api/admin/leaderboard/rules', { base: -1, shiny: 0, rarity: {} })).status, 400);
    assert.equal((await client.req('PUT', '/api/admin/leaderboard/rules', { base: 100, shiny: 0, rarity: { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythical: 5 } })).data.changed, false, 'regole identiche: nessuna nuova versione');
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'leaderboard_rules_update'"));
  });

  test('6. cambio nickname su Twitch: stesso profilo, statistiche conservate, nome precedente nello storico', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.common);
    await twitchCatch({ ...MARIO, login: 'super_mario', name: 'SuperMario' }, MON.rare);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM twitch_users WHERE twitch_id = '2001'").n, 1);
    const d = await board();
    assert.equal(d.view.captures.length, 1);
    assert.deepEqual([d.view.captures[0].name, d.view.captures[0].captures, d.view.captures[0].points], ['SuperMario', 2, 35]);
    const uid = d.view.captures[0].userId;
    const p = (await client.req('GET', `/api/admin/players/${uid}`)).data;
    assert.equal(p.twitchId, '2001');
    assert.ok(p.aliases.some((a) => a.kind === 'twitch' && a.display_name === 'Mario' && a.login === 'mario'));
    const found = (await client.req('GET', '/api/admin/players?q=mario')).data.players;
    assert.equal(found.length, 1, 'ricerca anche per nickname precedente, senza duplicati');
  });

  test('7. identità Twitch tramite User ID: stesso nome con un altro ID è un altro giocatore', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.common);
    await twitchCatch({ id: '9999', login: 'mario', name: 'Mario' }, MON.common); // impostore con lo stesso nome
    const d = await board();
    assert.equal(d.view.captures.length, 2);
    assert.deepEqual(d.view.captures.map((r) => r.captures), [1, 1]);
    const ids = app.db.all("SELECT twitch_id FROM twitch_users WHERE login = 'mario' ORDER BY twitch_id").map((r) => r.twitch_id);
    assert.deepEqual(ids, ['2001', '9999']);
  });

  test('8. identità locale MANUAL: ID locale stabile, distinto da Twitch, mai un Twitch ID inventato', async () => {
    assert.equal((await client.req('POST', '/api/admin/game/manual/start', {})).status, 200);
    await manualCatch({ name: 'Ash' }, MON.common);
    await manualCatch({ name: 'Ash' }, MON.rare);
    const u = app.db.get("SELECT * FROM twitch_users WHERE origin = 'local'");
    assert.equal(u.twitch_id, 'local:ash');
    const d = await board();
    assert.equal(d.view.session.kind, 'manual');
    assert.deepEqual([d.view.captures[0].name, d.view.captures[0].captures, d.view.captures[0].origin], ['Ash', 2, 'local']);
    const p = (await client.req('GET', `/api/admin/players/${u.id}`)).data;
    assert.equal(p.twitchId, null, 'nessun Twitch ID per un giocatore locale');
    assert.equal(p.localId, 'local:ash');
    // Uno spettatore Twitch chiamato "ash" resta un profilo separato.
    await client.req('POST', '/api/admin/game/manual/stop', {});
    await goLive();
    await twitchCatch({ id: '3003', login: 'ash', name: 'Ash' }, MON.common);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM twitch_users WHERE login = 'ash'").n, 2);
  });

  test('9. sessioni Twitch e MANUAL separate: ogni cattura solo nella classifica della propria sessione', async () => {
    await client.req('POST', '/api/admin/game/manual/start', {});
    const manualId = app.engine.session.id;
    await manualCatch({ name: 'Ash' }, MON.common);
    await client.req('POST', '/api/admin/game/manual/stop', {});
    await goLive();
    const liveId = app.engine.session.id;
    await twitchCatch(MARIO, MON.rare);
    const m = await board(manualId);
    const t = await board(liveId);
    assert.deepEqual(m.view.captures.map((r) => r.name), ['Ash']);
    assert.deepEqual(t.view.captures.map((r) => r.name), ['Mario']);
    assert.equal(m.view.session.kind, 'manual');
    assert.equal(t.view.session.kind, 'twitch');
    assert.deepEqual(app.db.all('SELECT session_kind FROM leaderboard_events ORDER BY id').map((r) => r.session_kind), ['manual', 'twitch']);
    const list = (await client.req('GET', '/api/admin/leaderboard/sessions?kind=manual')).data.sessions;
    assert.deepEqual(list.map((s) => s.id), [manualId]);
  });

  test('10. sessioni DEMO escluse da classifiche, Hall of Fame e riepiloghi', async () => {
    app.adminSettings.set('demo', { enabled: true });
    assert.equal((await client.req('POST', '/api/admin/demo/start', {})).status, 200);
    const demoId = app.engine.session.id;
    await spawn(MON.legendary);
    rng.push(0.0);
    const t = await client.req('POST', '/api/admin/demo/throw', { username: 'Tester', ballTypeId: reward.ball.id });
    assert.equal(t.data.caught, true);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE is_demo = 1').n, 1);
    assert.equal(events(), 0, 'nessun evento di classifica dalla DEMO');
    assert.equal((await client.req('GET', `/api/admin/leaderboard?sessionId=${demoId}`)).data.view, null);
    await client.req('POST', '/api/admin/demo/stop', {});
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM stream_recaps').n, 0);
    assert.equal((await client.req('GET', '/api/admin/leaderboard/halloffame')).data.totals.captures, 0);
    assert.equal(recordCaptureEvent(app.db, { attemptId: 1, sessionId: demoId, userId: 1, pokemonId: 1, rarity: 'common' }), null);
  });

  test('11. registrazioni e modifiche amministrative del Pokédex escluse', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.common);
    const uid = app.db.get("SELECT id FROM twitch_users WHERE twitch_id = '2001'").id;
    const add = await client.req('POST', `/api/admin/pokedex/${uid}/entries`, { pokemonId: MON.legendary });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    assert.equal(events(), 1, 'la registrazione manuale non assegna punti');
    // Rimozione dal Pokédex di un esemplare catturato: lo storico competitivo resta.
    const up = app.db.get("SELECT id, rev FROM user_pokemon WHERE origin = 'twitch'");
    assert.equal((await client.req('POST', `/api/admin/pokedex/entries/${up.id}/delete`, { confirm: true, rev: up.rev })).status, 200);
    const d = await board();
    assert.deepEqual(d.view.points.map((r) => [r.name, r.captures, r.points]), [['Mario', 1, 10]]);
    assert.equal(app.db.get('SELECT user_pokemon_id FROM leaderboard_events').user_pokemon_id, null);
  });

  test('12. nessun doppio conteggio: riscatto duplicato, evento duplicato, vincolo univoco', async () => {
    await goLive();
    const id = await twitchCatch(MARIO, MON.common);
    // Stesso riscatto consegnato di nuovo da Twitch (messaggio diverso, stesso redemption id).
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id, rewardId: reward.rewardId, userId: MARIO.id, login: MARIO.login, name: MARIO.name }));
    await sleep(80);
    assert.equal(events(), 1);
    const e = app.db.get('SELECT * FROM leaderboard_events');
    const again = app.db.tx(() => recordCaptureEvent(app.db, { attemptId: e.capture_attempt_id, sessionId: e.session_id, userId: e.user_id, pokemonId: e.pokemon_id, rarity: 'common' }));
    assert.equal(again, null, 'stessa cattura: nessun nuovo evento');
    assert.throws(() => app.db.run(`INSERT INTO leaderboard_events (capture_attempt_id, session_id, session_kind, user_id, pokemon_id, base_points, rarity_bonus, shiny_bonus, points, rules_version, caught_at)
      VALUES (?, ?, 'twitch', ?, 1, 10, 0, 0, 10, 1, 'x')`, e.capture_attempt_id, e.session_id, e.user_id), /UNIQUE/);
    assert.equal((await board()).view.captures[0].captures, 1);
  });

  test('12b. cattura annullata su Twitch (riscatto revocato): esce dalla classifica live', async () => {
    app.gameSettings.set('capture', { ...app.gameSettings.get('capture'), revokeOnCancel: true });
    await goLive();
    const id = await twitchCatch(MARIO, MON.rare);
    await twitchCatch(LUIGI, MON.common);
    es.notify('channel.channel_points_custom_reward_redemption.update', { ...redemption({ id, rewardId: reward.rewardId, userId: MARIO.id }), status: 'canceled' });
    await waitFor(() => app.db.get('SELECT voided_at FROM leaderboard_events WHERE id = 1').voided_at, { message: 'evento annullato' });
    const d = await board();
    assert.deepEqual(d.view.points.map((r) => r.name), ['Luigi']);
    assert.equal(events(), 2, 'l\'evento resta nel database, marcato come annullato');
  });

  test('13. comandi Twitch autorizzati: broadcaster (tutti) e moderatori (tranne freeze)', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    let out = await chat(MOD, '!leaderboard', { badges: MODBADGE });
    assert.equal(app.leaderboard.display().visible, true);
    assert.equal(app.leaderboard.display().via, 'chat');
    assert.match(out.at(-1)?.message || '', /Classifica/);
    await sleep(3100); // cooldown del comando
    out = await chat(MOD, '!leaderboard winner', { badges: MODBADGE });
    assert.equal(app.leaderboard.display().screen, 'winner');
    assert.match(out.at(-1)?.message || '', /Vincitore: Mario/);
    await sleep(3100);
    await chat(STREAMER, '!leaderboard freeze');
    assert.ok(app.leaderboard.activeSnapshot(app.engine.session.id), 'congelata dal broadcaster');
    assert.equal(app.db.get("SELECT created_via FROM leaderboard_snapshots").created_via, 'chat');
    await sleep(3100);
    await chat(MOD, '!leaderboard hide', { badges: MODBADGE });
    assert.equal(app.leaderboard.display().visible, false);
    const log = app.db.all("SELECT action, admin FROM admin_audit WHERE action LIKE 'leaderboard_%' ORDER BY id").map((r) => `${r.action}:${r.admin}`);
    assert.deepEqual(log, ['leaderboard_show:twitch:moddy', 'leaderboard_show:twitch:moddy', 'leaderboard_freeze:twitch:streamer', 'leaderboard_hide:twitch:moddy']);
  });

  test('14. comandi non autorizzati rifiutati (spettatore, nickname falsificato, moderatore e freeze, lista moderatori)', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    let out = await chat(MARIO, '!leaderboard');
    assert.equal(app.leaderboard.display().visible, false);
    assert.equal(out.length, 0, 'nessuna risposta in chat a chi non è autorizzato');
    // Nickname del broadcaster con un altro ID: non conta.
    await chat({ id: '6666', login: 'streamer', name: 'Streamer' }, '!leaderboard');
    assert.equal(app.leaderboard.display().visible, false);
    // Il moderatore non può congelare.
    await chat(MOD, '!leaderboard freeze', { badges: MODBADGE });
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM leaderboard_snapshots').n, 0);
    // Solo i moderatori in elenco.
    assert.equal((await client.req('PUT', '/api/admin/leaderboard/commands', { moderatorIds: ['2200'] })).status, 200);
    await chat(MOD, '!leaderboard', { badges: MODBADGE });
    assert.equal(app.leaderboard.display().visible, false);
    assert.equal((await client.req('PUT', '/api/admin/leaderboard/commands', { moderatorIds: ['abc'] })).status, 400);
    assert.ok(app.commands.unauthorized >= 4);
    // Un rifiuto non consuma il cooldown: il broadcaster può subito usare il comando.
    await chat(STREAMER, '!leaderboard');
    assert.equal(app.leaderboard.display().visible, true);
    // In una sessione MANUAL il comando non è disponibile.
    await client.req('POST', '/api/admin/leaderboard/hide', {});
    await goOffline();
    await client.req('POST', '/api/admin/game/manual/start', {});
    assert.equal(app.commands.handle({ text: '!leaderboard', user: { twitchId: BROADCASTER_ID, login: 'streamer' }, isBroadcaster: true }, {})?.ignored, 'unauthorized');
    assert.equal(app.leaderboard.chatCommand('', { user: { twitchId: BROADCASTER_ID, login: 'streamer' } }), null);
    assert.equal(app.leaderboard.display().visible, false);
    // Prova dalla dashboard: descrizione, nessuna azione.
    const p = await client.req('POST', '/api/admin/commands/test', { text: '!leaderboard winner' });
    assert.match(p.data.reply, /nessuna azione/);
    assert.equal(app.leaderboard.display().visible, false);
  });

  test('15. attivazione dalla dashboard: classifica, podio, vincitore, riepilogo, Hall of Fame', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const sid = app.engine.session.id;
    for (const screen of ['board', 'podium', 'recap']) {
      const r = await client.req('POST', '/api/admin/leaderboard/show', { sessionId: sid, screen, board: 'captures' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(app.leaderboard.overlayPayload().screen, screen);
    }
    const w = await client.req('POST', '/api/admin/leaderboard/winner', { sessionId: sid, board: 'points' });
    assert.equal(w.data.winner.name, 'Mario');
    const h = await client.req('POST', '/api/admin/leaderboard/show', { screen: 'halloffame', hofKind: 'twitch' });
    assert.equal(h.status, 200);
    assert.equal(app.leaderboard.overlayPayload().hallOfFame.kind, 'twitch');
    assert.equal((await client.req('POST', '/api/admin/leaderboard/show', { screen: 'nope' })).status, 400);
    // Anteprima: nessuna modifica a ciò che vede OBS.
    const before = app.leaderboard.display();
    const pv = await client.req('GET', `/api/admin/leaderboard/preview?sessionId=${sid}&screen=podium&board=points`);
    assert.equal(pv.data.preview, true);
    assert.equal(pv.data.points[0].name, 'Mario');
    assert.deepEqual(app.leaderboard.display(), before);
  });

  test('16. attivazione tramite comando: la schermata segue la diretta corrente', async () => {
    await goLive();
    await twitchCatch(LUIGI, MON.common);
    await chat(STREAMER, '!leaderboard');
    const p = app.leaderboard.overlayPayload();
    assert.equal(p.visible, true);
    assert.equal(p.session.id, app.engine.session.id);
    assert.equal(p.session.kind, 'twitch');
    assert.equal(p.points[0].name, 'Luigi');
  });

  test('17. nascondere la classifica', async () => {
    await goLive();
    await client.req('POST', '/api/admin/leaderboard/show', { sessionId: 'current' });
    const r = await client.req('POST', '/api/admin/leaderboard/hide', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.display.visible, false);
    assert.deepEqual(app.leaderboard.overlayPayload().visible, false);
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'leaderboard_hide'"));
  });

  test('18. persistenza dopo il riavvio: schermata visibile e risultati congelati restano', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const sid = app.engine.session.id;
    await client.req('POST', '/api/admin/leaderboard/freeze', { sessionId: sid });
    await client.req('POST', '/api/admin/leaderboard/show', { sessionId: sid, screen: 'podium' });
    await app.close();
    await es.stop();
    ({ app } = await makeApp({ dir: ctx.dir, twitch: tw, eventsub: es = await new FakeEventSub().start(), rng }));
    ctx.app = app;
    const p = app.leaderboard.overlayPayload();
    assert.equal(p.visible, true);
    assert.equal(p.screen, 'podium');
    assert.equal(p.session.id, sid);
    assert.equal(p.session.status, 'frozen');
    assert.equal(p.points[0].name, 'Mario');
    const port = await app.listen(0, '127.0.0.1');
    const snap = await (await fetch(`http://127.0.0.1:${port}/api/public/overlay`)).json();
    assert.equal(snap.leaderboard.visible, true, 'l\'overlay riceve la schermata all\'avvio');
  });

  test('19. congelamento: istantanea definitiva, nessun aggiornamento automatico, resta dopo la fine', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const sid = app.engine.session.id;
    const f = await client.req('POST', '/api/admin/leaderboard/freeze', { sessionId: sid });
    assert.equal(f.status, 200, JSON.stringify(f.data));
    assert.equal(f.data.version, 1);
    await twitchCatch(LUIGI, MON.legendary); // dopo il congelamento
    let d = await board(sid);
    assert.equal(d.view.source, 'snapshot');
    assert.equal(d.view.session.status, 'frozen');
    assert.deepEqual(d.view.points.map((r) => r.name), ['Mario'], 'la classifica congelata non cambia');
    assert.equal(d.view.pendingSinceFreeze, 1);
    assert.equal(events(), 2, 'la cattura è comunque registrata');
    await goOffline();
    d = await board(sid);
    assert.equal(d.view.session.status, 'frozen');
    assert.deepEqual(d.view.points.map((r) => r.name), ['Mario']);
    assert.equal(app.db.get('SELECT source FROM stream_recaps WHERE session_id = ?', sid).source, 'snapshot', 'il riepilogo usa i risultati congelati');
  });

  test('20. sblocco amministrativo: conferma e motivazione obbligatorie, registrato nel registro', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const sid = app.engine.session.id;
    await client.req('POST', '/api/admin/leaderboard/freeze', { sessionId: sid });
    await twitchCatch(LUIGI, MON.legendary);
    assert.equal((await client.req('POST', '/api/admin/leaderboard/unfreeze', { sessionId: sid, reason: 'correzione' })).status, 400, 'senza conferma');
    assert.equal((await client.req('POST', '/api/admin/leaderboard/unfreeze', { sessionId: sid, confirm: true, reason: 'no' })).status, 400, 'motivazione troppo breve');
    const u = await client.req('POST', '/api/admin/leaderboard/unfreeze', { sessionId: sid, confirm: true, reason: 'cattura di Luigi da includere' });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.equal(u.data.view.session.status, 'live');
    assert.deepEqual(u.data.view.points.map((r) => r.name), ['Luigi', 'Mario']);
    const a = app.db.get("SELECT * FROM admin_audit WHERE action = 'leaderboard_unfreeze'");
    const det = JSON.parse(a.detail);
    assert.equal(det.reason, 'cattura di Luigi da includere');
    assert.equal(det.changesSinceFreeze.captures, 1);
    assert.equal(det.changesSinceFreeze.rankingChanged, true);
    const old = app.db.get('SELECT * FROM leaderboard_snapshots WHERE session_id = ?', sid);
    assert.equal(old.status, 'unlocked');
    assert.equal(old.unlock_reason, 'cattura di Luigi da includere');
    // Nuovo congelamento = nuova versione, la precedente resta.
    const f2 = await client.req('POST', '/api/admin/leaderboard/freeze', { sessionId: sid });
    assert.equal(f2.data.version, 2);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE session_id = ?', sid).n, 2);
  });

  test('21. istantanee immutabili: niente sovrascritture, modifiche o cancellazioni', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const sid = app.engine.session.id;
    await client.req('POST', '/api/admin/leaderboard/freeze', { sessionId: sid });
    const again = await client.req('POST', '/api/admin/leaderboard/freeze', { sessionId: sid });
    assert.equal(again.status, 409, 'nessuna sovrascrittura silenziosa');
    const snap = app.db.get('SELECT * FROM leaderboard_snapshots');
    assert.equal(app.leaderboard.verifySnapshot(snap.id), true);
    assert.throws(() => app.db.run("UPDATE leaderboard_snapshots SET data = '{}' WHERE id = ?", snap.id), /immutabile/);
    assert.throws(() => app.db.run('DELETE FROM leaderboard_snapshots WHERE id = ?', snap.id), /non si cancellano/);
    // Una rinomina successiva non tocca l'istantanea.
    const uid = app.db.get("SELECT id FROM twitch_users WHERE twitch_id = '2001'").id;
    assert.equal((await client.req('PUT', `/api/admin/players/${uid}/name`, { name: 'Campione' })).status, 200);
    assert.equal((await board(sid)).view.points[0].name, 'Mario', 'nome congelato');
    assert.equal(app.db.get('SELECT data FROM leaderboard_snapshots WHERE id = ?', snap.id).data, snap.data);
    await client.req('POST', '/api/admin/leaderboard/unfreeze', { sessionId: sid, confirm: true, reason: 'prova di sblocco' });
    assert.throws(() => app.db.run("UPDATE leaderboard_snapshots SET status = 'active' WHERE id = ?", snap.id), /già sbloccata/);
    assert.equal((await board(sid)).view.points[0].name, 'Campione', 'classifica live con il nome scelto');
  });

  test('21b. rinomina dalla dashboard: audit, storico dei nomi, catture storiche invariate', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const uid = app.db.get("SELECT id FROM twitch_users WHERE twitch_id = '2001'").id;
    const before = JSON.stringify(app.db.all('SELECT * FROM leaderboard_events'));
    const bad = await client.req('PUT', `/api/admin/players/${uid}/name`, { name: '<script>' });
    assert.equal(bad.status, 400);
    const r = await client.req('PUT', `/api/admin/players/${uid}/name`, { name: 'Il Grande Mario' });
    assert.equal(r.data.name, 'Il Grande Mario');
    assert.equal(r.data.twitchName, 'Mario');
    assert.equal(JSON.stringify(app.db.all('SELECT * FROM leaderboard_events')), before);
    await twitchCatch(MARIO, MON.common); // il nickname Twitch non sovrascrive il nome scelto
    assert.equal((await board()).view.captures[0].name, 'Il Grande Mario');
    const reset = await client.req('PUT', `/api/admin/players/${uid}/name`, { name: null });
    assert.equal(reset.data.name, 'Mario');
    assert.equal(app.db.all("SELECT * FROM admin_audit WHERE action = 'player_rename'").length, 2);
    assert.equal(reset.data.aliases.filter((a) => a.kind === 'admin').length, 2);
  });

  test('22. aggiornamento WebSocket: l\'overlay riceve la classifica e ogni nuova cattura', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.common);
    const port = app.server.address().port;
    const o = overlaySocket(port);
    await o.open;
    await waitFor(() => o.msgs.some((m) => m.type === 'snapshot'), { message: 'snapshot' });
    assert.equal(o.msgs.find((m) => m.type === 'snapshot').data.leaderboard.visible, false);
    await client.req('POST', '/api/admin/leaderboard/show', { sessionId: 'current', screen: 'board', board: 'points' });
    await waitFor(() => o.msgs.some((m) => m.type === 'leaderboard' && m.data.visible), { message: 'classifica mostrata' });
    await twitchCatch(LUIGI, MON.legendary);
    const last = await waitFor(() => o.msgs.filter((m) => m.type === 'leaderboard').find((m) => m.data.points?.[0]?.name === 'Luigi'), { message: 'aggiornamento dopo la cattura' });
    assert.equal(last.data.points.length, 2);
    assert.equal(last.data.session.status, 'live');
    o.ws.close();
  });

  test('23. overlay OBS: le schermate si disegnano e non spariscono a fine diretta', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare, { shiny: true });
    await twitchCatch(LUIGI, MON.common);
    const sid = app.engine.session.id;
    const payload = (screen, board = 'points') => app.leaderboard.screenPayload({ visible: true, screen, board, sessionId: sid, hofKind: 'all', rev: 10 });
    // Il DOM di prova sostituisce fetch, window, document e location: ripristinati alla fine.
    const saved = Object.fromEntries(['fetch', 'window', 'document', 'location'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    const env = installDom({ settings: effectiveSettings({ base: 'classic', name: 'Classico', config: defaultConfig('classic') }) });
    try {
    const state = await loadOverlay(env);
    env.post('leaderboard', payload('board'));
    let lb = state().leaderboard;
    assert.equal(lb.visible, true);
    assert.equal(lb.screen, 'board');
    assert.equal(lb.rows, 2);
    const texts = env.doc.querySelectorAll('.lb-name').map((n) => n.textContent);
    assert.deepEqual(texts, ['Mario', 'Luigi']);
    assert.ok(env.doc.querySelector('.kind-twitch'), 'sessione Twitch indicata');
    assert.ok(env.doc.querySelector('.st-live'), 'classifica live indicata');
    env.post('leaderboard', { ...payload('podium'), rev: 11 });
    assert.equal(env.doc.querySelectorAll('.lb-step').length, 3);
    env.post('leaderboard', { ...payload('winner'), rev: 12 });
    assert.equal(env.doc.querySelector('.lb-win-name').textContent, 'Mario');
    // Fine diretta e azzeramento dell'overlay: la classifica resta.
    env.post('state', { active: false });
    env.post('clear', {});
    assert.equal(state().leaderboard.visible, true);
    // Un messaggio più vecchio non sostituisce quello attuale.
    env.post('leaderboard', { ...payload('board'), rev: 5 });
    assert.equal(state().leaderboard.screen, 'winner');
    env.post('leaderboard', { visible: false, rev: 13 });
    await sleep(450);
    assert.equal(state().leaderboard.visible, false);
    assert.equal(env.doc.querySelectorAll('.lb-panel').length, 0);
    // Sessione manuale: etichetta MANUALE.
    env.post('leaderboard', { ...payload('board'), session: { ...payload('board').session, kind: 'manual' }, rev: 14 });
    assert.ok(env.doc.querySelector('.kind-manual'));
    env.post('reset');
    } finally {
      for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    }
  });

  test('24. classifica finale persistente: resta visibile dopo la fine della diretta finché non si nasconde', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const sid = app.engine.session.id;
    await client.req('POST', '/api/admin/leaderboard/show', { sessionId: sid, screen: 'board' });
    await goOffline();
    await sleep(400); // nessuna chiusura automatica
    const p = app.leaderboard.overlayPayload();
    assert.equal(p.visible, true);
    assert.equal(p.session.status, 'final');
    assert.equal(p.session.id, sid);
    // Una nuova diretta non sostituisce di nascosto la classifica mostrata.
    await goLive('b-due');
    assert.equal(app.leaderboard.overlayPayload().session.id, sid);
    assert.notEqual(app.engine.session.id, sid);
    // "Sessione corrente" senza sessione in corso: rifiutato, mai una sessione precedente.
    await goOffline();
    assert.equal((await client.req('POST', '/api/admin/leaderboard/show', { sessionId: 'current' })).status, 409);
    await client.req('POST', '/api/admin/leaderboard/hide', {});
    assert.equal(app.leaderboard.overlayPayload().visible, false);
  });

  test('25. Hall of Fame: totali permanenti, filtri Twitch/Manuale/Tutte, separata dalle sessioni', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare, { shiny: true }); // 75
    await twitchCatch(LUIGI, MON.common); // 10
    await goOffline();
    await client.req('POST', '/api/admin/game/manual/start', {});
    await manualCatch({ name: 'Ash' }, MON.legendary); // 60
    await manualCatch({ userId: app.db.get("SELECT id FROM twitch_users WHERE twitch_id = '2002'").id }, MON.uncommon); // Luigi +15
    await client.req('POST', '/api/admin/game/manual/stop', {});
    const all = (await client.req('GET', '/api/admin/leaderboard/halloffame?kind=all')).data;
    assert.deepEqual(all.byPoints.map((r) => [r.name, r.points]), [['Mario', 75], ['Ash', 60], ['Luigi', 25]]);
    assert.deepEqual(all.byCaptures.map((r) => [r.name, r.captures]), [['Luigi', 2], ['Mario', 1], ['Ash', 1]]);
    assert.deepEqual([all.totals.captures, all.totals.shiny, all.totals.players, all.totals.sessions], [4, 1, 3, 2]);
    assert.equal(all.byCaptures[0].sessions, 2, 'Luigi ha partecipato a due sessioni');
    assert.equal(all.rarest[0].rarity, 'legendary');
    const tw2 = (await client.req('GET', '/api/admin/leaderboard/halloffame?kind=twitch')).data;
    assert.deepEqual(tw2.byPoints.map((r) => r.name), ['Mario', 'Luigi']);
    const man = (await client.req('GET', '/api/admin/leaderboard/halloffame?kind=manual')).data;
    assert.deepEqual(man.byPoints.map((r) => [r.name, r.points]), [['Ash', 60], ['Luigi', 15]]);
    assert.equal((await client.req('GET', '/api/admin/leaderboard/halloffame?kind=demo')).status, 400);
  });

  test('26. Stream Recap: salvato alla chiusura (Twitch e MANUAL), consultabile senza Twitch', async () => {
    await goLive();
    const liveId = app.engine.session.id;
    await twitchCatch(MARIO, MON.rare);
    await twitchCatch(MARIO, MON.rare);
    await twitchCatch(LUIGI, MON.legendary, { shiny: true });
    await spawn(MON.common); // un lancio fallito
    rng.push(0.99);
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'miss', rewardId: reward.rewardId, userId: PEACH.id, login: PEACH.login, name: PEACH.name }));
    await waitFor(() => app.db.get("SELECT 1 FROM capture_attempts WHERE redemption_id = 'miss'"));
    await goOffline();
    await client.req('POST', '/api/admin/game/manual/start', {});
    const manualId = app.engine.session.id;
    await manualCatch({ name: 'Ash' }, MON.common);
    await client.req('POST', '/api/admin/game/manual/stop', {});
    tw.helixDown = true; // Twitch non raggiungibile: il riepilogo resta disponibile
    const list = (await client.req('GET', '/api/admin/recaps')).data.recaps;
    assert.deepEqual(list.map((r) => [r.sessionId, r.kind]), [[manualId, 'manual'], [liveId, 'twitch']]);
    const r = (await client.req('GET', `/api/admin/recaps/${liveId}`)).data;
    assert.equal(r.stored, true);
    assert.equal(r.session.kind, 'twitch');
    assert.equal(r.participants, 3);
    assert.equal(r.encounters, 4);
    assert.equal(r.captures, 3);
    assert.equal(r.attempts, 4);
    assert.equal(r.captureRate, 0.75);
    assert.equal(r.shiny, 1);
    assert.equal(r.rarest[0].name, 'Testmon D');
    assert.deepEqual([r.mostCaught.name, r.mostCaught.count], ['Testmon C', 2]);
    assert.equal(r.winners.captures.name, 'Mario');
    assert.equal(r.winners.points.name, 'Luigi');
    assert.ok(r.top10.points.length === 2 && r.durationS >= 0);
    const m = (await client.req('GET', `/api/admin/recaps/${manualId}`)).data;
    assert.equal(m.session.kind, 'manual');
    assert.equal(m.session.kindLabel, 'Sessione manuale');
    assert.equal(m.winners.points.name, 'Ash');
    assert.equal((await client.req('POST', `/api/admin/recaps/${liveId}/regenerate`, {})).status, 200);
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'recap_regenerate'"));
  });

  test('27. backup e ripristino: eventi, istantanee e schermata tornano allo stato del backup', async () => {
    await goLive();
    await twitchCatch(MARIO, MON.rare);
    const sid = app.engine.session.id;
    await client.req('POST', '/api/admin/leaderboard/freeze', { sessionId: sid });
    await client.req('POST', '/api/admin/leaderboard/show', { sessionId: sid, screen: 'board' });
    await goOffline();
    const b = app.backups.create('manual', 'prova classifiche');
    await client.req('POST', '/api/admin/leaderboard/hide', {});
    await client.req('POST', '/api/admin/leaderboard/unfreeze', { sessionId: sid, confirm: true, reason: 'modifica dopo il backup' });
    await client.req('PUT', '/api/admin/leaderboard/rules', { base: 1, shiny: 0, rarity: {} });
    const res = await app.restore(b.filename);
    assert.equal(res.integrity, true);
    assert.equal(app.db.schemaVersion(), LATEST_SCHEMA);
    assert.equal(events(), 1);
    assert.equal(app.leaderboard.activeSnapshot(sid)?.version, 1, 'istantanea congelata ripristinata');
    assert.equal(app.leaderboard.rules().version, 1, 'regole del backup');
    const p = app.leaderboard.overlayPayload();
    assert.equal(p.visible, true);
    assert.equal(p.session.status, 'frozen');
    assert.ok(app.db.get('SELECT 1 FROM stream_recaps WHERE session_id = ?', sid));
    // Dopo il ripristino il monitor Twitch si ricollega: si attende prima di chiudere.
    await waitFor(() => app.monitor.status().eventsubConnected, { message: 'monitor ricollegato' });
  });

  test('28. migrazione dallo schema v4: catture esistenti nelle classifiche, DEMO e annullate escluse', async () => {
    const dir = tempDir();
    try {
      const file = legacyDatabase(dir, 4);
      const d = new Database(file);
      d.run("INSERT INTO pokemon (id, dex_number, slug, name, rarity) VALUES (1, 1, 'a', 'A', 'common'), (2, 2, 'b', 'B', 'legendary')");
      d.run("INSERT INTO twitch_users (id, twitch_id, login, display_name) VALUES (1, '2001', 'mario', 'Mario')");
      d.run("INSERT INTO twitch_users (id, twitch_id, login, display_name, is_demo, origin) VALUES (2, 'demo:x', 'x', 'X', 1, 'demo')");
      d.run("INSERT INTO stream_sessions (id, started_at, ended_at, kind) VALUES (1, '2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z', 'twitch')");
      d.run("INSERT INTO stream_sessions (id, started_at, ended_at, kind, is_demo) VALUES (2, '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', 'demo', 1)");
      d.run("INSERT INTO spawn_history (id, session_id, pokemon_id, is_shiny, rarity, started_at, expires_at, status) VALUES (1, 1, 2, 1, 'legendary', 'x', 'x', 'caught'), (2, 1, 1, 0, 'common', 'x', 'x', 'expired'), (3, 2, 1, 0, 'common', 'x', 'x', 'caught')");
      d.run("INSERT INTO capture_attempts (id, user_id, spawn_id, session_id, outcome, redeemed_at) VALUES (1, 1, 1, 1, 'caught', '2026-01-01T10:30:00Z'), (2, 1, 2, 1, 'rejected', 'x'), (3, 2, 3, 2, 'caught', 'x')");
      d.run('UPDATE capture_attempts SET is_demo = 1 WHERE id = 3');
      d.close();
      const { app: old } = await makeApp({ dir, configureTwitch: false });
      try {
        assert.equal(old.db.schemaVersion(), LATEST_SCHEMA);
        assert.ok(old.preUpdate?.file, 'backup di sicurezza prima della migrazione');
        const ev = old.db.all('SELECT * FROM leaderboard_events');
        assert.equal(ev.length, 1, 'solo la cattura reale valida');
        assert.deepEqual([ev[0].source, ev[0].rarity, ev[0].rarity_bonus, ev[0].shiny_bonus, ev[0].points, ev[0].rules_version], ['backfill', 'legendary', 50, 50, 110, 1]);
        assert.equal(old.leaderboard.hallOfFame({ kind: 'all' }).byPoints[0].name, 'Mario');
        assert.ok(old.db.get("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'leaderboard_entries'"));
        assert.equal(old.db.get('SELECT captures FROM leaderboard_entries WHERE session_id = 1').captures, 1);
        assert.ok(old.db.get("SELECT 1 FROM command_settings WHERE command = 'leaderboard'"), 'nuovo comando aggiunto senza toccare gli altri');
        assert.equal(old.db.integrityCheck(), true);
      } finally {
        await old.close();
      }
    } finally {
      cleanup(dir);
    }
  });
});
