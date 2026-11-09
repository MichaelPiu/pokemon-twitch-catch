import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID } from './helpers.js';

describe('Ciclo di vita LIVE/OFFLINE con EventSub', () => {
  let ctx, app, tw, es, rng, reward;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    rng = seqRng();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    app = ctx.app;
    seedPokemon(app.db);
    reward = linkReward(app, 'pokeball');
  });

  afterEach(async () => {
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const startOffline = async () => {
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE', { message: 'stato OFFLINE' });
  };

  const goLive = async (id = 'broadcast-1') => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE', { message: 'stato LIVE' });
  };

  test('all\'avvio si connette, sottoscrive gli eventi e resta OFFLINE se il canale non è in diretta', async () => {
    await startOffline();
    const types = tw.subscriptions.map((s) => s.type).sort();
    assert.deepEqual(types, [
      'channel.channel_points_custom_reward_redemption.add',
      'channel.channel_points_custom_reward_redemption.update',
      'channel.chat.message', 'stream.offline', 'stream.online',
    ]);
    assert.ok(tw.subscriptions.every((s) => s.transport.method === 'websocket' && s.transport.session_id === 'session-1'));
    assert.equal(app.engine.running, false);
    assert.equal(app.engine.sessions.current(false), null);
    // Offline: il timer di spawn non genera nulla.
    assert.equal(app.engine.tick(), null);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM spawn_history').n, 0);
  });

  test('stream.online avvia il motore, crea la sessione; stream.offline arresta tutto', async () => {
    await startOffline();
    await goLive('b-100');
    const session = app.engine.sessions.current(false);
    assert.ok(session);
    assert.equal(session.broadcast_id, 'b-100');
    assert.equal(app.engine.running, true);
    assert.ok(app.engine.nextSpawnAt, 'timer di spawn programmato');

    const sp = app.engine.tick();
    assert.ok(sp, 'spawn generato in LIVE');
    rng.push(0.0);
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'red-1', rewardId: reward.rewardId }));
    await waitFor(() => app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n === 1, { message: 'cattura registrata' });
    await waitFor(() => tw.redemptionUpdates.length === 1);
    assert.deepEqual(tw.redemptionUpdates[0], { id: 'red-1', status: 'FULFILLED' });

    // Un secondo spawn è in campo quando la diretta termina.
    app.engine.tick();
    assert.ok(app.engine.status().activeSpawn);
    tw.live = null;
    es.notify('stream.offline', { broadcaster_user_id: BROADCASTER_ID });
    await waitFor(() => app.sm.state === 'OFFLINE');
    assert.equal(app.engine.running, false);
    assert.equal(app.engine.nextSpawnAt, null, 'timer azzerati');
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM spawn_history WHERE status = 'active'").n, 0);
    assert.equal(app.db.get("SELECT status FROM spawn_history ORDER BY id DESC LIMIT 1").status, 'stream_ended');
    const closed = app.engine.sessions.byId(session.id);
    assert.ok(closed.ended_at, 'sessione chiusa');
    assert.equal(closed.captures, 1);
    assert.equal(closed.spawns, 2);
    assert.ok(closed.duration_s >= 0);

    // Offline: nessuno spawn, nessuna cattura, comandi ignorati.
    assert.equal(app.engine.tick(), null);
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'red-off', rewardId: reward.rewardId }));
    await waitFor(() => app.db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', 'red-off'));
    assert.equal(app.db.get('SELECT reject_reason FROM capture_attempts WHERE redemption_id = ?', 'red-off').reject_reason, 'offline');
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'red-off'));
    assert.equal(tw.redemptionUpdates.find((u) => u.id === 'red-off').status, 'CANCELED', 'punti rimborsati');
    const chatBefore = tw.chat.length;
    es.notify('channel.chat.message', { chatter_user_id: '2001', chatter_user_login: 'mario', chatter_user_name: 'Mario', message_id: 'c1', message: { text: '!pokedex' } });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(tw.chat.length, chatBefore, 'nessuna risposta in chat da offline');
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM spawn_history WHERE session_id IS NOT ? AND started_at > ?", session.id, closed.ended_at).n, 0);
  });

  test('eventi duplicati (stesso message_id) vengono ignorati', async () => {
    await startOffline();
    await goLive();
    app.engine.tick();
    rng.push(0.99, 0.99);
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-dup', rewardId: reward.rewardId }), { messageId: 'same-msg' });
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-dup', rewardId: reward.rewardId }), { messageId: 'same-msg' });
    await waitFor(() => app.db.get('SELECT COUNT(*) AS n FROM twitch_events WHERE message_id = ?', 'same-msg').n === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM capture_attempts').n, 1);
    // Stessa riscossione con message_id diverso (retry di Twitch): idempotenza sul redemption id.
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-dup', rewardId: reward.rewardId }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM capture_attempts').n, 1);
    // Eventi troppo vecchi (replay) scartati.
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-old', rewardId: reward.rewardId }), { timestamp: new Date(Date.now() - 3600e3).toISOString() });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM capture_attempts WHERE redemption_id = ?', 'r-old').n, 0);
  });

  test('disconnessione Twitch: PAUSED senza chiudere la diretta, poi ripresa sulla stessa sessione', async () => {
    await startOffline();
    await goLive('b-7');
    const sessionId = app.engine.sessions.current(false).id;
    app.engine.tick();
    assert.ok(app.engine.status().activeSpawn);

    es.dropAll();
    await waitFor(() => app.sm.state === 'PAUSED', { message: 'stato PAUSED' });
    assert.equal(app.engine.running, false);
    assert.equal(app.engine.suspended, true);
    assert.equal(app.engine.sessions.current(false).id, sessionId, 'sessione non chiusa');
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM spawn_history WHERE status = 'active'").n, 0, 'spawn sospeso');
    assert.equal(app.engine.tick(), null, 'nessuno spawn in pausa');

    // Il client si riconnette da solo; Twitch conferma che la diretta continua.
    await waitFor(() => app.sm.state === 'LIVE', { message: 'ripresa LIVE' });
    assert.equal(app.engine.running, true);
    assert.equal(app.engine.sessions.current(false).id, sessionId, 'stessa sessione, nessun duplicato');
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM stream_sessions').n, 1);
  });

  test('disconnessione e riconnessione a diretta terminata: chiude la sessione', async () => {
    await startOffline();
    await goLive('b-8');
    const sessionId = app.engine.sessions.current(false).id;
    tw.live = null;
    es.dropAll();
    await waitFor(() => app.sm.state === 'OFFLINE', { message: 'OFFLINE dopo riconnessione' });
    assert.ok(app.engine.sessions.byId(sessionId).ended_at);
    assert.equal(app.engine.running, false);
  });

  test('evento stream.online perso: il controllo periodico rileva la diretta', async () => {
    await startOffline();
    tw.live = { id: 'b-poll' };
    await app.monitor.poll();
    assert.equal(app.sm.state, 'LIVE');
    assert.equal(app.engine.sessions.current(false).broadcast_id, 'b-poll');
    // stream.offline perso: servono conferme consecutive (2) prima di chiudere.
    tw.live = null;
    app.monitor.lastOnlineEventAt = 0;
    await app.monitor.poll();
    assert.equal(app.sm.state, 'LIVE', 'una sola conferma non basta');
    await app.monitor.poll();
    assert.equal(app.sm.state, 'OFFLINE');
  });

  test('API Twitch irraggiungibili: nessun cambio di stato precipitoso', async () => {
    await startOffline();
    await goLive();
    tw.helixDown = true;
    await app.monitor.poll();
    await app.monitor.poll();
    assert.equal(app.sm.state, 'LIVE');
    assert.equal(app.engine.running, true);
  });

  test('comandi chat in diretta: !pokedex risponde riconoscendo l\'utente', async () => {
    await startOffline();
    await goLive();
    app.engine.tick();
    rng.push(0.0);
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'rc', rewardId: reward.rewardId, userId: '3001', login: 'mario', name: 'Mario' }));
    await waitFor(() => app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n === 1);
    es.notify('channel.chat.message', { chatter_user_id: '3001', chatter_user_login: 'mario', chatter_user_name: 'Mario', message_id: 'cm1', message: { text: '!pokedex' } });
    await waitFor(() => tw.chat.length >= 1, { message: 'risposta in chat' });
    const msg = tw.chat.at(-1);
    assert.equal(msg.message, '@Mario hai catturato 1 Pokémon e scoperto 1 specie! (0 shiny)');
    assert.equal(msg.broadcaster_id, BROADCASTER_ID);
    assert.equal(msg.reply_parent_message_id, 'cm1');
  });

  test('token non valido: stato ERROR e motore fermo', async () => {
    tw.tokenValid = false;
    const origFetch = tw.fetch;
    tw.fetch = async (url, opts) => {
      if (String(url).includes('/eventsub/subscriptions')) return new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 });
      if (String(url).includes('/oauth2/token')) return new Response(JSON.stringify({ message: 'Invalid refresh token' }), { status: 400 });
      return origFetch(url, opts);
    };
    app.helix.fetch = tw.fetch;
    app.oauth.fetch = tw.fetch;
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'ERROR', { message: 'stato ERROR' });
    assert.equal(app.engine.running, false);
  });

  test('senza credenziali: stato ERROR not_configured, nessuna connessione', async () => {
    app.credentials.clearToken('broadcaster');
    await app.monitor.start();
    assert.equal(app.sm.state, 'ERROR');
    assert.equal(app.sm.reason, 'not_configured');
    assert.equal(tw.subscriptions.length, 0);
  });
});
