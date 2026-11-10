// Effetti sonori per OBS: suono allo spawn (casuale, senza ripetere l'ultimo) e
// musica alla cattura confermata. Gli eventi passano dal vero motore (EventSub
// simulato per le dirette, API della dashboard per le sessioni manuali) e
// arrivano solo al canale WebSocket "audio" della Browser Source /overlay/audio.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID, adminClient,
} from './helpers.js';
import { AudioPlayer, MAX_AGE_MS } from '../public/assets/js/overlay/audio-core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARIO = { id: '2001', login: 'mario', name: 'Mario' };
// Collezione di prova: 4 jingle per lo spawn, la musica di cattura, un brano lungo
// (non selezionato in automatico) e file da ignorare.
const FILES = {
  'Disc 1/06 - Obtained a Key Item!.mp3': 'k',
  'Disc 1/10 - Level Up!.mp3': 'l',
  'Disc 1/12 - Obtained an Item!.mp3': 'o',
  // "é" scomposta (NFD), come nei file estratti da uno zip su macOS.
  ['Disc 1/18 - Pok\u0065\u0301mon Healed.mp3']: 'h',
  'Disc 1/15 - Caught a Pokémon!.mp3': 'c',
  'Disc 1/11 - Route 1.mp3': 'r',
  'note.txt': 'x',
};
const SPAWN_AUTO = ['06 - Obtained a Key Item!', '10 - Level Up!', '12 - Obtained an Item!', '18 - Pokémon Healed'];

// Generatore deterministico per le scelte casuali dei suoni.
const lcg = (seed = 7) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function addFiles(app, files = FILES) {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(app.config.audioDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, Buffer.from(`ID3-${body}-${rel}`));
  }
  app.audio.cache = null;
}

function socket(port, path) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  const open = new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  return { ws, msgs, open, plays: () => msgs.filter((m) => m.type === 'play').map((m) => m.data) };
}

