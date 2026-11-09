// Token Twitch revocati: il gioco si ferma subito, le ricompense che non è
// possibile mettere in pausa vengono segnalate, i rimborsi non vanno persi e
// tutto si riallinea al ricollegamento dell'account. Un bot revocato non ferma
// il gioco. (Twitch simulato.)
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, queuedRedemption, seqRng, BROADCASTER_ID } from './helpers.js';

const MANAGED = '11111111-1111-1111-1111-111111111111';
const REDEMPTION_ADD = 'channel.channel_points_custom_reward_redemption.add';

describe('Token Twitch revocati e ricompense ancora attive', () => {
  let ctx, app, tw, es;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng: seqRng() });
    app = ctx.app;
    seedPokemon(app.db);
    linkReward(app, 'pokeball', MANAGED, true);
  });

  afterEach(async () => {
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const goLive = async () => {
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE', { timeout: 8000, message: 'OFFLINE' });
    tw.live = { id: 'b-1' };
    es.notify('stream.online', { id: 'b-1', broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE', { timeout: 8000, message: 'LIVE' });
    await waitFor(() => tw.rewardPatches.at(-1)?.is_paused === false, { message: 'ricompensa riattivata in LIVE' });
  };
  const revokeBroadcaster = () => ['access', 'refresh', 'newaccess', 'newrefresh'].forEach((t) => tw.revokedTokens.add(t));
  const reward = () => app.db.get('SELECT is_paused, sync_error FROM twitch_rewards WHERE reward_id = ?', MANAGED);
  const attempt = (id) => app.db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', id);

  test('canale scollegato in LIVE: ERROR immediato, ricompensa segnalata, rimborsi completati al ricollegamento', async () => {
    await goLive();
    const patchesBefore = tw.rewardPatches.length;

    // Il canale scollega l'app da Twitch: token invalidati e sottoscrizioni revocate.
    revokeBroadcaster();
    es.revoke(REDEMPTION_ADD, 'authorization_revoked');
    await waitFor(() => app.sm.state === 'ERROR', { message: 'ERROR subito dopo la revoca' });
    assert.equal(app.engine.suspended || app.engine.mode !== 'live', true, 'il gioco non accetta lanci');
    await waitFor(() => reward().sync_error, { message: 'pausa tentata e fallita' });
    await app.monitor.pauseChain;
    assert.equal(tw.rewardPatches.length, patchesBefore, 'Twitch non ha accettato la pausa (token revocato)');

    const st = app.monitor.status();
    assert.ok(st.authErrors.broadcaster, 'errore di autorizzazione del canale esposto alla dashboard');
    assert.equal(st.rewardsPause.atRisk.length, 1, 'la ricompensa non in pausa è segnalata come a rischio');
    assert.equal(app.credentials.publicView().broadcaster.authError.reason.length > 0, true);
    assert.doesNotMatch(JSON.stringify([st, app.credentials.publicView()]), /accessToken|refreshToken|"access"|"refresh"/, 'nessun token nello stato');

    // Un riscatto arriva ancora (evento già in viaggio) e un altro resta in coda su Twitch.
    es.notify(REDEMPTION_ADD, redemption({ id: 'during-1', rewardId: MANAGED }));
    await waitFor(() => attempt('during-1'), { message: 'riscatto registrato' });
    assert.equal(attempt('during-1').outcome, 'rejected');
    await waitFor(() => attempt('during-1').status_error, { message: 'rimborso tentato' });
    tw.queue.push({ ...queuedRedemption({ id: 'during-1', rewardId: MANAGED }) });
    tw.queue.push(queuedRedemption({ id: 'queued-1', rewardId: MANAGED, userId: '3001', login: 'luigi', name: 'Luigi' }));

    // Molti tentativi con il token revocato non esauriscono i ritentativi del rimborso.
    for (let i = 0; i < 8; i++) await app.monitor.reconciler.push(attempt('during-1'));
    assert.equal(attempt('during-1').status_tries, 0, 'gli errori di autorizzazione non consumano i tentativi');
    await app.monitor.poll(); // il controllo periodico resta in ERROR senza perdere nulla
    assert.equal(app.sm.state, 'ERROR');

    // Ricollegamento dell'account del canale (Device Code Flow), come fa la dashboard.
    await app.oauth.startDeviceFlow('broadcaster');
    assert.equal((await app.oauth.pollDeviceFlow('broadcaster')).status, 'pending');
    assert.equal((await app.oauth.pollDeviceFlow('broadcaster')).status, 'authorized');
    await app.monitor.restart();
    tw.live = null; // la diretta di prova è finita nel frattempo
    await waitFor(() => app.sm.state === 'OFFLINE', { timeout: 8000, message: 'OFFLINE dopo il ricollegamento' });

    await waitFor(() => tw.rewardPatches.at(-1)?.is_paused === true && reward().is_paused === 1 && !reward().sync_error, { message: 'ricompensa messa in pausa al ricollegamento' });
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'during-1' && u.status === 'CANCELED'), { message: 'rimborso del riscatto durante la revoca' });
    await waitFor(() => tw.redemptionUpdates.some((u) => u.id === 'queued-1' && u.status === 'CANCELED'), { message: 'rimborso del riscatto rimasto in coda' });
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM user_pokemon").n, 0, 'nessuna cattura durante la revoca');

    const after = app.monitor.status();
    assert.equal(after.authErrors.broadcaster, null, 'errore di autorizzazione azzerato');
    assert.deepEqual(after.rewardsPause.atRisk, []);
  });

  test('token revocato rilevato dal controllo periodico; quando il rinnovo torna valido si ricollega EventSub', async () => {
    await goLive();
    revokeBroadcaster();
    await app.monitor.poll();
    assert.equal(app.sm.state, 'ERROR');
    assert.ok(app.credentials.authError('broadcaster'));

    // Il rinnovo torna a funzionare (es. problema temporaneo lato Twitch).
    tw.revokedTokens.clear();
    const subsBefore = tw.subscriptions.length;
    await app.monitor.poll();
    await waitFor(() => app.sm.state === 'LIVE', { timeout: 8000, message: 'di nuovo LIVE' });
    assert.ok(tw.subscriptions.length > subsBefore, 'sottoscrizioni EventSub ricreate');
    assert.equal(app.credentials.authError('broadcaster'), null);
  });

  test('bot revocato: il gioco resta LIVE e le risposte passano all\'account del canale', async () => {
    app.credentials.setToken('bot', { accessToken: 'botaccess', refreshToken: 'botrefresh', expiresAt: Date.now() + 3600e3, userId: '5000', login: 'mio_bot', displayName: 'mio_bot' });
    await goLive();
    tw.revokedTokens.add('botaccess');
    tw.revokedTokens.add('botrefresh');

    app.chat.send('messaggio di prova');
    await waitFor(() => tw.chat.some((m) => m.message === 'messaggio di prova'), { message: 'messaggio consegnato' });
    const sent = tw.chat.filter((m) => m.message === 'messaggio di prova');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sender_id, BROADCASTER_ID, 'inviato dall\'account del canale');
    assert.ok(app.credentials.authError('bot'));
    assert.equal(app.sm.state, 'LIVE', 'un bot revocato non ferma il gioco');

    // Anche il controllo orario dei token non porta il gioco in ERROR per colpa del bot.
    await app.monitor.validateTokens();
    assert.equal(app.sm.state, 'LIVE');
    assert.equal(app.monitor.status().authErrors.bot.reason.length > 0, true);
  });
});
