// Errori temporanei di Twitch (A1): 429, 5xx, timeout e rete assente non sono
// revoche. Il gioco resta in LIVE, nessuna pausa o rimborso inutile, e lo stato
// torna pulito quando Twitch risponde di nuovo. Solo un rifiuto reale del
// refresh token (400/401) attiva la procedura di revoca. (Twitch simulato.)
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, seqRng, BROADCASTER_ID } from './helpers.js';
import { fetchWithRetry, retryAfterMs, TwitchTransientError } from '../src/twitch/http.js';

const MANAGED = '11111111-1111-1111-1111-111111111111';

describe('Twitch: errori temporanei durante una diretta', () => {
  let ctx, app, tw, es;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng: seqRng(), env: { TWITCH_HTTP_TIMEOUT_MS: '150' } });
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
    await app.monitor.pauseChain;
  };
  const tokenCalls = () => tw.calls.filter((c) => c === 'POST /oauth2/token').length;

  // Il gioco è ancora operativo e non è stato generato nulla di inutile.
  const assertStillPlaying = async (patchesBefore, msg) => {
    await new Promise((r) => setImmediate(r));
    await app.monitor.pauseChain;
    assert.equal(app.sm.state, 'LIVE', `${msg}: resta LIVE`);
    assert.equal(app.engine.running, true, `${msg}: motore attivo`);
    assert.equal(!!app.engine.suspended, false, `${msg}: motore non sospeso`);
    assert.equal(app.credentials.authError('broadcaster'), null, `${msg}: token non marcato come revocato`);
    assert.equal(app.monitor.authFailed, false, `${msg}: nessuna procedura di revoca`);
    assert.equal(tw.rewardPatches.length, patchesBefore, `${msg}: nessuna pausa delle ricompense`);
    assert.deepEqual(tw.redemptionUpdates.filter((u) => u.status === 'CANCELED'), [], `${msg}: nessun rimborso`);
  };

  test('503 su /validate e poi sul rinnovo: nessuna revoca, avviso temporaneo, recupero pulito', async () => {
    await goLive();
    const patches = tw.rewardPatches.length;

    tw.fault('/oauth2/validate', { status: 503 });
    await app.monitor.validateTokens();
    await assertStillPlaying(patches, '/validate in 503');
    assert.equal(tw.faults[0].hits, 3, 'una richiesta + 2 ritentativi');
    assert.equal(app.monitor.status().transientIssue.status, 503);
    assert.match(app.monitor.status().lastError, /temporaneo.*il gioco continua/i);

    // Il token risulta scaduto (401) ma il rinnovo trova Twitch in 503.
    tw.faults = [];
    tw.tokenValid = false;
    tw.fault('/oauth2/token', { status: 503 });
    await app.monitor.validateTokens();
    await assertStillPlaying(patches, 'rinnovo in 503');
    assert.equal(app.credentials.getToken('broadcaster').accessToken, 'access', 'token invariato');

    // Twitch torna disponibile: rinnovo riuscito, avviso rimosso, nessun riavvio.
    tw.faults = [];
    const subs = tw.subscriptions.length;
    await app.monitor.validateTokens();
    assert.equal(app.credentials.getToken('broadcaster').accessToken, 'newaccess');
    assert.equal(app.monitor.status().transientIssue, null);
    assert.equal(app.monitor.status().lastError, null);
    await assertStillPlaying(patches, 'dopo il recupero');
    assert.equal(tw.subscriptions.length, subs, 'EventSub non viene ricollegato inutilmente');
  });

  test('429 con Retry-After: attesa rispettata e rinnovo riuscito; attesa troppo lunga = nessun martellamento', async () => {
    await goLive();
    const patches = tw.rewardPatches.length;
    tw.tokenValid = false;

    tw.fault('/oauth2/token', { status: 429, headers: { 'Retry-After': '0' }, times: 1 });
    const before = tokenCalls();
    await app.monitor.validateTokens();
    assert.equal(tokenCalls() - before, 2, 'ritentato dopo il 429');
    assert.equal(app.credentials.getToken('broadcaster').accessToken, 'newaccess');
    await assertStillPlaying(patches, '429 breve');

    tw.fault('/oauth2/token', { status: 429, headers: { 'Retry-After': '120' } });
    const before2 = tokenCalls();
    await app.monitor.validateTokens();
    assert.equal(tokenCalls() - before2, 1, 'Retry-After oltre il massimo: nessun ritentativo immediato');
    assert.equal(app.monitor.status().transientIssue.status, 429);
    await assertStillPlaying(patches, '429 lungo');
  });

  test('timeout: /validate che non risponde non blocca il controllo e non revoca il token', async () => {
    await goLive();
    const patches = tw.rewardPatches.length;
    tw.fault('/oauth2/validate', { hang: true });
    const t0 = Date.now();
    await app.monitor.validateTokens();
    assert.ok(Date.now() - t0 < 3000, `concluso in ${Date.now() - t0} ms`);
    assert.match(app.monitor.status().transientIssue.message, /timeout/);
    await assertStillPlaying(patches, 'timeout');
  });

  test('rete assente durante il rinnovo: nessuna revoca (prima portava in ERROR)', async () => {
    await goLive();
    const patches = tw.rewardPatches.length;
    tw.tokenValid = false;
    tw.fault('/oauth2/token', { network: true });
    await app.monitor.validateTokens();
    assert.equal(tw.faults[0].hits, 3);
    await assertStillPlaying(patches, 'rete assente');

    // Anche Helix irraggiungibile al controllo periodico: nessun cambio di stato.
    tw.fault('/helix', { network: true });
    await app.monitor.poll();
    await assertStillPlaying(patches, 'Helix irraggiungibile');
    tw.faults = [];
    await app.monitor.poll();
    assert.equal(app.monitor.status().transientIssue, null, 'avviso rimosso al primo controllo riuscito');
  });

  test('5xx persistente di Helix al controllo periodico: la diretta continua e si riprende da sola', async () => {
    await goLive();
    const patches = tw.rewardPatches.length;
    tw.fault('/helix/streams', { status: 502 });
    for (let i = 0; i < 3; i++) await app.monitor.poll();
    await assertStillPlaying(patches, 'Helix 502');
    assert.equal(app.monitor.status().lastPoll.ok, false);
    tw.faults = [];
    await app.monitor.poll();
    assert.equal(app.monitor.status().lastPoll.ok, true);
    assert.equal(app.monitor.status().transientIssue, null);
    await assertStillPlaying(patches, 'dopo il recupero');
  });

  test('token realmente revocato: il rinnovo risponde 400 e scatta la procedura di revoca', async () => {
    await goLive();
    tw.tokenValid = false;
    tw.revokedTokens.add('refresh');
    await app.monitor.validateTokens();
    assert.equal(app.sm.state, 'ERROR');
    assert.ok(app.credentials.authError('broadcaster'), 'token marcato come non valido');
    assert.equal(app.monitor.status().transientIssue, null);
    await waitFor(() => app.monitor.desiredPaused(), { message: 'gioco fermo' });
  });

  test('rinnovo deduplicato: controllo orario e richieste Helix concorrenti fanno un solo rinnovo', async () => {
    await goLive();
    tw.tokenValid = false;
    const t = app.credentials.getToken('broadcaster');
    app.credentials.setToken('broadcaster', { ...t, expiresAt: Date.now() + 1000 }); // in scadenza
    // Rinnovo lento: le tre chiamate si sovrappongono sicuramente.
    const base = app.oauth.fetch;
    app.oauth.fetch = async (url, o) => { if (String(url).endsWith('/oauth2/token')) await new Promise((r) => setTimeout(r, 80)); return base(url, o); };
    const before = tokenCalls();
    await Promise.all([app.monitor.validateTokens(), app.helix.getStream(BROADCASTER_ID), app.helix.getStream(BROADCASTER_ID)]);
    assert.equal(tokenCalls() - before, 1, 'un solo POST /oauth2/token');
    assert.equal(app.sm.state, 'LIVE');
  });

  test('collegamento account (Device Code Flow): un 503 durante il polling non interrompe il flusso', async () => {
    await app.oauth.startDeviceFlow('broadcaster');
    tw.fault('/oauth2/token', { status: 503, times: 1 });
    assert.equal((await app.oauth.pollDeviceFlow('broadcaster')).status, 'pending');
    assert.equal((await app.oauth.pollDeviceFlow('broadcaster')).status, 'pending'); // authorization_pending
    assert.equal((await app.oauth.pollDeviceFlow('broadcaster')).status, 'authorized');
  });
});