describe('Effetti sonori per OBS', () => {
  let ctx, app, tw, es, rng, client, reward, port, audioWs, seq;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    rng = seqRng();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    app = ctx.app;
    seedPokemon(app.db);
    reward = linkReward(app, 'pokeball');
    addFiles(app);
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE', { message: 'stato OFFLINE' });
    client = await adminClient(app);
    port = app.server.address().port;
    audioWs = socket(port, '/ws/audio');
    await audioWs.open;
    await waitFor(() => audioWs.msgs.some((m) => m.type === 'snapshot'), { message: 'snapshot audio' });
    seq = 0;
  });

  afterEach(async () => {
    audioWs?.ws.close();
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const goLive = async (id = 'b-live') => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE', { message: 'stato LIVE' });
  };
  const spawn = async (pokemonId = 1) => {
    const r = await client.req('POST', '/api/admin/spawn/manual', { pokemonId, shiny: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const cancelSpawn = () => client.req('POST', '/api/admin/spawn/cancel', {});
  const manualStart = async () => assert.equal((await client.req('POST', '/api/admin/game/manual/start', {})).status, 200);
  // roll: tiro di cattura (null = lancio rifiutato, nessun tiro).
  const manualThrow = async (roll, name = 'Ash') => {
    if (roll != null) rng.push(roll);
    const r = await client.req('POST', '/api/admin/game/manual/throw', { ballTypeId: reward.ball.id, name });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const settle = () => sleep(60); // consegna dei messaggi WebSocket
  const plays = () => audioWs.plays();

  test('selezione casuale dei suoni di spawn: solo dalla lista configurata', () => {
    app.audio.rng = lcg(3);
    const seen = new Map();
    for (let i = 1; i <= 80; i++) {
      const ev = app.audio.onSpawn({ id: 1000 + i, demo: false });
      seen.set(ev.name, (seen.get(ev.name) || 0) + 1);
    }
    assert.deepEqual([...seen.keys()].sort(), [...SPAWN_AUTO].sort(), 'tutti e soli i jingle della lista automatica');
    for (const n of seen.values()) assert.ok(n >= 10, 'distribuzione non degenere');
    assert.ok(!seen.has('15 - Caught a Pokémon!'), 'la musica di cattura non è tra i suoni di spawn');

    // Lista scelta dall'amministratore.
    app.audio.setSettings({ spawnFiles: ['Disc 1/11 - Route 1.mp3', 'Disc 1/10 - Level Up!.mp3'] });
    const names = new Set();
    for (let i = 1; i <= 20; i++) names.add(app.audio.onSpawn({ id: 2000 + i }).name);
    assert.deepEqual([...names].sort(), ['10 - Level Up!', '11 - Route 1']);
  });

  test('nessuna ripetizione consecutiva dello stesso suono (anche con un generatore sfavorevole)', () => {
    app.audio.rng = () => 0; // sceglierebbe sempre il primo
    let prev = null;
    for (let i = 1; i <= 50; i++) {
      const ev = app.audio.onSpawn({ id: 3000 + i });
      assert.notEqual(ev.name, prev, `spawn ${i}: stesso suono del precedente`);
      prev = ev.name;
    }
    // Con un solo file la ripetizione è inevitabile, ma il suono parte comunque.
    app.audio.setSettings({ spawnFiles: ['Disc 1/10 - Level Up!.mp3'] });
    assert.equal(app.audio.onSpawn({ id: 3999 }).name, '10 - Level Up!');
    assert.equal(app.audio.onSpawn({ id: 4000 }).name, '10 - Level Up!');
    // Modalità fissa.
    const healed = app.audio.catalog().find((f) => f.name === '18 - Pokémon Healed');
    assert.ok(healed, 'nome mostrato in forma composta (NFC)');
    app.audio.setSettings({ spawnMode: 'fixed', spawnFixed: healed.path });
    assert.equal(app.audio.onSpawn({ id: 4001 }).name, '18 - Pokémon Healed');
  });

  test('un solo evento audio per spawn: nessun suono a una nuova visualizzazione, a un aggiornamento di OBS o a una riconnessione', async () => {
    await manualStart();
    const sp = await spawn(1);
    await waitFor(() => plays().length === 1, { message: 'evento di spawn' });
    const ev = plays()[0];
    assert.equal(ev.id, `spawn-${sp.id}`);
    assert.equal(ev.kind, 'spawn');
    assert.match(ev.url, /^\/audio\/[a-f0-9]{16}\.mp3\?v=\d+$/);
    assert.equal(ev.volume, 70);

    // Lo stesso spawn segnalato di nuovo (es. ridisegno) non produce un secondo evento.
    assert.equal(app.audio.onSpawn(sp), null);
    // Overlay grafico aggiornato (nuova connessione = snapshot con lo spawn attivo).
    const ov = socket(port, '/ws/overlay');
    await ov.open;
    await waitFor(() => ov.msgs.some((m) => m.type === 'snapshot'), { message: 'snapshot overlay' });
    // Sorgente audio ricaricata: riceve solo impostazioni e ora del server.
    const again = socket(port, '/ws/audio');
    await again.open;
    await waitFor(() => again.msgs.some((m) => m.type === 'snapshot'), { message: 'snapshot audio' });
    await settle();
    assert.deepEqual(again.plays(), [], 'nessun evento passato dopo la riconnessione');
    const snap = again.msgs.find((m) => m.type === 'snapshot').data;
    assert.ok(Number.isFinite(snap.serverTime));
    assert.equal(snap.settings.volume, 70);
    assert.equal(plays().length, 1);
    ov.ws.close();
    again.ws.close();
  });

  test('un solo evento per cattura confermata; nessun suono per tentativi falliti o rifiutati (sessione manuale)', async () => {
    await manualStart();
    assert.equal((await manualThrow(null)).rejected, true, 'nessun Pokémon in campo: rifiutato');
    await spawn(1);
    const failed = await manualThrow(0.99);
    assert.equal(failed.caught, false);
    const ok = await manualThrow(0.0);
    assert.equal(ok.caught, true);
    await settle();
    const capture = plays().filter((p) => p.kind === 'capture');
    assert.equal(capture.length, 1, 'una sola musica di cattura');
    const attemptId = app.db.get("SELECT id FROM capture_attempts WHERE outcome = 'caught'").id;
    assert.equal(capture[0].id, `capture-${attemptId}`);
    assert.equal(capture[0].name, '15 - Caught a Pokémon!');
    // Lo stesso risultato rinotificato non riproduce di nuovo.
    assert.equal(app.audio.onAttempt({ caught: true, attemptId }), null);
    assert.equal(plays().filter((p) => p.kind === 'spawn').length, 1);
  });

  test('diretta Twitch: musica alla cattura del riscatto, niente per riscatti duplicati o catture annullate', async () => {
    app.gameSettings.set('capture', { ...app.gameSettings.get('capture'), revokeOnCancel: true });
    await goLive();
    await spawn(1);
    rng.push(0.0);
    const id = `red-${++seq}`;
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id, rewardId: reward.rewardId, userId: MARIO.id, login: MARIO.login, name: MARIO.name }));
    await waitFor(() => plays().some((p) => p.kind === 'capture'), { message: 'musica di cattura' });
    // Riscatto ripetuto da Twitch: nessun nuovo tentativo, nessun nuovo suono.
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id, rewardId: reward.rewardId, userId: MARIO.id, login: MARIO.login, name: MARIO.name }));
    // Riscatto annullato: la cattura viene revocata, nessun suono.
    es.notify('channel.channel_points_custom_reward_redemption.update', { ...redemption({ id, rewardId: reward.rewardId, userId: MARIO.id }), status: 'canceled' });
    await waitFor(() => app.db.get('SELECT outcome FROM capture_attempts WHERE redemption_id = ?', id).outcome === 'rejected', { message: 'cattura revocata' });
    await settle();
    assert.equal(plays().filter((p) => p.kind === 'capture').length, 1);
    // Una cattura già annullata non suona mai (es. evento arrivato in ritardo).
    const a = app.db.get('SELECT id FROM capture_attempts WHERE redemption_id = ?', id);
    app.audio.sent.clear();
    assert.equal(app.audio.onAttempt({ caught: true, attemptId: a.id }), null);
  });

  test('DEMO esclusa salvo configurazione esplicita; interruttori spawn, cattura e audio generale', async () => {
    assert.equal((await client.req('POST', '/api/admin/demo/start', {})).status, 200);
    await spawn(1);
    await settle();
    assert.deepEqual(plays(), [], 'nessun suono in DEMO');
    await cancelSpawn();
    app.audio.setSettings({ includeDemo: true });
    await spawn(2);
    await waitFor(() => plays().length === 1, { message: 'suono in DEMO se attivato' });
    await client.req('POST', '/api/admin/demo/stop', {});

    await manualStart();
    app.audio.setSettings({ includeDemo: false, spawnEnabled: false });
    await spawn(1);
    await manualThrow(0.0);
    await settle();
    assert.deepEqual(plays().map((p) => p.kind), ['spawn', 'capture'], 'spawn disattivato, cattura attiva');
    app.audio.setSettings({ spawnEnabled: true, captureEnabled: false });
    await spawn(2);
    await manualThrow(0.0);
    await settle();
    assert.deepEqual(plays().map((p) => p.kind), ['spawn', 'capture', 'spawn']);
    app.audio.setSettings({ enabled: false, captureEnabled: true });
    await spawn(3);
    await manualThrow(0.0);
    await settle();
    assert.equal(plays().length, 3, 'audio generale disattivato');
  });

  test('OBS scollegato o errore audio: il gioco continua normalmente', async () => {
    audioWs.ws.close();
    await waitFor(() => app.hub.counts().audio === 0, { message: 'nessuna sorgente audio' });
    await manualStart();
    await spawn(1);
    const r = await manualThrow(0.0);
    assert.equal(r.caught, true, 'cattura registrata senza OBS');
    assert.equal(app.audio.stats.sent, 2, 'eventi inviati a nessuno, senza errori');
    // Un errore nel canale audio non blocca spawn e catture.
    app.hub.audio = () => { throw new Error('canale audio rotto'); };
    await spawn(2);
    const r2 = await manualThrow(0.0);
    assert.equal(r2.caught, true);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM user_pokemon').n, 2);
    assert.ok(app.audio.stats.errors >= 2);
    assert.match(app.audio.stats.lastError.message, /canale audio rotto/);
  });

  test('prova dalla dashboard: l\'evento arriva solo alla sorgente audio, mai a dashboard e overlay', async () => {
    const ov = socket(port, '/ws/overlay');
    await ov.open;
    const r = await client.req('POST', '/api/admin/audio/test', { kind: 'capture' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.listeners, 1);
    await waitFor(() => plays().length === 1, { message: 'prova ricevuta' });
    assert.equal(plays()[0].test, true);
    const file = (await client.req('GET', '/api/admin/audio')).data.files.find((f) => f.name === '11 - Route 1');
    assert.equal((await client.req('POST', '/api/admin/audio/test', { kind: 'file', fileId: file.id })).status, 200);
    assert.equal((await client.req('POST', '/api/admin/audio/test', { kind: 'file', fileId: 'nonesiste' })).status, 409);
    assert.equal((await client.req('POST', '/api/admin/audio/test', { kind: 'altro' })).status, 400);
    await settle();
    assert.ok(!ov.msgs.some((m) => m.type === 'play'), 'overlay grafico senza eventi audio');
    ov.ws.close();
    // Nessun codice della dashboard riproduce audio.
    const dir = join(app.config.publicDir, 'assets/js/admin/pages');
    for (const f of readdirSync(dir)) assert.ok(!/new Audio\(|\.play\(\)|AudioContext/.test(readFileSync(join(dir, f), 'utf8')), `${f} non riproduce audio`);
  });

  test('impostazioni salvate nel database e mantenute dopo il riavvio; valori non validi rifiutati', async () => {
    const body = { volume: 35, spawnMode: 'random', spawnFiles: ['Disc 1/10 - Level Up!.mp3'], captureFile: 'Disc 1/11 - Route 1.mp3', maxDurationS: 6, includeDemo: true };
    const r = await client.req('PUT', '/api/admin/audio', body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await client.req('PUT', '/api/admin/audio', { volume: 101 })).status, 400);
    assert.equal((await client.req('PUT', '/api/admin/audio', { captureFile: '../secret.key' })).status, 400);
    assert.equal((await client.req('PUT', '/api/admin/audio', { spawnFiles: ['/etc/passwd'] })).status, 400);
    assert.equal((await client.req('PUT', '/api/admin/audio', { spawnMode: 'fixed', spawnFixed: null })).status, 400);
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'audio_settings'"), 'modifica registrata');
    audioWs.ws.close();
    await app.close();
    ({ app } = await makeApp({ dir: ctx.dir, twitch: tw, eventsub: es, configureTwitch: false, rng }));
    ctx.app = app;
    const s = app.audio.settings();
    assert.deepEqual([s.volume, s.spawnFiles, s.captureFile, s.maxDurationS, s.includeDemo], [35, ['Disc 1/10 - Level Up!.mp3'], 'Disc 1/11 - Route 1.mp3', 6, true]);
    assert.equal(app.audio.resolve().capture.name, '11 - Route 1');
  });

  test('sorgente /overlay/audio e file audio: solo la whitelist, nessun percorso arbitrario', async () => {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/overlay/audio`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-frame-options'), null, 'utilizzabile come Browser Source');
    const html = await page.text();
    assert.match(html, /\/assets\/js\/overlay\/audio\.js/);
    assert.equal((await fetch(`${base}/assets/js/overlay/audio-core.js`)).status, 200);

    // Collegamento simbolico verso un file esterno: escluso dalla whitelist.
    symlinkSync(join(ctx.dir, 'secret.key'), join(app.config.audioDir, 'link.mp3'));
    app.audio.cache = null;
    const files = (await client.req('GET', '/api/admin/audio')).data.files;
    assert.deepEqual(files.map((f) => f.name).sort(), ['06 - Obtained a Key Item!', '10 - Level Up!', '11 - Route 1', '12 - Obtained an Item!', '15 - Caught a Pokémon!', '18 - Pokémon Healed']);
    const f = files.find((x) => x.name === '15 - Caught a Pokémon!');
    const res = await fetch(`${base}/audio/${f.id}.mp3`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ID3-c-Disc 1/15 - Caught a Pokémon!.mp3');
    for (const bad of [`/audio/${f.id}.ogg`, '/audio/0123456789abcdef.mp3', '/audio/../secret.key', '/audio/%2e%2e/secret.key', `/audio/${f.id}`, '/audio/note.txt']) {
      assert.equal((await fetch(base + bad)).status, 404, bad);
    }
    // Le API audio richiedono il login.
    assert.equal((await fetch(`${base}/api/admin/audio`)).status, 401);
  });
});

describe('Lettore audio della Browser Source (deduplicazione e riconnessioni)', () => {
  class FakeAudio {
    static made = [];
    constructor(src) { this.src = src; this.volume = 1; FakeAudio.made.push(this); }
    play() { this.playing = true; return FakeAudio.reject ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) : Promise.resolve(); }
    pause() { this.playing = false; }
  }
  const ev = (id, at, extra = {}) => ({ id, kind: 'spawn', name: 'x', url: '/audio/0123456789abcdef.mp3?v=1', volume: 50, maxDurationS: 0, at, ...extra });

  test('stesso evento ricevuto più volte: una sola riproduzione; eventi vecchi o non validi scartati', async () => {
    FakeAudio.made = [];
    let now = 1_000_000;
    const p = new AudioPlayer({ AudioCtor: FakeAudio, now: () => now, timers: { setTimeout: () => 0 } });
    // L'orologio del PC di OBS è indietro di un'ora: conta l'ora del server.
    const server = now + 3600_000;
    p.snapshot({ settings: { volume: 50 } }, server);
    assert.equal(p.handle(ev('spawn-1', server)), 'played');
    assert.equal(p.handle(ev('spawn-1', server)), 'duplicate');
    assert.equal(FakeAudio.made.length, 1);
    assert.equal(FakeAudio.made[0].volume, 0.5);
    // Evento consegnato in ritardo (riconnessione): non suona.
    now += MAX_AGE_MS + 1000;
    assert.equal(p.handle(ev('capture-9', server)), 'stale');
    // URL fuori dalla whitelist.
    assert.equal(p.handle(ev('spawn-2', server + MAX_AGE_MS + 1000, { url: 'https://esempio.it/x.mp3' })), 'invalid');
    assert.equal(p.handle(ev('spawn-3', server + MAX_AGE_MS + 1000, { url: '/audio/../../secret.key' })), 'invalid');
    assert.equal(FakeAudio.made.length, 1);
    // Dopo una riconnessione lo stesso ID resta già sentito.
    p.snapshot({ settings: {} }, server + MAX_AGE_MS + 1000);
    assert.equal(p.handle(ev('spawn-1', server + MAX_AGE_MS + 1000)), 'duplicate');
    assert.deepEqual([p.stats.played, p.stats.duplicates, p.stats.stale, p.stats.invalid], [1, 2, 1, 2]);
  });

  test('autoplay bloccato o file non caricabile: segnalato nella diagnostica, nessuna eccezione', async () => {
    FakeAudio.made = [];
    FakeAudio.reject = true;
    const p = new AudioPlayer({ AudioCtor: FakeAudio, now: () => 5000, timers: { setTimeout: () => 0 } });
    p.snapshot({}, 5000);
    assert.equal(p.handle(ev('spawn-1', 5000)), 'played');
    await sleep(5);
    assert.equal(p.stats.blocked, 1);
    assert.equal(p.lastError.blocked, true);
    FakeAudio.reject = false;
    p.handle(ev('spawn-2', 5000));
    FakeAudio.made.at(-1).error = { code: 4 };
    FakeAudio.made.at(-1).onerror();
    assert.equal(p.stats.errors, 1);
    assert.match(p.lastError.message, /non caricato/);
    const q = new AudioPlayer({ AudioCtor: null, now: () => 1, timers: { setTimeout: () => 0 } });
    assert.equal(q.handle(ev('spawn-1', 1)), 'error');
  });

  test('durata massima: il suono sfuma e si ferma', () => {
    FakeAudio.made = [];
    const timers = [];
    const p = new AudioPlayer({ AudioCtor: FakeAudio, now: () => 1, timers: { setTimeout: (fn, ms) => timers.push([fn, ms]) } });
    p.handle(ev('spawn-1', 1, { maxDurationS: 4, volume: 100 }));
    assert.equal(timers[0][1], 4000);
    while (timers.length) timers.shift()[0]();
    const a = FakeAudio.made[0];
    assert.equal(a.volume, 0);
    assert.equal(a.playing, false);
    assert.equal(p.playing.size, 0);
  });
});
