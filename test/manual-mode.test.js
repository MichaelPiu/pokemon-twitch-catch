// Modalità MANUALE: il vero motore di gioco senza Twitch, con dati reali,
// separata dalle dirette (eventi MANUAL/TWITCH distinti) e con priorità alla diretta.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID, adminClient,
} from './helpers.js';
import { overlaySocket } from './overlay-helpers.js';

describe('Modalità manuale', () => {
  let ctx, app, tw, es, rng, client;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    rng = seqRng();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    app = ctx.app;
    seedPokemon(app.db);
    linkReward(app, 'pokeball');
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE', { message: 'stato OFFLINE' });
    client = await adminClient(app);
  });

  afterEach(async () => {
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const ball = () => app.db.get("SELECT id FROM ball_types WHERE code = 'pokeball'").id;
  const start = () => client.req('POST', '/api/admin/game/manual/start', {});
  const spawnNow = () => client.req('POST', '/api/admin/spawn/manual', {});
  const goLive = async (id = 'b-live') => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE', { message: 'stato LIVE' });
  };

  test('1. avvio con Twitch OFFLINE: vero motore, sessione MANUAL, stato Twitch invariato, nessuna sottoscrizione in più', async () => {
    const subsBefore = tw.subscriptions.length;
    const callsBefore = tw.calls.length;
    const r = await start();
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.control, 'MANUAL');
    assert.equal(app.engine.mode, 'manual');
    assert.equal(app.engine.running, true);
    const s = app.engine.sessions.current('manual');
    assert.equal(s.kind, 'manual');
    assert.equal(s.is_demo, 0);
    assert.equal(s.broadcast_id, null);
    assert.equal(app.engine.sessions.current('twitch'), null, 'nessuna diretta aperta');
    assert.equal(app.sm.state, 'OFFLINE', 'lo stato Twitch non viene falsificato');
    assert.ok(app.engine.nextSpawnAt, 'timer di spawn programmato');
    assert.equal(tw.subscriptions.length, subsBefore, 'nessuna nuova sottoscrizione EventSub');
    assert.ok(!tw.calls.slice(callsBefore).some((c) => /eventsub|oauth/.test(c)), 'nessuna chiamata a OAuth/EventSub');
    const st = await client.req('GET', '/api/admin/game');
    assert.equal(st.data.engine.manual.sessionId, s.id);
    assert.ok(st.data.twitchOnly.length >= 3, 'funzioni Twitch indicate come non disponibili');
  });

  test('2. arresto manuale: sessione chiusa, dati conservati', async () => {
    await start();
    await spawnNow();
    rng.push(0.0);
    const t = await client.req('POST', '/api/admin/game/manual/throw', { name: 'Ash', ballTypeId: ball() });
    assert.equal(t.data.caught, true);
    const r = await client.req('POST', '/api/admin/game/manual/stop', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.closed.end_reason, 'manual_stopped');
    assert.equal(r.data.closed.captures, 1);
    assert.equal(app.engine.mode, null);
    assert.equal(app.engine.running, false);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM user_pokemon WHERE origin = 'manual'").n, 1, 'catture conservate');
    assert.equal((await client.req('POST', '/api/admin/game/manual/stop', {})).status, 409);
  });

  test('3. avvii duplicati e conflitti con la DEMO rifiutati', async () => {
    assert.equal((await start()).status, 200);
    const again = await start();
    assert.equal(again.status, 409);
    assert.match(again.data.error, /già attiva/);
    assert.equal((await client.req('POST', '/api/admin/demo/start', {})).status, 409, 'DEMO durante la sessione manuale');
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM stream_sessions WHERE ended_at IS NULL").n, 1);
    await client.req('POST', '/api/admin/game/manual/stop', {});
    assert.equal((await client.req('POST', '/api/admin/demo/start', {})).status, 200);
    assert.equal((await start()).status, 409, 'sessione manuale durante la DEMO');
  });

  test('4. API amministrative protette (login e CSRF)', async () => {
    assert.equal((await client.req('GET', '/api/admin/game', undefined, { auth: false })).status, 401);
    assert.equal((await client.req('POST', '/api/admin/game/manual/start', {}, { auth: false })).status, 401);
    assert.equal((await client.req('POST', '/api/admin/game/manual/start', {}, { csrfToken: 'sbagliato' })).status, 403);
    assert.equal(app.engine.mode, null);
    await start();
    assert.equal((await client.req('POST', '/api/admin/game/manual/throw', { name: 'x', ballTypeId: ball() }, { csrfToken: 'sbagliato' })).status, 403);
    assert.equal((await client.req('POST', '/api/admin/game/manual/stop', {}, { auth: false })).status, 401);
    assert.equal(app.engine.mode, 'manual');
  });

  test('5. incontri e catture reali nel motore: probabilità, vincitore singolo, Pokédex e contatori', async () => {
    await start();
    rng.push(0.0, 0.0); // spawnChance, scelta del Pokémon
    const sp = app.engine.tick();
    assert.ok(sp, 'spawn generato dal timer');
    assert.equal(app.db.get('SELECT source, is_demo, session_id FROM spawn_history WHERE id = ?', sp.id).is_demo, 0);
    rng.push(0.99); // tiro fallito
    const miss = await client.req('POST', '/api/admin/game/manual/throw', { name: 'Misty', ballTypeId: ball() });
    assert.equal(miss.data.caught, false);
    rng.push(0.0);
    const hit = await client.req('POST', '/api/admin/game/manual/throw', { name: 'Misty', ballTypeId: ball() });
    assert.equal(hit.data.caught, true);
    assert.equal(hit.data.user.origin, 'local');
    const late = await client.req('POST', '/api/admin/game/manual/throw', { name: 'Brock', ballTypeId: ball() });
    assert.equal(late.data.rejected, true, 'spawn già catturato');
    const up = app.db.get('SELECT * FROM user_pokemon');
    assert.equal(up.origin, 'manual');
    assert.equal(up.is_demo, 0);
    const att = app.db.all("SELECT source, outcome FROM capture_attempts WHERE outcome != 'rejected' ORDER BY id");
    assert.deepEqual(att.map((a) => a.source), ['manual', 'manual']);
    const s = app.engine.sessions.byId(app.engine.session.id);
    assert.equal(s.spawns, 1);
    assert.equal(s.attempts, 2);
    assert.equal(s.captures, 1);
    const u = app.db.get("SELECT * FROM twitch_users WHERE login = 'misty'");
    assert.equal(u.origin, 'local');
    assert.match(u.twitch_id, /^local:/);
    // Uno spettatore Twitch già noto può giocare nella sessione manuale: la cattura resta MANUAL.
    app.db.run("INSERT INTO twitch_users (twitch_id, login, display_name) VALUES ('2001', 'mario', 'Mario')");
    const mario = app.db.get("SELECT id FROM twitch_users WHERE login = 'mario'").id;
    await spawnNow();
    rng.push(0.0);
    const m = await client.req('POST', '/api/admin/game/manual/throw', { userId: mario, ballTypeId: ball() });
    assert.equal(m.data.caught, true);
    assert.equal(app.db.get('SELECT origin FROM user_pokemon WHERE user_id = ?', mario).origin, 'manual');
    assert.equal(app.db.get('SELECT origin FROM twitch_users WHERE id = ?', mario).origin, 'twitch', 'origine dello spettatore invariata');
  });

  test('6. la dashboard riceve gli aggiornamenti in tempo reale (WebSocket admin)', async () => {
    const events = [];
    const orig = app.hub.admin.bind(app.hub);
    app.hub.admin = (type, data) => { events.push(type); return orig(type, data); };
    await start();
    await spawnNow();
    rng.push(0.0);
    await client.req('POST', '/api/admin/game/manual/throw', { name: 'Ash', ballTypeId: ball() });
    assert.ok(events.includes('status'));
    assert.ok(events.includes('spawn'));
    assert.ok(events.includes('attempt'));
    assert.ok(events.includes('despawn'));
    const st = app.liveStatus();
    assert.equal(st.engine.mode, 'manual');
    assert.equal(st.engine.manual.captures, 1);
  });

  test('7. l\'overlay OBS riceve stato, spawn, lancio e cattura', async () => {
    const port = Number(new URL(client.base).port);
    const o = overlaySocket(port);
    await o.open;
    await start();
    await spawnNow();
    rng.push(0.0);
    await client.req('POST', '/api/admin/game/manual/throw', { name: 'Ash', ballTypeId: ball() });
    await waitFor(() => o.msgs.some((m) => m.type === 'despawn'), { message: 'despawn sull\'overlay' });
    const types = o.msgs.map((m) => m.type);
    for (const t of ['state', 'spawn', 'throw', 'despawn']) assert.ok(types.includes(t), `evento ${t}`);
    const state = o.msgs.find((m) => m.type === 'state' && m.data?.active);
    assert.equal(state.data.manual, true);
    assert.equal(state.data.demo, false);
    const snap = await fetch(`${client.base}/api/public/overlay`).then((r) => r.json());
    assert.equal(snap.active, true);
    assert.equal(snap.manual, true);
    o.ws.close();
  });

  test('8–11. statistiche persistenti e sessione interrotta dal riavvio del container', async () => {
    await start();
    await spawnNow();
    rng.push(0.0);
    await client.req('POST', '/api/admin/game/manual/throw', { name: 'Ash', ballTypeId: ball() });
    await spawnNow().catch(() => {});
    const sid = app.engine.session.id;
    // Riavvio senza arresto pulito della sessione (es. aggiornamento del container).
    await app.close();
    await es.stop();
    es = await new FakeEventSub().start();
    ({ app } = await makeApp({ dir: ctx.dir, twitch: tw, eventsub: es }));
    const s = app.engine.sessions.byId(sid);
    assert.equal(s.end_reason, 'restart', 'sessione manuale chiusa come interrotta');
    assert.equal(s.captures, 1);
    assert.equal(app.engine.mode, null, 'il gioco non riparte da solo');
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM spawn_history WHERE status = 'active'").n, 0);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM user_pokemon WHERE origin = 'manual'").n, 1, 'catture conservate');
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'manual_session_interrupted'"));
    // Dopo il riavvio si può aprire una nuova sessione manuale.
    app.engine.startManual();
    assert.equal(app.engine.mode, 'manual');
    assert.notEqual(app.engine.session.id, sid);
  });

  test('9. separazione MANUAL/TWITCH: un riscatto reale non viene elaborato nella sessione manuale', async () => {
    await start();
    await spawnNow();
    const res = app.monitor.onRedemption(redemption({ id: 'r-1', rewardId: '11111111-1111-1111-1111-111111111111' }));
    assert.match(res.detail, /rifiutato: manual_mode/);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 0);
    assert.equal(app.db.get("SELECT outcome, reject_reason, source FROM capture_attempts WHERE redemption_id = 'r-1'").reject_reason, 'manual_mode');
    const sessions = await client.req('GET', '/api/admin/sessions?kind=manual');
    assert.equal(sessions.data.items.length, 1);
    assert.equal((await client.req('GET', '/api/admin/sessions?kind=twitch')).data.items.length, 0);
  });

  test('10. la diretta Twitch ha la priorità: transizione sicura, registrata e senza perdita di dati', async () => {
    await start();
    await spawnNow();
    rng.push(0.0);
    await client.req('POST', '/api/admin/game/manual/throw', { name: 'Ash', ballTypeId: ball() });
    await spawnNow(); // Pokémon ancora in campo al momento della diretta
    const manualId = app.engine.session.id;
    await goLive('b-77');
    await waitFor(() => app.engine.mode === 'live', { message: 'motore in modalità live' });
    const manual = app.engine.sessions.byId(manualId);
    assert.equal(manual.end_reason, 'twitch_live');
    assert.equal(manual.captures, 1, 'catture della sessione manuale conservate');
    const live = app.engine.sessions.current('twitch');
    assert.equal(live.broadcast_id, 'b-77');
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM stream_sessions WHERE ended_at IS NULL').n, 1, 'mai due sessioni aperte');
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM spawn_history WHERE status = 'active'").n, 0, 'spawn manuale chiuso');
    assert.equal(app.engine.status().notice.code, 'manual_stopped_by_live');
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'manual_session_stopped_by_live'"));
    // Durante la diretta la sessione manuale non può ripartire e i lanci manuali sono rifiutati.
    assert.equal((await start()).status, 409);
    assert.equal((await client.req('POST', '/api/admin/game/manual/throw', { name: 'Ash', ballTypeId: ball() })).status, 409);
    const att = app.engine.attempt({ redemptionId: 'm-x', ballTypeId: ball(), user: { twitchId: 'local:x', login: 'x', displayName: 'x' }, isDemo: false, source: 'manual' });
    assert.equal(att.reason, 'live_mode');
  });

  test('nessun Pokémon disponibile: errore registrato sulla sessione, il gioco non si interrompe', async () => {
    app.db.run('UPDATE pokemon SET enabled = 0');
    await start();
    assert.equal((await spawnNow()).status, 409);
    const s = app.engine.sessions.byId(app.engine.session.id);
    assert.equal(s.errors, 1);
    assert.match(s.last_error, /Nessun Pokémon/);
    assert.equal(app.engine.mode, 'manual');
  });
});
