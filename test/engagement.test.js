// Overlay rotante, Statistiche Community ed Eventi automatici. Le catture passano dal
// vero motore (sessioni manuali dalla dashboard, dirette con EventSub simulato), gli
// annunci dal ChatSender esistente verso il finto Twitch, l'overlay dal vero hub WebSocket.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID, adminClient,
} from './helpers.js';
import { LATEST_SCHEMA } from '../src/database/migrations.js';
import { withSpawnModifier } from '../src/game_engine/engine.js';
import { RotationService } from '../src/overlay/rotation.js';
import { CHAT_MESSAGE_DEFAULTS } from '../src/configuration/defaults.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(60);
const BOT_ID = '5000';
const POKEMON = [
  { dex: 1, slug: 'mon-common', name: 'Comunmon', rarity: 'common', types: ['grass', 'poison'] },
  { dex: 2, slug: 'mon-uncommon', name: 'Noncomunmon', rarity: 'uncommon', types: ['water'] },
  { dex: 3, slug: 'mon-rare', name: 'Raromon', rarity: 'rare', types: ['grass'] },
  { dex: 4, slug: 'mon-legend', name: 'Leggendamon', rarity: 'legendary', types: ['psychic'] },
];

describe('Statistiche Community, Eventi automatici e Overlay rotante', () => {
  let ctx, app, tw, es, rng, client, reward, seq, sent;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    rng = seqRng();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    app = ctx.app;
    seedPokemon(app.db, POKEMON);
    reward = linkReward(app, 'pokeball');
    app.credentials.setToken('bot', { accessToken: 'botaccess', refreshToken: 'botrefresh', expiresAt: Date.now() + 3600e3, scopes: ['user:write:chat'], userId: BOT_ID, login: 'mio_bot', displayName: 'MioBot' });
    app.chatMessages.captureDelayMs = 0;
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE' && app.monitor.eventsub?.connected, { message: 'EventSub collegato' });
    client = await adminClient(app);
    seq = 0;
    // Spia sui canali WebSocket: cosa va all'overlay e cosa al canale audio.
    sent = [];
    const orig = app.hub.broadcast.bind(app.hub);
    app.hub.broadcast = (channel, type, data) => { sent.push({ channel, type, data }); return orig(channel, type, data); };
  });

  afterEach(async () => {
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const ok = async (method, path, body) => {
    const r = await client.req(method, path, body);
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const manualStart = () => ok('POST', '/api/admin/game/manual/start', {});
  const manualStop = () => ok('POST', '/api/admin/game/manual/stop', {});
  // shiny non indicato: lo decide il motore (con l'eventuale bonus).
  const spawn = (pokemonId, shiny) => ok('POST', '/api/admin/spawn/manual', { pokemonId, ...(shiny === undefined ? {} : { shiny }) });
  // Cattura riuscita in sessione manuale (lancio con esito forzato dal generatore).
  const manualCatch = async (name, pokemonId, { shiny = false } = {}) => {
    await spawn(pokemonId, shiny);
    rng.push(0.0);
    const r = await ok('POST', '/api/admin/game/manual/throw', { ballTypeId: reward.ball.id, name });
    assert.equal(r.caught, true);
    return r;
  };
  const goLive = async (id = 'b-live') => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE' && app.engine.running, { message: 'stato LIVE' });
  };
  const goOffline = async () => {
    tw.live = null;
    es.notify('stream.offline', { broadcaster_user_id: BROADCASTER_ID });
    await waitFor(() => app.sm.state === 'OFFLINE' && !app.engine.sessions.current('twitch'), { message: 'stato OFFLINE' });
  };
  const twitchCatch = async (user, pokemonId) => {
    await spawn(pokemonId);
    rng.push(0.0);
    const before = app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE outcome = 'caught'").n;
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: `red-${++seq}`, rewardId: reward.rewardId, userId: user.id, login: user.login, name: user.name }));
    await waitFor(() => app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE outcome = 'caught'").n > before, { message: 'cattura via Twitch' });
  };
  const eventsOn = (extra = {}) => ok('PUT', '/api/admin/events', { enabled: true, manualMode: true, legendary: { enabled: true, legendaryBoost: 10 }, shiny: { enabled: true, shinyMultiplier: 20 }, ...extra });
  const chatOn = () => app.chatMessages.setSettings({ enabled: true, events: { spawn: { enabled: false }, capture: { enabled: false } } });
  const chat = () => tw.chat.map((c) => c.message);
  const overlayMsgs = (type) => sent.filter((m) => m.channel === 'overlay' && m.type === type);

  // --- Valori predefiniti e compatibilità -------------------------------------------
  test('tutto spento per impostazione predefinita: nessun evento, nessuna rotazione, nessun bonus', async () => {
    assert.equal(app.events.settings().enabled, false);
    assert.equal(app.rotation.settings().enabled, false);
    await manualStart();
    app.events.tick();
    assert.equal(app.events.state().active, null);
    assert.equal(app.events.spawnModifier(), null);
    assert.equal(app.rotation.payload().visible, false);
    assert.equal(overlayMsgs('rotation').filter((m) => m.data.visible).length, 0);
    // Avvio manuale rifiutato finché gli eventi sono spenti.
    const r = await client.req('POST', '/api/admin/events/start', { type: 'legendary' });
    assert.equal(r.status, 409);
  });

  test('nessuna migrazione: schema invariato, impostazioni nelle tabelle esistenti', async () => {
    assert.equal(LATEST_SCHEMA, 5);
    assert.equal(app.db.schemaVersion(), 5);
    await eventsOn();
    await ok('PUT', '/api/admin/rotation', { enabled: true });
    await ok('PUT', '/api/admin/community-stats/settings', { luckMetric: 'shiny' });
    const keys = app.db.all('SELECT key FROM admin_settings').map((r) => r.key);
    for (const k of ['autoEvents', 'communityStats']) assert.ok(keys.includes(k), k);
    assert.ok(app.db.get("SELECT key FROM overlay_settings WHERE key = 'rotation'"));
  });

  // --- Statistiche Community ----------------------------------------------------------
  test('statistiche con dati vuoti: nessun errore in nessun periodo', async () => {
    for (const p of ['session', 'last', 'week', 'month', 'all']) {
      const r = await ok('GET', `/api/admin/community-stats?period=${p}`);
      assert.equal(r.stats.empty, true, p);
      assert.equal(r.stats.mostCaught, null);
      assert.equal(r.stats.luckiest.winner, null);
      assert.equal(r.stats.legendarySession, null);
    }
    assert.equal((await client.req('GET', '/api/admin/community-stats?period=anno')).status, 400);
  });

  test('statistiche: più catturato, fortunato, rarità, tipi, record e parità', async () => {
    await manualStart();
    await manualCatch('Ash', 1);
    await manualCatch('Misty', 1);
    await manualCatch('Misty', 3, { shiny: true });
    await manualCatch('Brock', 4);
    await manualCatch('Brock', 3);
    await manualStop();
    await manualStart();
    await manualCatch('Ash', 4);
    let s = (await ok('GET', '/api/admin/community-stats?period=all')).stats;
    assert.equal(s.totals.captures, 6);
    assert.equal(s.totals.shiny, 1);
    assert.equal(s.totals.legendary, 2);
    // Parità tra Comunmon e Raromon (2 catture ciascuno): vince il primo catturato, la parità è indicata.
    assert.equal(s.mostCaught.name, 'Comunmon');
    assert.equal(s.mostCaught.count, 2);
    assert.equal(s.mostCaught.trainers, 2);
    assert.deepEqual(s.mostCaught.ties, ['Raromon', 'Leggendamon']);
    assert.equal(s.topPokemon.length, 3);
    // Metrica "speciali" (raro o superiore, oppure shiny): Brock 2 (Leggendamon, Raromon), Misty 1, Ash 1.
    assert.equal(s.luckiest.metric, 'special');
    assert.equal(s.luckiest.winner.name, 'Brock');
    assert.equal(s.luckiest.winner.value, 2);
    assert.match(s.luckiest.reason, /Brock: 2 catture/);
    // Più catture: Ash, Misty e Brock a 2. Vince chi ci è arrivato prima, gli altri sono a pari merito.
    assert.equal(s.topTrainer.value, 2);
    assert.equal(s.topTrainer.tie, true);
    assert.equal(s.topTrainer.name, 'Ash');
    assert.deepEqual(s.topShinyTrainer && [s.topShinyTrainer.name, s.topShinyTrainer.value], ['Misty', 1]);
    assert.equal(s.rarest.name, 'Leggendamon');
    assert.equal(s.rarest.player, 'Brock');
    // Tipi: Erba conta Comunmon (erba/veleno) e Raromon → 4.
    assert.deepEqual([s.topType.type, s.topType.count], ['grass', 4]);
    assert.equal(s.recordSession.value, 5);
    // Leggendari: una per sessione → parità segnalata, vale la prima.
    assert.equal(s.legendarySession.value, 1);
    assert.equal(s.legendarySession.tie, true);
    assert.ok(s.legendarySession.participants.includes('Brock'));
    // Metrica configurabile: shiny.
    await ok('PUT', '/api/admin/community-stats/settings', { luckMetric: 'shiny' });
    s = (await ok('GET', '/api/admin/community-stats?period=all')).stats;
    assert.equal(s.luckiest.winner.name, 'Misty');
    // Periodi: sessione corrente (solo la seconda), settimana, mese.
    s = (await ok('GET', '/api/admin/community-stats?period=session')).stats;
    assert.equal(s.totals.captures, 1);
    assert.equal((await ok('GET', '/api/admin/community-stats?period=week')).stats.totals.captures, 6);
    assert.equal((await ok('GET', '/api/admin/community-stats?period=month')).stats.totals.captures, 6);
    // "Ultima diretta": solo dirette Twitch, qui non ce ne sono.
    assert.equal((await ok('GET', '/api/admin/community-stats?period=last')).stats.empty, true);
    // Le statistiche storiche restano dopo la fine della sessione.
    await manualStop();
    assert.equal((await ok('GET', '/api/admin/community-stats?period=all')).stats.totals.captures, 6);
  });

  // --- Eventi: bonus temporanei e probabilità ---------------------------------------
  test('bonus temporanei: solo la scelta del Pokémon, impostazioni salvate e cattura invariate', async () => {
    const savedBefore = JSON.stringify(app.gameSettings.all());
    await eventsOn();
    await manualStart();
    // Senza evento: 0.9 sulla rarità → Raro (pesi 55/25/12/2 sui Pokémon presenti).
    rng.push(0.9, 0.5, 0.99);
    assert.equal((await spawn(null)).rarity, 'rare');
    await ok('POST', '/api/admin/spawn/cancel', {});
    const r0 = await ok('POST', '/api/admin/events/start', { type: 'legendary', durationMin: 5 });
    assert.equal(r0.active.type, 'legendary');
    assert.deepEqual(app.events.spawnModifier().rarityBoost, { legendary: 10, mythical: 10 });
    // Con l'evento (Leggendari ×10) lo stesso numero sceglie il Leggendario.
    rng.push(0.9, 0.5, 0.99);
    assert.equal((await spawn(null)).rarity, 'legendary');
    // La probabilità di cattura non cambia con l'evento.
    rng.push(0.99);
    const during = await ok('POST', '/api/admin/game/manual/throw', { ballTypeId: reward.ball.id, name: 'Ash' });
    await ok('POST', '/api/admin/events/stop', {});
    assert.equal(app.events.spawnModifier(), null);
    if (app.engine.status().activeSpawn) await ok('POST', '/api/admin/spawn/cancel', {});
    await spawn(4);
    rng.push(0.99);
    const after = await ok('POST', '/api/admin/game/manual/throw', { ballTypeId: reward.ball.id, name: 'Ash' });
    assert.equal(during.probability, after.probability);
    await ok('POST', '/api/admin/spawn/cancel', {}).catch(() => {});
    // Fine evento: stesso numero, di nuovo Raro (nessun residuo del bonus).
    rng.push(0.9, 0.5, 0.99);
    assert.equal((await spawn(null)).rarity, 'rare');
    // Le impostazioni salvate del gioco non sono mai state toccate.
    assert.equal(JSON.stringify(app.gameSettings.all()), savedBefore);
    // withSpawnModifier restituisce una copia.
    const cfg = app.engine.cfg();
    const copy = withSpawnModifier(cfg, { rarityBoost: { legendary: 3 } });
    assert.notEqual(copy, cfg);
    assert.equal(cfg.event.enabled, false);
    assert.equal(copy.event.rarityBoost.legendary, 3);
    assert.equal(withSpawnModifier(cfg, null), cfg);
  });

  test('Bonus Shiny: probabilità shiny moltiplicata solo durante l\'evento; eventi incompatibili rifiutati', async () => {
    await eventsOn();
    await manualStart();
    rng.push(0.1, 0.5, 0.1); // 0.1 sullo shiny: no con 1%, sì con 20%
    assert.equal((await spawn(null)).shiny, false);
    await ok('POST', '/api/admin/spawn/cancel', {});
    await ok('POST', '/api/admin/events/start', { type: 'shiny', durationMin: 2 });
    rng.push(0.1, 0.5, 0.1);
    assert.equal((await spawn(null)).shiny, true);
    await ok('POST', '/api/admin/spawn/cancel', {});
    // Un solo evento con bonus alla volta.
    const r = await client.req('POST', '/api/admin/events/start', { type: 'legendary' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /già un evento attivo/);
    // Fine per durata.
    const t0 = Date.now();
    app.events.now = () => t0 + 3 * 60000;
    app.events.tick();
    assert.equal(app.events.state().active, null);
    assert.equal(app.events.state().history[0].reason, 'completed');
    assert.equal(app.events.spawnModifier(), null);
  });

  test('modalità manuale solo se abilitata; DEMO mai', async () => {
    await eventsOn({ manualMode: false });
    await manualStart();
    let r = await client.req('POST', '/api/admin/events/start', { type: 'legendary' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /sessioni manuali/);
    await ok('PUT', '/api/admin/events', { manualMode: true });
    await ok('POST', '/api/admin/events/start', { type: 'legendary' });
    // Fine della sessione manuale (regola "termina"): evento chiuso, nessun bonus.
    await manualStop();
    await settle();
    assert.equal(app.events.state().active, null);
    assert.equal(app.events.state().history[0].reason, 'session_end');
    // DEMO: niente bonus anche con un evento in stato attivo.
    app.engine.startDemo();
    r = await client.req('POST', '/api/admin/events/start', { type: 'legendary' });
    assert.equal(r.status, 409);
    app.engine.stopDemo();
  });

  test('Twitch offline: regola "termina" e regola "sospendi", senza bonus attivi e senza annunci arretrati', async () => {
    chatOn();
    await eventsOn({ offlineRule: 'pause' });
    await goLive();
    await ok('POST', '/api/admin/events/start', { type: 'legendary', durationMin: 10 });
    await waitFor(() => chat().some((m) => /EVENTO LEGGENDARIO/.test(m)), { message: 'annuncio inizio' });
    assert.equal(tw.chat.at(-1).sender_id, BOT_ID, 'annuncio inviato dal bot');
    // EventSub cade: gioco sospeso → evento sospeso, bonus non attivo.
    es.refuse = true;
    es.dropAll();
    await waitFor(() => !app.engine.running, { message: 'motore sospeso' });
    app.events.tick();
    assert.ok(app.events.state().active.pausedAt);
    assert.equal(app.events.spawnModifier(), null);
    const before = tw.chat.length;
    // Ritorno di Twitch: evento ripreso, nessun annuncio arretrato.
    es.refuse = false;
    await waitFor(() => app.engine.running, { message: 'motore ripreso', timeout: 5000 });
    app.events.tick();
    assert.equal(app.events.state().active.pausedAt, null);
    assert.ok(app.events.spawnModifier());
    await settle();
    assert.equal(tw.chat.length, before);
    // Regola "termina": fine diretta → evento chiuso subito.
    await ok('PUT', '/api/admin/events', { offlineRule: 'end' });
    await goOffline();
    await settle();
    assert.equal(app.events.state().active, null);
    assert.equal(app.events.state().history[0].reason, 'twitch_offline');
    assert.equal(app.events.spawnModifier(), null);
    // Il riepilogo della diretta registra l'evento e il risultato.
    const sid = app.events.state().history[0].sessionId;
    const recap = app.leaderboard.recap(sid);
    assert.equal(recap.events.length, 1);
    assert.equal(recap.events[0].type, 'legendary');
    assert.ok(recap.events[0].result);
  });

  test('avvio automatico: intervallo di tempo, fascia oraria e numero di catture', async () => {
    await eventsOn({ legendary: { enabled: true, trigger: 'time', everyMinutes: 5, durationMin: 2 } });
    await manualStart();
    const t0 = Date.now();
    app.events.now = () => t0 + 60000;
    app.events.tick();
    assert.equal(app.events.state().active, null, 'troppo presto');
    // Fascia oraria che esclude oggi: non parte.
    const today = new Date(t0 + 6 * 60000).getDay();
    await ok('PUT', '/api/admin/events', { legendary: { schedule: { days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today), from: '00:00', to: '23:59' } } });
    app.events.now = () => t0 + 6 * 60000;
    app.events.tick();
    assert.equal(app.events.state().active, null, 'fuori fascia');
    await ok('PUT', '/api/admin/events', { legendary: { schedule: { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' } } });
    app.events.tick();
    const a = app.events.state().active;
    assert.equal(a?.type, 'legendary');
    assert.equal(a.by, 'auto');
    // Dopo la fine non riparte subito (intervallo dalla fine dell'evento precedente).
    app.events.now = () => t0 + 9 * 60000;
    app.events.tick();
    assert.equal(app.events.state().active, null);
    app.events.tick();
    assert.equal(app.events.state().active, null);
    // Per numero di catture (orologio reale: si riparte da zero, come a inizio sessione).
    app.events.now = () => Date.now();
    const st = app.events.state(); st.last = {}; app.events.save(st);
    await ok('PUT', '/api/admin/events', { legendary: { trigger: 'captures', everyCaptures: 3 } });
    await manualCatch('Ash', 1);
    await manualCatch('Ash', 2);
    app.events.tick();
    assert.equal(app.events.state().active, null);
    await manualCatch('Ash', 3);
    app.events.tick();
    assert.equal(app.events.state().active?.type, 'legendary');
  });

  test('Evento Community: avanzamento, completamento, annuncio, premio e nuovo obiettivo', async () => {
    chatOn();
    await manualStart();
    await manualCatch('Ash', 1); // prima dell'attivazione: non conta
    await eventsOn({ community: { enabled: true, goal: 2, reward: 'Leggendari sbloccati!', unlock: 'legendary' } });
    let v = (await ok('GET', '/api/admin/events')).community;
    assert.equal(v.progress, 0);
    await manualCatch('Misty', 2);
    v = (await ok('GET', '/api/admin/events')).community;
    assert.deepEqual([v.progress, v.pct], [1, 50]);
    await manualCatch('Brock', 3);
    v = (await ok('GET', '/api/admin/events')).community;
    assert.ok(v.completedAt);
    assert.equal(v.pct, 100);
    await waitFor(() => chat().some((m) => /Obiettivo raggiunto/.test(m)), { message: 'annuncio obiettivo' });
    assert.equal(overlayMsgs('celebration').length, 1);
    // Premio: parte un Evento Leggendario.
    assert.equal(app.events.state().active?.type, 'legendary');
    assert.equal(app.events.state().active.by, 'community');
    assert.ok(app.events.state().history.some((e) => e.type === 'community' && e.goal === 2));
    // Nuovo obiettivo: il conteggio riparte.
    const n = await ok('POST', '/api/admin/events/community/new', { goal: 5 });
    assert.deepEqual([n.community.goal, n.community.progress, n.community.completedAt], [5, 0, null]);
  });

  test('Pokémon del giorno: scelta ripetibile, annuncio una volta, cattura annunciata', async () => {
    chatOn();
    await eventsOn({ pokemonOfDay: { enabled: true, mode: 'fixed', pokemonId: 3 } });
    await manualStart();
    app.events.tick();
    const p = app.events.pokemonOfDay();
    assert.equal(p.pokemonId, 3);
    await waitFor(() => chat().some((m) => /Pokémon del giorno è Raromon/.test(m)), { message: 'annuncio Pokémon del giorno' });
    app.events.tick();
    await settle();
    assert.equal(chat().filter((m) => /Pokémon del giorno è/.test(m)).length, 1, 'una sola volta al giorno');
    await manualCatch('Ash', 3);
    await waitFor(() => chat().some((m) => /Ash ha catturato il Pokémon del giorno, Raromon/.test(m)), { message: 'annuncio cattura' });
    assert.deepEqual(app.events.pokemonOfDay().catchers, ['Ash']);
    // Scelta automatica: stessa data → stesso Pokémon.
    await ok('PUT', '/api/admin/events', { pokemonOfDay: { mode: 'auto' } });
    const st = app.events.state(); st.potd = null; app.events.save(st);
    const a = app.events.pokemonOfDay().pokemonId;
    const st2 = app.events.state(); st2.potd = null; app.events.save(st2);
    assert.equal(app.events.pokemonOfDay().pokemonId, a);
  });

  test('annunci: antispam dei Messaggi Twitch (intervallo minimo) e messaggi spenti = nessun invio', async () => {
    await eventsOn();
    await manualStart();
    // Messaggi Twitch spenti: nessun annuncio.
    await ok('POST', '/api/admin/events/start', { type: 'legendary', durationMin: 1 });
    await ok('POST', '/api/admin/events/stop', {});
    await settle();
    assert.deepEqual(tw.chat, []);
    chatOn();
    await ok('POST', '/api/admin/events/start', { type: 'shiny', durationMin: 1 });
    await ok('POST', '/api/admin/events/stop', {});
    await ok('POST', '/api/admin/events/start', { type: 'shiny', durationMin: 1 });
    await settle();
    // Il secondo "inizio Bonus Shiny" cade nell'intervallo minimo (30 s): non inviato, non accodato.
    assert.equal(chat().filter((m) => /BONUS SHINY/.test(m)).length, 1);
    assert.ok(app.chatMessages.recent.some((r) => r.event === 'event_shiny_start' && /intervallo minimo/.test(r.reason || '')));
    assert.ok(tw.chat.every((c) => c.sender_id === BOT_ID), 'sempre con l\'account del bot');
  });

  // --- Overlay rotante ---------------------------------------------------------------
  test('rotazione: ordine, schermate senza dati saltate, blocco, priorità agli eventi, solo canale overlay', async () => {
    await ok('PUT', '/api/admin/rotation', { enabled: true });
    assert.equal(app.rotation.payload().visible, false, 'nessun dato: pannello nascosto');
    await manualStart();
    await manualCatch('Ash', 1);
    await settle();
    let p = app.rotation.payload();
    assert.equal(p.visible, true);
    assert.equal(p.screen, 'leaderboard');
    assert.equal(p.data.rows[0].name, 'Ash');
    // Giro: classifica → catture → (shiny saltata: nessuno shiny) → (obiettivi: eventi spenti) → statistiche → (evento: nessuno) → classifica.
    const order = [];
    for (let i = 0; i < 4; i++) order.push(app.rotation.advance().screen);
    assert.deepEqual(order, ['captures', 'stats', 'leaderboard', 'captures']);
    // Ordine personalizzato e schermate disattivate.
    await ok('PUT', '/api/admin/rotation', { screens: [{ key: 'stats', enabled: true, durationS: 10 }, { key: 'captures', enabled: true, durationS: 10 }, { key: 'leaderboard', enabled: false, durationS: 10 }] });
    const order2 = [app.rotation.payload().screen, app.rotation.advance().screen, app.rotation.advance().screen];
    assert.deepEqual(order2, ['stats', 'captures', 'stats']);
    // Durata limitata a [min, max].
    await ok('PUT', '/api/admin/rotation', { minS: 20, maxS: 30 });
    assert.equal(app.rotation.payload().durationS, 20);
    // Blocco manuale.
    await ok('POST', '/api/admin/rotation/lock', { screen: 'captures' });
    assert.equal(app.rotation.advance().screen, 'captures');
    assert.equal(app.rotation.advance().screen, 'captures');
    await ok('POST', '/api/admin/rotation/lock', { screen: null });
    // Evento appena iniziato: schermata dell'evento subito.
    await eventsOn();
    await ok('PUT', '/api/admin/rotation', { screens: [{ key: 'stats', enabled: true, durationS: 10 }, { key: 'event', enabled: true, durationS: 10 }] });
    await ok('POST', '/api/admin/events/start', { type: 'legendary' });
    p = app.rotation.payload();
    assert.equal(p.screen, 'event');
    assert.equal(p.data.active.type, 'legendary');
    // Nessun messaggio di rotazione o eventi sul canale audio.
    assert.equal(sent.filter((m) => m.channel === 'audio').length, 0);
    assert.ok(overlayMsgs('rotation').length > 5);
    assert.ok(overlayMsgs('events').length > 0);
  });

  test('aggiornamento in tempo reale: una cattura ridisegna la schermata senza cambiarla', async () => {
    await ok('PUT', '/api/admin/rotation', { enabled: true });
    await manualStart();
    await manualCatch('Ash', 1);
    await settle();
    assert.equal(app.rotation.payload().screen, 'leaderboard');
    const n = overlayMsgs('rotation').length;
    await manualCatch('Misty', 3, { shiny: true });
    await settle();
    const last = overlayMsgs('rotation').at(-1).data;
    assert.ok(overlayMsgs('rotation').length > n);
    assert.equal(last.screen, 'leaderboard');
    assert.equal(last.enter, false, 'aggiornamento, non cambio schermata');
    assert.equal(last.data.rows.length, 2);
  });

  test('un solo timer di rotazione, anche con molti cambi', async () => {
    const created = new Set();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms) => { const t = realSet(fn, ms); created.add(t); return t; };
    globalThis.clearTimeout = (t) => { created.delete(t); return realClear(t); };
    try {
      const svc = new RotationService({ db: app.db, settings: app.overlaySettings, hub: { overlay() {}, admin() {} }, leaderboard: app.leaderboard, stats: app.communityStats, events: app.events, timers: true });
      app.overlaySettings.set('rotation', { ...app.rotation.settings(), enabled: true });
      for (let i = 0; i < 20; i++) svc.advance();
      svc.restart();
      assert.equal(created.size, 1);
      svc.stop();
      assert.equal(created.size, 0);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test('WebSocket: lo snapshot contiene rotazione ed eventi; dopo una riconnessione lo stato è lo stesso', async () => {
    await ok('PUT', '/api/admin/rotation', { enabled: true });
    await eventsOn();
    await manualStart();
    await manualCatch('Ash', 1);
    await ok('POST', '/api/admin/events/start', { type: 'shiny' });
    const port = new URL(client.base).port;
    const snapshot = () => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`);
      ws.on('message', (m) => { const x = JSON.parse(m); if (x.type === 'snapshot') { ws.close(); resolve(x.data); } });
      ws.on('error', reject);
    });
    const a = await snapshot();
    assert.equal(a.rotation.visible, true);
    assert.equal(a.rotation.screen, 'event');
    assert.equal(a.events.active.type, 'shiny');
    const b = await snapshot();
    assert.equal(b.rotation.screen, a.rotation.screen);
    assert.equal(b.rotation.rev, a.rotation.rev);
    assert.equal(b.rotation.enter, false, 'nessuna animazione d\'ingresso alla riconnessione');
    // Lo stesso stato è nella risposta pubblica usata al primo caricamento dell'overlay.
    const pub = await (await fetch(`${client.base}/api/public/overlay`)).json();
    assert.equal(pub.rotation.screen, 'event');
  });

  // --- Persistenza, riavvio, backup ----------------------------------------------------
  test('riavvio: impostazioni, blocco, obiettivo e storico conservati; evento ripreso o chiuso secondo la regola', async () => {
    await eventsOn({ offlineRule: 'pause', community: { enabled: true, goal: 9 } });
    await ok('PUT', '/api/admin/rotation', { enabled: true, transition: 'slide', lock: 'stats' });
    await ok('PUT', '/api/admin/community-stats/settings', { luckMetric: 'legendary' });
    await manualStart();
    await ok('POST', '/api/admin/events/start', { type: 'legendary', durationMin: 10 });
    await app.close();
    const again = await makeApp({ dir: ctx.dir, configureTwitch: false });
    try {
      const a2 = again.app;
      assert.equal(a2.events.settings().enabled, true);
      assert.equal(a2.events.settings().offlineRule, 'pause');
      assert.equal(a2.rotation.settings().transition, 'slide');
      assert.equal(a2.rotation.settings().lock, 'stats');
      assert.equal(a2.communityStats.settings().luckMetric, 'legendary');
      assert.equal(a2.events.state().community.goal, 9);
      // Dopo il riavvio il gioco è fermo: l'evento è sospeso, nessun bonus.
      a2.events.tick();
      assert.ok(a2.events.state().active.pausedAt);
      assert.equal(a2.events.spawnModifier(), null);
    } finally {
      await again.app.close();
      app = await (async () => { const x = await makeApp({ dir: ctx.dir, configureTwitch: false }); return x.app; })();
    }
  });

  test('backup e ripristino: configurazioni di eventi e overlay incluse', async () => {
    await eventsOn({ community: { enabled: true, goal: 7 } });
    await ok('PUT', '/api/admin/rotation', { enabled: true, position: 'right' });
    const b = app.backups.create('manual', 'test');
    await ok('PUT', '/api/admin/events', { enabled: false, community: { goal: 99 } });
    await ok('PUT', '/api/admin/rotation', { position: 'bottom' });
    await app.restore(b.filename);
    await waitFor(() => app.monitor.eventsub?.connected, { message: 'Twitch ricollegato dopo il ripristino', timeout: 5000 });
    assert.equal(app.events.settings().enabled, true);
    assert.equal(app.events.settings().community.goal, 7);
    assert.equal(app.rotation.settings().position, 'right');
  });

  test('Messaggi Twitch salvati nella 1.0.1: i nuovi annunci compaiono, quelli eliminati non tornano', async () => {
    // Impostazioni come le salvava la 1.0.1 (senza elenco degli eventi conosciuti).
    const old = { enabled: true, allowChannelAccount: false, maxPerMinute: 6, events: {}, messages: CHAT_MESSAGE_DEFAULTS.messages.filter((m) => ['spawn', 'capture'].includes(m.event)) };
    app.adminSettings.set('chatMessages', old);
    const s = app.chatMessages.settings();
    assert.ok(s.messages.some((m) => m.event === 'event_legendary_start'));
    assert.ok(!s.messages.some((m) => m.event === 'session_start'), 'messaggio eliminato dall\'utente nella 1.0.1: non torna');
    // Dopo un salvataggio l'elenco è aggiornato: eliminare un annuncio è definitivo.
    app.chatMessages.setSettings({ messages: s.messages.filter((m) => m.event !== 'event_end') });
    assert.ok(!app.chatMessages.settings().messages.some((m) => m.event === 'event_end'));
  });

  test('dashboard: pagine e API solo per l\'amministratore', async () => {
    for (const path of ['/api/admin/events', '/api/admin/rotation', '/api/admin/community-stats']) {
      const r = await client.req('GET', path, undefined, { auth: false });
      assert.equal(r.status, 401, path);
    }
    const r = await client.req('POST', '/api/admin/events/start', { type: 'legendary' }, { csrfToken: 'sbagliato' });
    assert.equal(r.status, 403);
    // Validazione.
    assert.equal((await client.req('PUT', '/api/admin/events', { legendary: { legendaryBoost: 50 } })).status, 400);
    assert.equal((await client.req('PUT', '/api/admin/rotation', { minS: 30, maxS: 10 })).status, 400);
    assert.equal((await client.req('PUT', '/api/admin/rotation', { screens: [{ key: 'xyz', durationS: 5 }] })).status, 400);
    for (const page of ['community.js', 'events.js', 'rotation.js']) {
      const res = await fetch(`${client.base}/assets/js/admin/pages/${page}`);
      assert.equal(res.status, 200, page);
    }
    assert.equal((await fetch(`${client.base}/assets/js/overlay/rotation-view.js`)).status, 200);
  });
});
