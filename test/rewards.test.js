// Channel Points: pausa/riattivazione automatica delle ricompense, recupero dei
// riscatti rimasti in coda dopo una disconnessione EventSub, ritentativi degli
// aggiornamenti di stato, eventi tardivi e ricompense non elaborabili.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, queuedRedemption, seqRng, BROADCASTER_ID } from './helpers.js';

const MANAGED = '11111111-1111-1111-1111-111111111111';
const LINKED = '22222222-2222-2222-2222-222222222222';

describe('Channel Points: pausa, riconciliazione e riconnessione', () => {
  let ctx, app, tw, es, rng;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    rng = seqRng();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    app = ctx.app;
    seedPokemon(app.db);
    linkReward(app, 'pokeball', MANAGED, true);
    linkReward(app, 'ultraball', LINKED, false); // collegata a mano: non gestibile via API
    tw.foreignRewards.add(LINKED);
  });

  afterEach(async () => {
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const startOffline = async () => {
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE', {
      timeout: 8000,
      message: { toString: () => `stato OFFLINE (attuale ${app.sm.state}, transizioni ${JSON.stringify(app.sm.history.map((h) => `${h.from}>${h.to}:${h.reason}`))}, eventsub ${app.monitor.eventsub?.connected}, errore ${app.monitor.lastError})` },
    });
  };
  const goLive = async (id = 'b-1') => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE', { timeout: 8000, message: 'stato LIVE' });
  };
  const pauseState = () => app.db.get('SELECT is_paused, sync_error FROM twitch_rewards WHERE reward_id = ?', MANAGED);
  const attempt = (id) => app.db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', id);

  test('ricompense dell\'app in pausa da offline, riattivate in LIVE, di nuovo in pausa a fine diretta', async () => {
    await startOffline();
    await waitFor(() => tw.rewardPatches.length === 1, { message: 'pausa iniziale' });
    assert.deepEqual(tw.rewardPatches[0], { id: MANAGED, is_paused: true });
    assert.equal(pauseState().is_paused, 1);

    await goLive();
    await waitFor(() => tw.rewardPatches.length === 2, { message: 'riattivazione' });
    assert.deepEqual(tw.rewardPatches[1], { id: MANAGED, is_paused: false });
    assert.equal(pauseState().is_paused, 0);

    // Disconnessione: il gioco è sospeso, le ricompense vengono messe in pausa.
    es.dropAll();
    await waitFor(() => app.sm.state === 'PAUSED' || tw.rewardPatches.length >= 3);
    await waitFor(() => app.sm.state === 'LIVE', { message: 'ripresa dopo la riconnessione' });
    await app.monitor.pauseChain;
    assert.equal(tw.rewardPatches.at(-1).is_paused, false, 'riattivate alla ripresa');

    tw.live = null;
    es.notify('stream.offline', { broadcaster_user_id: BROADCASTER_ID });
    await waitFor(() => app.sm.state === 'OFFLINE');
    await waitFor(() => tw.rewardPatches.at(-1).is_paused === true, { message: 'pausa a fine diretta' });
    assert.ok(tw.rewardPatches.every((p) => p.id === MANAGED), 'le ricompense collegate a mano non vengono mai modificate');
  });

  test('pausa non riuscita: errore registrato e ritentato al controllo successivo; disattivabile', async () => {
    tw.failRewardPatch = 100;
    await startOffline();
    await waitFor(() => pauseState().sync_error, { message: 'errore registrato' });
    await app.monitor.pauseChain;
    assert.equal(pauseState().is_paused, 0);
    tw.failRewardPatch = 0; // Twitch torna disponibile
    await app.monitor.poll();
    await app.monitor.pauseChain;
    assert.equal(pauseState().is_paused, 1);
    assert.equal(pauseState().sync_error, null);

    app.gameSettings.set('rewards', { ...app.gameSettings.get('rewards'), autoPause: false });
    const before = tw.rewardPatches.length;
    await goLive();
    await new Promise((r) => setTimeout(r, 50));
    await app.monitor.pauseChain;
    assert.equal(tw.rewardPatches.length, before, 'nessuna modifica con la pausa automatica disattivata');
  });

  test('riscatti fatti durante una disconnessione in LIVE: recuperati alla riconnessione e rimborsati (spawn interrotto)', async () => {
    await startOffline();
    await goLive();
    assert.ok(app.engine.tick());
    es.dropAll();
    await waitFor(() => app.sm.state === 'PAUSED', { message: 'PAUSED' });
    tw.queue.push(queuedRedemption({ id: 'lost-1', rewardId: MANAGED, userId: '3001', login: 'luigi', name: 'Luigi' }));
    await waitFor(() => attempt('lost-1'), { message: 'riscatto recuperato', timeout: 4000 });
    assert.equal(app.sm.state, 'LIVE');
    const a = attempt('lost-1');
    assert.equal(a.source, 'recovered');
    assert.equal(a.outcome, 'rejected');
    assert.equal(a.reject_reason, 'no_spawn', 'lo spawn in campo è stato interrotto dalla disconnessione');
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'lost-1' && u.status === 'CANCELED'), { message: 'punti rimborsati' });
  });

  test('evento perso con connessione attiva: il riscatto viene recuperato ed elaborato, senza duplicati', async () => {
    await startOffline();
    await goLive();
    assert.ok(app.engine.tick());
    // Twitch non consegna la notifica: il riscatto resta solo in coda.
    tw.queue.push(queuedRedemption({ id: 'miss-1', rewardId: MANAGED, userId: '3001', login: 'luigi', name: 'Luigi' }));
    rng.push(0.0); // cattura riuscita
    const r = await app.monitor.reconciler.run('periodic');
    assert.equal(r.recovered, 1);
    const a = attempt('miss-1');
    assert.equal(a.source, 'recovered');
    assert.equal(a.outcome, 'caught', `esito: ${a.outcome} ${a.reject_reason}`);
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'miss-1' && u.status === 'FULFILLED'), { message: 'FULFILLED' });
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE user_id = ?', a.user_id).n, 1);

    // La notifica arriva in ritardo via EventSub: nessuna seconda cattura.
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'miss-1', rewardId: MANAGED, userId: '3001', login: 'luigi', name: 'Luigi' }));
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE redemption_id = 'miss-1'").n, 1);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE user_id = ?', a.user_id).n, 1);
    const again = await app.monitor.reconciler.run('test');
    assert.equal(again.recovered, 0);
    assert.equal(app.monitor.status().reconcile.reason, 'test');
  });

  test('riscatti rimasti in coda da offline: rimborsati all\'avvio (eventi tardivi)', async () => {
    const old = new Date(Date.now() - 3 * 3600e3).toISOString();
    tw.queue.push(queuedRedemption({ id: 'old-1', rewardId: MANAGED, redeemedAt: old }));
    tw.queue.push(queuedRedemption({ id: 'linked-1', rewardId: LINKED, redeemedAt: old }));
    await startOffline();
    await waitFor(() => attempt('old-1'), { message: 'recuperato' });
    assert.equal(attempt('old-1').outcome, 'rejected');
    assert.equal(attempt('old-1').reject_reason, 'offline');
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'old-1' && u.status === 'CANCELED'), { message: 'rimborso' });
    // La ricompensa collegata a mano non è leggibile né rimborsabile via API: nessuna promessa.
    assert.ok(!attempt('linked-1'));
    assert.deepEqual(app.monitor.reconciler.last.errors, []);
    assert.ok(!tw.redemptionUpdates.some((u) => u.id === 'linked-1'), 'nessun rimborso promesso per la ricompensa collegata');
    assert.equal(tw.calls.filter((c) => c === 'GET /helix/channel_points/custom_rewards/redemptions').length, 1, 'solo la ricompensa dell\'app viene interrogata');
  });

  test('aggiornamento dello stato fallito: registrato e ritentato; 404 non viene ritentato', async () => {
    await startOffline();
    tw.failRedemptionUpdates = 1;
    tw.queue.push(queuedRedemption({ id: 'r-err', rewardId: MANAGED }));
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-err', rewardId: MANAGED }));
    await waitFor(() => attempt('r-err')?.status_error, { message: 'errore registrato' });
    assert.equal(attempt('r-err').desired_status, 'CANCELED');
    assert.equal(attempt('r-err').status_tries, 1);
    assert.equal(app.monitor.reconciler.pending().length, 1);
    const r = await app.monitor.reconciler.run('retry');
    assert.equal(r.retried, 1);
    assert.equal(attempt('r-err').redemption_status, 'CANCELED');
    assert.equal(attempt('r-err').status_error, null);
    assert.equal(app.monitor.reconciler.pending().length, 0);

    // Riscossione già gestita a mano su Twitch: 404, segnata come definitiva.
    tw.goneRedemptions.add('r-gone');
    tw.queue.push(queuedRedemption({ id: 'r-gone', rewardId: MANAGED }));
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-gone', rewardId: MANAGED }));
    await waitFor(() => attempt('r-gone')?.status_error, { message: '404 registrato' });
    assert.match(attempt('r-gone').status_error, /non più in coda/);
    const calls = tw.calls.length;
    const r2 = await app.monitor.reconciler.run('retry2');
    assert.equal(r2.retried, 0, 'non ritentato');
    assert.equal(tw.calls.slice(calls).filter((c) => c.startsWith('PATCH')).length, 0);
  });

  test('evento EventSub tardivo (>10 minuti): registrato come scartato e recuperato dalla riconciliazione', async () => {
    await startOffline();
    const ts = new Date(Date.now() - 20 * 60e3).toISOString();
    tw.queue.push(queuedRedemption({ id: 'late-1', rewardId: MANAGED }));
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'late-1', rewardId: MANAGED }), { messageId: 'stale-msg', timestamp: ts });
    await waitFor(() => app.db.get("SELECT * FROM twitch_events WHERE message_id = 'stale-msg'"), { message: 'evento registrato' });
    assert.equal(app.db.get("SELECT status FROM twitch_events WHERE message_id = 'stale-msg'").status, 'stale');
    assert.ok(!attempt('late-1'), 'non elaborato direttamente');
    await app.monitor.reconciler.run('test');
    assert.equal(attempt('late-1').source, 'recovered');
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'late-1'));
  });

  test('ricompensa del gioco senza Poké Ball valida: rifiutata e rimborsata invece di essere ignorata', async () => {
    await startOffline();
    await goLive();
    app.engine.tick();
    app.db.run('UPDATE twitch_rewards SET ball_type_id = NULL WHERE reward_id = ?', MANAGED);
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-unmapped', rewardId: MANAGED }));
    await waitFor(() => attempt('r-unmapped'));
    assert.equal(attempt('r-unmapped').reject_reason, 'reward_unmapped');
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'r-unmapped' && u.status === 'CANCELED'));
    // Una ricompensa che non appartiene al gioco resta ignorata.
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'r-other', rewardId: '99999999-9999-9999-9999-999999999999' }));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(!attempt('r-other'));
    assert.ok(!tw.redemptionUpdates.some((u) => u.id === 'r-other'));
  });

  test('API dashboard: stato riscatti in sospeso e recupero manuale', async () => {
    await startOffline();
    tw.queue.push(queuedRedemption({ id: 'api-1', rewardId: MANAGED }));
    const port = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'initialpass123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrf } = await login.json();
    const H = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
    await fetch(`${base}/api/auth/change-password`, { method: 'POST', headers: H, body: JSON.stringify({ currentPassword: 'initialpass123', newPassword: 'NuovaPassword2026' }) });
    const run = await (await fetch(`${base}/api/admin/twitch/redemptions/reconcile`, { method: 'POST', headers: H })).json();
    assert.equal(run.recovered, 1);
    const st = await (await fetch(`${base}/api/admin/twitch/redemptions`, { headers: H })).json();
    assert.equal(st.recovered[0].redemption_id, 'api-1');
    assert.ok(Array.isArray(st.pending));
    const sync = await fetch(`${base}/api/admin/twitch/rewards/sync-pause`, { method: 'POST', headers: H });
    assert.equal(sync.status, 200);
  });
});