describe('fetchWithRetry (unità)', () => {
  const resp = (status, headers = {}) => new Response('{}', { status, headers });
  const seq = (...items) => {
    const calls = [];
    const fn = async (url, init) => { calls.push(init.method || 'GET'); const x = items.shift(); if (x instanceof Error) throw x; return x; };
    fn.calls = calls;
    return fn;
  };

  test('Retry-After in secondi e Ratelimit-Reset di Helix vengono rispettati', async () => {
    const sleeps = [];
    const f = seq(resp(429, { 'Retry-After': '3' }), resp(200));
    const r = await fetchWithRetry(f, 'http://x.test/a', {}, { sleep: async (ms) => sleeps.push(ms) });
    assert.equal(r.status, 200);
    assert.deepEqual(sleeps, [3000]);

    const now = Date.now();
    assert.ok(Math.abs(retryAfterMs(resp(429, { 'Ratelimit-Reset': String(Math.floor(now / 1000) + 5) }), now) - 5000) <= 1000);
    assert.equal(retryAfterMs(resp(503)), null);
  });

  test('backoff esponenziale su 5xx e rete; esaurito = errore temporaneo (non revoca)', async () => {
    const sleeps = [];
    const f = seq(resp(500), new TypeError('fetch failed'), resp(503));
    await assert.rejects(fetchWithRetry(f, 'http://x.test/a', {}, { baseDelayMs: 100, sleep: async (ms) => sleeps.push(ms) }), (e) => {
      assert.ok(e instanceof TwitchTransientError);
      assert.equal(e.transient, true);
      assert.equal(e.authInvalid, false);
      assert.equal(e.status, 503);
      return true;
    });
    assert.deepEqual(sleeps, [100, 200]);
  });

  test('POST: ritentata solo dopo 429, mai dopo 5xx o errori di rete (evita doppi invii)', async () => {
    const f1 = seq(resp(503), resp(200));
    await assert.rejects(fetchWithRetry(f1, 'http://x.test/a', { method: 'POST' }, { sleep: async () => {} }), { transient: true });
    assert.equal(f1.calls.length, 1);
    const f2 = seq(new TypeError('fetch failed'), resp(200));
    await assert.rejects(fetchWithRetry(f2, 'http://x.test/a', { method: 'POST' }, { sleep: async () => {} }), { transient: true });
    assert.equal(f2.calls.length, 1);
    const f3 = seq(resp(429), resp(200));
    assert.equal((await fetchWithRetry(f3, 'http://x.test/a', { method: 'POST' }, { sleep: async () => {} })).status, 200);
    assert.equal(f3.calls.length, 2);
  });

  test('4xx diversi da 429 restituiti al chiamante senza ritentativi', async () => {
    const f = seq(resp(401), resp(200));
    assert.equal((await fetchWithRetry(f, 'http://x.test/a', {}, { sleep: async () => {} })).status, 401);
    assert.equal(f.calls.length, 1);
  });
});
