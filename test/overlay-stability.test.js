// Stabilizzazione di Overlay Themes:
//  - simulatore bloccato sull'overlay pubblico in LIVE, PAUSED e DEMO, anche
//    chiamando l'API direttamente; anteprima privata sempre disponibile;
//  - elementi simulati tolti al passaggio OFFLINE → LIVE senza toccare quelli reali;
//  - coda animazioni limitata (100+ eventi), cambio tema immediato, contatore
//    dei tentativi conservato, riconnessione durante una transizione;
//  - modifiche concorrenti dello stesso tema (campo rev);
//  - validazione dei dati ricevuti dal simulatore, posizioni nell'API precedente,
//    nomi dei font personalizzati.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID,
} from './helpers.js';
import { startServer, overlaySocket, dbFingerprint } from './overlay-helpers.js';
import { installDom, loadOverlay } from './dom-shim.js';
import { EventQueue } from '../public/assets/js/overlay/event-queue.js';
import { OverlaySimulator, SIM_KINDS } from '../src/overlay/simulator.js';
import { effectiveSettings, defaultConfig, sanitizeConfig, fontStack, PRESETS } from '../public/assets/js/overlay/theme-core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simSent = (o, from = 0) => o.msgs.slice(from).filter((m) => m.data?.sim === true);

// --- Stati del gioco reali (EventSub simulato localmente) ----------------------
describe('Simulatore e stati del gioco (OFFLINE, DEMO, LIVE, PAUSED)', () => {
  let s, tw, es, reward;

  before(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    s = await startServer({ twitch: tw, eventsub: es, configureTwitch: true, rng: seqRng() });
    seedPokemon(s.app.db);
    reward = linkReward(s.app, 'pokeball');
    await s.login();
    await s.app.monitor.start();
    await waitFor(() => s.app.sm.state === 'OFFLINE', { message: 'OFFLINE' });
  });
  after(async () => { await s.app.close(); await es.stop(); cleanup(s.ctx.dir); });

  const sim = (kind, target, extra = {}) => s.req('POST', '/api/admin/overlay/simulate', { kind, ...(target === undefined ? {} : { target }), ...extra });
  const goLive = async (id) => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => s.app.sm.state === 'LIVE', { message: 'LIVE' });
  };
  const goOffline = async () => {
    tw.live = null;
    es.notify('stream.offline', { broadcaster_user_id: BROADCASTER_ID });
    await waitFor(() => s.app.sm.state === 'OFFLINE' && !s.app.engine.mode, { message: 'OFFLINE' });
  };
  // Tutte le varianti con cui si potrebbe provare a raggiungere l'overlay pubblico.
  const assertObsBlocked = async (label) => {
    for (const kind of SIM_KINDS) {
      const r = await sim(kind, 'obs');
      assert.equal(r.status, 409, `${label}: ${kind} su OBS deve essere rifiutato`);
      assert.match(r.data.error, /Overlay pubblico in uso/);
    }
    for (const target of ['OBS', ' obs', ['obs'], { obs: true }, 1, null, true]) assert.equal((await sim('spawn', target)).status, 400, `${label}: target ${JSON.stringify(target)}`);
    assert.throws(() => s.app.simulator.sendToObs('spawn'), /Overlay pubblico in uso/, `${label}: anche chiamando direttamente il simulatore`);
    // Senza target → anteprima privata (mai l'overlay pubblico).
    const r = await sim('sequence');
    assert.equal(r.status, 200);
    assert.equal(r.data.target, 'preview');
    assert.equal((await s.req('GET', '/api/admin/overlay/themes')).data.obs.busy !== null, true);
  };

  test('1. OFFLINE: la simulazione raggiunge l\'overlay pubblico ed è registrata nel log', async () => {
    const o = overlaySocket(s.port);
    await o.open;
    const logged = [];
    const orig = s.app.simulator.log.info.bind(s.app.simulator.log);
    s.app.simulator.log.info = (m, ...a) => { logged.push(m); return orig(m, ...a); };
    try {
      assert.equal((await s.req('GET', '/api/admin/overlay/themes')).data.obs.busy, null);
      const r = await sim('spawn', 'obs');
      assert.equal(r.status, 200);
      assert.equal(r.data.target, 'obs');
      await waitFor(() => o.msgs.some((m) => m.type === 'spawn' && m.data.sim), { message: 'spawn simulato su OBS' });
      assert.ok(logged.some((m) => /Simulazione inviata all'overlay pubblico: spawn/.test(m)), 'invio registrato nel log');
      assert.equal((await sim('clear', 'obs')).status, 200);
    } finally {
      s.app.simulator.log.info = orig;
      o.ws.close();
    }
  });

  test('2. DEMO: overlay pubblico bloccato, anteprima privata disponibile, nessun evento simulato inviato', async () => {
    const o = overlaySocket(s.port);
    await o.open;
    await sleep(50);
    s.app.engine.startDemo();
    try {
      const from = o.msgs.length;
      await assertObsBlocked('DEMO');
      await sleep(50);
      assert.deepEqual(simSent(o, from), [], 'nessun evento simulato durante la DEMO');
    } finally {
      s.app.engine.stopDemo();
      o.ws.close();
    }
  });

  test('3. LIVE: overlay pubblico bloccato anche via API diretta; riscatti reali invariati', async () => {
    const o = overlaySocket(s.port);
    await o.open;
    await goLive('b-live');
    try {
      const from = o.msgs.length;
      await assertObsBlocked('LIVE');
      // Un riscatto reale funziona come prima: lancio registrato, nessuna traccia di simulazione.
      s.app.engine.tick();
      es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id: 'red-live-1', rewardId: reward.rewardId }));
      await waitFor(() => s.app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE redemption_id = 'red-live-1'").n === 1, { message: 'lancio reale' });
      await waitFor(() => o.msgs.slice(from).some((m) => m.type === 'throw'), { message: 'lancio reale inviato all\'overlay' });
      assert.deepEqual(simSent(o, from), [], 'nessun evento simulato in diretta');
    } finally {
      o.ws.close();
    }
  });

  test('4. PAUSED (Twitch irraggiungibile): overlay pubblico bloccato; ripresa LIVE regolare', async () => {
    assert.equal(s.app.sm.state, 'LIVE');
    es.refuse = true;
    es.dropAll();
    await waitFor(() => s.app.sm.state === 'PAUSED', { message: 'PAUSED' });
    try {
      assert.equal(s.app.engine.running, false);
      assert.match(s.app.simulator.publicOverlayBusy(), /PAUSED/);
      await assertObsBlocked('PAUSED');
    } finally {
      es.refuse = false;
    }
    await waitFor(() => s.app.sm.state === 'LIVE', { timeout: 8000, message: 'ripresa LIVE' });
    await goOffline();
  });

  test('5. OFFLINE → LIVE con elementi simulati sull\'overlay: rimossi subito (sim_clear), dati reali intatti', async () => {
    const fp = dbFingerprint(s.app.db);
    const o = overlaySocket(s.port);
    await o.open;
    assert.equal((await sim('spawn', 'obs')).status, 200);
    assert.equal((await sim('fail', 'obs')).status, 200);
    await waitFor(() => o.msgs.some((m) => m.type === 'throw' && m.data.sim), { message: 'simulazione su OBS' });
    assert.equal(s.app.simulator.obsDirty, true);
    assert.deepEqual(dbFingerprint(s.app.db), fp, 'la simulazione non scrive nel database');

    const from = o.msgs.length;
    await goLive('b-after-sim');
    await waitFor(() => o.msgs.slice(from).some((m) => m.type === 'sim_clear'), { message: 'sim_clear' });
    const after = o.msgs.slice(from);
    const iClear = after.findIndex((m) => m.type === 'sim_clear');
    const iActive = after.findIndex((m) => m.type === 'state' && m.data.active);
    assert.ok(iClear >= 0 && iActive >= 0 && iClear < iActive, 'pulizia prima dell\'attivazione della diretta');
    assert.equal(s.app.simulator.obsDirty, false);
    assert.equal(s.app.simulator.obsSpawn, null);
    // Lo spawn reale successivo non è simulato e ha un id reale (positivo).
    const real = s.app.engine.tick();
    assert.ok(real && real.id > 0);
    await waitFor(() => o.msgs.slice(from).some((m) => m.type === 'spawn' && !m.data.sim), { message: 'spawn reale' });
    // Un secondo evento di stato non ripete la pulizia (niente da togliere).
    const clears = o.msgs.filter((m) => m.type === 'sim_clear').length;
    s.app.engine.emitStatus();
    await sleep(50);
    assert.equal(o.msgs.filter((m) => m.type === 'sim_clear').length, clears);
    o.ws.close();
    await goOffline();
  });

  test('10. WebSocket scollegato durante OFFLINE → LIVE: alla riconnessione lo snapshot è solo reale', async () => {
    assert.equal((await sim('spawn', 'obs')).status, 200);
    const o1 = overlaySocket(s.port);
    await o1.open;
    o1.ws.terminate(); // overlay scollegato proprio durante la transizione
    await goLive('b-reconnect');
    s.app.engine.tick();
    const o2 = overlaySocket(s.port);
    await o2.open;
    await waitFor(() => o2.msgs.some((m) => m.type === 'snapshot'), { message: 'snapshot' });
    const snap = o2.msgs.find((m) => m.type === 'snapshot').data;
    assert.equal(snap.active, true);
    assert.ok(snap.spawn && snap.spawn.id > 0 && !snap.spawn.sim, 'lo snapshot contiene solo lo spawn reale');
    assert.deepEqual(simSent(o2), []);
    o2.ws.close();
    await goOffline();
  });

  test('simulazione in corso (con ritardi) interrotta se il gioco parte prima della fine', async () => {
    const sent = [];
    const hub = { overlay: (type, data) => sent.push({ type, data }), counts: () => ({ overlay: 1 }) };
    const sm = { state: 'OFFLINE' };
    const engine = { mode: null };
    const simu = new OverlaySimulator({ db: s.app.db, hub, engine, sm, timers: true });
    simu.sendToObs('sequence');
    assert.ok(simu.pending.length > 0, 'eventi programmati');
    sm.state = 'LIVE';
    assert.equal(simu.purge('stato LIVE'), true);
    assert.equal(simu.pending.length, 0);
    assert.equal(sent.at(-1).type, 'sim_clear');
    const n = sent.length;
    await sleep(2000);
    assert.equal(sent.length, n, 'nessun evento simulato dopo l\'avvio del gioco');
    // Anche senza purge esplicita: l'invio programmato controlla lo stato.
    sm.state = 'OFFLINE';
    simu.sendToObs('catch');
    const m = sent.length;
    engine.mode = 'demo';
    await sleep(1200);
    assert.ok(sent.slice(m).every((e) => e.type === 'sim_clear' || e.type === 'spawn' || e.data?.sim), 'solo eventi simulati già partiti');
    assert.ok(sent.slice(m).some((e) => e.type === 'sim_clear'));
    simu.stop();
  });

  test('Pokédex, catture, statistiche, classifiche e ricompense invariati dopo tutte le simulazioni', async () => {
    const fp = dbFingerprint(s.app.db);
    const stats = (await s.req('GET', '/api/admin/stats')).data;
    const overview = (await s.req('GET', '/api/admin/overview')).data.allTime;
    let spawn = null;
    for (const kind of SIM_KINDS) {
      const r = await sim(kind, 'preview', { spawn });
      spawn = r.data.spawn;
      assert.equal((await sim(kind, 'obs')).status, 200);
    }
    assert.deepEqual(dbFingerprint(s.app.db), fp);
    for (const t of ['pokemon', 'user_pokemon', 'capture_attempts', 'spawn_history', 'twitch_rewards', 'stream_sessions']) assert.ok(t in fp, `tabella ${t} controllata`);
    assert.deepEqual((await s.req('GET', '/api/admin/stats')).data, stats);
    assert.deepEqual((await s.req('GET', '/api/admin/overview')).data.allTime, overview);
  });
});

// --- Validazione rigorosa dei dati del simulatore (P8) -------------------------
describe('Simulatore: validazione dei dati ricevuti', () => {
  let s;
  before(async () => { s = await startServer(); seedPokemon(s.app.db); await s.login(); });
  after(async () => { await s.app.close(); cleanup(s.ctx.dir); });

  test('spawn non valido dal browser → scartato (nuovo spawn), mai rispedito tale e quale', async () => {
    const good = (await s.req('POST', '/api/admin/overlay/simulate', { kind: 'spawn' })).data.spawn;
    const bad = [
      { ...good, attempts: '5' }, { ...good, id: 5 }, { ...good, name: '<img src=x onerror=alert(1)>'.repeat(10) },
      { ...good, image: 'javascript:alert(1)' }, { ...good, image: 'https://evil.example/x.png' }, { ...good, rarity: 'divino' },
      { ...good, types: ['fire', { x: 1 }] }, { ...good, expiresAt: 'domani' }, { ...good, shiny: 'sì' }, 'stringa', [1, 2],
      { ...good, attempts: 1e9 }, { ...good, name: 'a\u0000b' },
    ];
    for (const spawn of bad) {
      const r = await s.req('POST', '/api/admin/overlay/simulate', { kind: 'fail', spawn });
      assert.equal(r.status, 200);
      const sp = r.data.events.find((e) => e.type === 'spawn');
      assert.ok(sp, `spawn non valido ${JSON.stringify(spawn).slice(0, 60)} → deve ripartire da uno spawn nuovo`);
      assert.notEqual(sp.data.id, good.id);
      const th = r.data.events.find((e) => e.type === 'throw').data;
      assert.equal(typeof th.attempts, 'number');
    }
    // Spawn valido → riusato.
    const ok = await s.req('POST', '/api/admin/overlay/simulate', { kind: 'fail', spawn: good });
    assert.equal(ok.data.events.some((e) => e.type === 'spawn'), false);
    assert.equal(ok.data.events[0].data.attempts, 1);
  });

  test('parametri non validi → 400', async () => {
    const r = (b) => s.req('POST', '/api/admin/overlay/simulate', b);
    assert.equal((await r({ kind: ['spawn'] })).status, 400);
    assert.equal((await r({ kind: 'notify', text: { a: 1 } })).status, 400);
    assert.equal((await r({ kind: 'spawn', durationS: 'abc' })).status, 400);
    assert.equal((await r({ kind: 'spawn', target: 'tutti' })).status, 400);
    const long = await r({ kind: 'notify', text: `ciao\u0007${'x'.repeat(500)}` });
    assert.equal(long.status, 200);
    assert.ok(long.data.events[0].data.text.length <= 140);
    assert.ok(!/[\u0000-\u001f]/.test(long.data.events[0].data.text));
  });
});

// --- Modifiche concorrenti (P9), API precedente (P6), font (P7) ---------------
describe('Temi: modifiche concorrenti, API precedente e font personalizzati', () => {
  let s;
  before(async () => { s = await startServer(); await s.login(); });
  after(async () => { await s.app.close(); cleanup(s.ctx.dir); });
  const get = async (slug) => (await s.req('GET', '/api/admin/overlay/themes')).data.themes.find((t) => t.slug === slug);

  test('9. più modifiche contemporanee dello stesso tema: una sola vince, le altre ricevono 409 con la versione attuale', async () => {
    const t = await get('neon-hud');
    const puts = Array.from({ length: 8 }, (_, i) => {
      const cfg = structuredClone(t.config);
      cfg.colors.primary = `#0000${String(10 + i).padStart(2, '0')}`;
      return s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg, rev: t.rev });
    });
    const res = await Promise.all(puts);
    const ok = res.filter((r) => r.status === 200);
    const conflict = res.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, 'esattamente una modifica accettata');
    assert.equal(conflict.length, 7);
    const now = await get('neon-hud');
    assert.equal(now.rev, t.rev + 1);
    assert.equal(now.config.colors.primary, ok[0].data.theme.config.colors.primary, 'nessuna sovrascrittura silenziosa');
    for (const c of conflict) { assert.equal(c.data.details.current.rev, now.rev); assert.match(c.data.error, /modificato altrove/); }

    // Revisione mancante → 400; revisione vecchia → 409; sovrascrittura esplicita → 200.
    const cfg = structuredClone(now.config);
    cfg.colors.primary = '#123123';
    assert.equal((await s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg })).status, 400);
    assert.equal((await s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg, rev: t.rev })).status, 409);
    assert.equal((await s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg, rev: 'x' })).status, 400);
    const forced = await s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg, force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.data.theme.config.colors.primary, '#123123');
    // Il controllo è anche nello store (stessa istruzione SQL).
    assert.throws(() => s.app.themes.update(t.id, { config: cfg, rev: t.rev }), (e) => e.status === 409 && e.current?.rev === forced.data.theme.rev);
    await s.req('POST', `/api/admin/overlay/themes/${t.id}/reset`);
  });

  test('P6: l\'API precedente accetta tutte le 9 posizioni (anche con il tema attivo al centro a sinistra)', async () => {
    const t = await get('classic');
    const cfg = structuredClone(t.config);
    cfg.layout.position = 'center-left';
    assert.equal((await s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg, rev: t.rev })).status, 200);
    // Modifica di un altro campo con il vecchio formato: prima falliva con "Posizione non valido".
    const p = await s.req('PUT', '/api/admin/overlay', { colors: { primary: '#224466' } });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    for (const position of ['center-left', 'center-right', 'top-center', 'bottom-left']) {
      const r = await s.req('PUT', '/api/admin/overlay', { layout: { position } });
      assert.equal(r.status, 200, position);
      assert.equal(s.app.themes.active().config.layout.position, position);
    }
    assert.equal((await s.req('PUT', '/api/admin/overlay', { layout: { position: 'ovunque' } })).status, 400);
    await s.req('POST', `/api/admin/overlay/themes/${t.id}/reset`);
  });

  test('P7: nomi di font personalizzati sicuri; il CSS generato resta valido', () => {
    const base = defaultConfig('classic');
    for (const ok of ['Montserrat', 'Bebas Neue', 'Open Sans 2', 'Noto Sans JP', 'Señor Font', 'Font-Name.v2']) {
      const { config } = sanitizeConfig({ typography: { font: 'custom', customFont: ok } }, base);
      assert.equal(config.typography.customFont, ok, ok);
      assert.equal(fontStack(config.typography).startsWith(`"${ok}", `), true);
    }
    for (const bad of ["O'Neil", 'a"b', 'x; color:red', 'x}', 'a,b', 'url(x)', '\\61', ' ', '-'.repeat(3), 'x'.repeat(61)]) {
      const { config, warnings } = sanitizeConfig({ typography: { font: 'custom', customFont: bad } }, base);
      assert.notEqual(config.typography.customFont, bad, bad);
      assert.ok(warnings.length > 0, bad);
    }
    // fontStack non si fida del valore: anche un nome non validato non esce dalle virgolette.
    const css = fontStack({ font: 'custom', customFont: "x'); } * { display:none" });
    assert.ok(!/['();{}]/.test(css.split(',')[0]), css);
  });

  test('P5: contrasto del testo sul pannello ≥ 4,5:1 anche sopra uno sfondo bianco, per ogni preset', () => {
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const parse = (c) => {
      if (c.startsWith('#')) { const hx = c.slice(1); const f = hx.length <= 4 ? hx.split('').map((x) => x + x).join('') : hx; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).concat(f.length === 8 ? parseInt(f.slice(6, 8), 16) / 255 : 1); }
      const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1];
    };
    for (const p of PRESETS) {
      const [r, g, b, a] = parse(p.config.colors.panel);
      for (const bg of [[255, 255, 255], [0, 0, 0]]) {
        const back = [r, g, b].map((c, i) => c * a + bg[i] * (1 - a));
        for (const k of ['text', 'muted']) assert.ok(ratio(parse(p.config.colors[k]), back) >= 4.5, `${p.slug}: ${k} su sfondo ${bg[0]} = ${ratio(parse(p.config.colors[k]), back).toFixed(2)}`);
      }
    }
    // Dimensioni minime delle scritte piccole e delle notifiche in tutti i fogli di stile.
    const css = ['overlay.css', ...PRESETS.map((p) => `themes/${p.base}.css`)].map((f) => readFileSync(`public/assets/css/${f}`, 'utf8')).join('\n');
    for (const line of css.split('\n').filter((l) => /\.(note|head|dex|badge|foot)\b[^{]*\{[^}]*font-size:\s*[\d.]+em/.test(l))) {
      assert.match(line, /font-size: max\(var\(--min-(note|small)\)/, `dimensione minima mancante: ${line.slice(0, 80)}`);
    }
    assert.match(css, /--min-note: 18px; --min-small: 14px;/);
  });
});

// --- Coda degli eventi animati (P3) ----------------------------------------------
describe('Coda animazioni (EventQueue)', () => {
  test('6. 150 eventi consecutivi: nessun accumulo, ordine conservato, nessun evento perso', async () => {
    const q = new EventQueue({ limit: 6 });
    const done = [];
    const t0 = Date.now();
    for (let i = 0; i < 150; i++) q.push(async ({ wait }) => { await wait(1000); done.push(i); }, { important: i % 10 === 0 });
    await q.whenIdle();
    const ms = Date.now() - t0;
    assert.equal(done.length, 150, 'nessun evento scartato');
    assert.deepEqual(done, [...Array(150).keys()], 'ordine conservato');
    // Alla velocità normale servirebbero 150 s: con la coda piena le attese vengono saltate.
    assert.ok(ms < 8000, `smaltita in ${ms} ms`);
    assert.ok(q.stats.instant > 100 && q.stats.fast > 0, JSON.stringify(q.stats));
    assert.equal(q.size, 0);
  });

  test('animazione bloccata o in errore: la coda prosegue (tempo massimo per evento)', async () => {
    const q = new EventQueue({ limit: 6, jobTimeoutMs: 80 });
    const done = [];
    q.push(() => new Promise(() => {})); // mai risolta
    q.push(() => { throw new Error('boom'); });
    q.push(() => { done.push('ok'); });
    await q.whenIdle();
    assert.deepEqual(done, ['ok']);
    assert.equal(q.stats.timeouts, 1);
    assert.equal(q.stats.errors, 1);
  });

  test('timer chiamati come funzioni libere (nel browser un setTimeout invocato come metodo dà "Illegal invocation")', async () => {
    // Come i timer del browser: rifiutano un "this" diverso dal contesto globale.
    function strictSet(fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return setTimeout(fn, ms); }
    function strictClear(t) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return clearTimeout(t); }
    const q = new EventQueue({ setTimer: strictSet, clearTimer: strictClear });
    const done = [];
    for (let i = 0; i < 3; i++) q.push(async ({ wait }) => { await wait(5); done.push(i); });
    await q.whenIdle();
    assert.deepEqual(done, [0, 1, 2]);
    assert.equal(q.stats.errors, 0);
    assert.equal(q.stats.processed, 3);
  });

  test('modalità in base all\'arretrato e rimozione selettiva', () => {
    const q = new EventQueue({ limit: 8 });
    assert.equal(q.modeFor(0), 'normal');
    assert.equal(q.modeFor(4), 'fast');
    assert.equal(q.modeFor(8), 'instant');
    q.setLimit('abc');
    assert.equal(q.limit, 6);
    q.running = true; // blocca l'esecuzione per ispezionare la coda
    q.push(() => {}, { sim: true }); q.push(() => {}, { sim: false }); q.push(() => {}, { sim: true });
    assert.equal(q.clear((j) => j.sim), 2);
    assert.equal(q.size, 1);
  });
});

// --- Overlay reale (overlay.js) in un DOM minimo ------------------------------
describe('Overlay: coda, cambio tema, tentativi e pulizia delle simulazioni', () => {
  let env, state;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const spawn = (id, extra = {}) => ({ id, pokemonId: 1, dex: 25, name: `Mon${id}`, types: ['electric'], rarity: 'rare', shiny: false, image: '/assets/img/unknown.svg', startedAt: iso(0), expiresAt: iso(90000), attempts: 0, ...extra });
  const ball = { name: 'Poké Ball', color: '#e3350d' };
  const throwEv = (spawnId, attempts, extra = {}) => ({ spawnId, user: 'mario', ball, caught: false, fled: false, pokemon: { name: 'Mon', dex: 25, shiny: false, rarity: 'rare' }, attempts, ...extra });
  const settings = (base, patch = {}) => {
    const c = defaultConfig(base);
    c.notifications.durationMs = 1000;
    c.animation.speed = 4; // test più rapidi; i test sulla coda piena usano animazioni lente
    Object.assign(c.animation, patch.animation || {});
    return effectiveSettings({ base, name: base, config: c, rev: patch.rev ?? 1 });
  };

  beforeEach(async () => {
    env = installDom({ settings: settings('classic') });
    state = await loadOverlay(env);
  });
  afterEach(async () => { env.post('reset'); await sleep(5); });

  test('P4: il contatore dei tentativi resta dopo il cambio tema', async () => {
    env.post('spawn', spawn(7));
    for (let i = 1; i <= 3; i++) env.post('throw', throwEv(7, i));
    await waitFor(() => state().attempts === 3 && !state().queue.busy, { timeout: 8000, message: 'tre tentativi' });
    env.post('settings', settings('neon-hud'));
    await sleep(20);
    assert.equal(state().base, 'neon-hud');
    assert.equal(state().attempts, 3);
    assert.match(env.spawnEl().querySelector('.att').textContent, /3 tentativi/);
  });

  test('7. cambio tema con la coda piena: applicato subito, la coda resta intatta', async () => {
    env.post('settings', settings('classic', { animation: { speed: 0.25 } })); // animazioni lente
    env.post('spawn', spawn(9));
    await sleep(10);
    for (let i = 1; i <= 40; i++) env.post('throw', throwEv(9, i));
    assert.ok(state().queue.size > 20, `coda piena (${state().queue.size})`);
    // Nessuna attesa: il tema cambia mentre la coda è ancora piena.
    env.post('settings', settings('cyber-pulse'));
    assert.equal(state().base, 'cyber-pulse', 'tema applicato senza attendere la coda');
    assert.ok(state().queue.size > 20, 'la coda non viene svuotata dal cambio tema');
    assert.ok(env.doc.body.classList.contains('t-cyber-pulse'));
    await waitFor(() => !state().queue.busy, { timeout: 15000, message: 'coda smaltita' });
    assert.equal(state().attempts, 40, 'nessun lancio perso');
    assert.ok(state().queue.instant > 0);
  });

  test('8. cambio tema durante l\'animazione di una cattura reale: tema subito, cattura completata', async () => {
    env.post('spawn', spawn(11));
    env.post('throw', throwEv(11, 1, { caught: true }));
    env.post('despawn', { id: 11, reason: 'caught' });
    await sleep(100); // animazione della ball in corso
    assert.equal(state().queue.busy, true);
    env.post('settings', settings('holographic'));
    await sleep(5);
    assert.equal(state().base, 'holographic');
    await waitFor(() => !state().queue.busy, { timeout: 8000, message: 'cattura completata' });
    assert.equal(state().spawn, null, 'spawn catturato tolto');
    assert.ok(env.notesEl().querySelectorAll('.note').some((n) => /ha catturato/.test(n.textContent)), 'notifica della cattura mostrata');
  });

  test('5 (overlay). sim_clear / diretta avviata: via solo gli elementi simulati, quelli reali restano', async () => {
    env.post('spawn', spawn(-3, { sim: true }));
    env.post('notice', { text: 'Notifica simulata', kind: 'info', sim: true });
    await waitFor(() => state().spawn === -3, { message: 'spawn simulato' });
    env.post('notice', { text: 'Messaggio reale', kind: 'info' });
    for (let i = 1; i <= 5; i++) env.post('throw', throwEv(-3, i, { sim: true }));
    env.post('sim_clear', { reason: 'stato LIVE' });
    await sleep(5);
    assert.equal(state().spawn, null, 'spawn simulato tolto');
    assert.equal(state().queue.size, 0, 'lanci simulati in coda scartati');
    const notes = env.notesEl().querySelectorAll('.note').map((n) => n.textContent);
    assert.deepEqual(notes, ['Messaggio reale'], 'resta solo la notifica reale');

    // Spawn reale visibile + evento simulato arrivato in ritardo: la pulizia tocca solo il simulato.
    env.post('spawn', spawn(42));
    env.post('throw', throwEv(42, 1));
    await waitFor(() => state().spawn === 42, { message: 'spawn reale' });
    env.post('notice', { text: 'altra sim', sim: true });
    env.post('state', { active: true });
    await sleep(5);
    assert.equal(state().spawn, 42, 'lo spawn reale resta');
    await waitFor(() => !state().queue.busy, { timeout: 8000, message: 'lancio reale completato' });
    assert.equal(state().attempts, 1);
    assert.ok(!env.notesEl().querySelectorAll('.note').some((n) => /altra sim/.test(n.textContent)));
    // Fine diretta / pausa: tutto azzerato.
    env.post('state', { active: false, paused: true });
    await sleep(5);
    assert.equal(state().spawn, null);
    assert.equal(state().notes, 0);
  });

  test('"clear" simulato non cancella gli elementi reali; "clear" reale sì', async () => {
    env.post('spawn', spawn(50));
    await waitFor(() => state().spawn === 50, { message: 'spawn' });
    env.post('clear', { sim: true });
    await sleep(5);
    assert.equal(state().spawn, 50);
    env.post('clear', {});
    await sleep(5);
    assert.equal(state().spawn, null);
  });

  test('notifiche: con la coda piena restano le catture reali', async () => {
    const s = settings('classic');
    s.theme.config.notifications.maxQueue = 3;
    s.theme.config.notifications.maxVisible = 1;
    env.post('settings', s);
    const shown = [];
    const notes = env.notesEl();
    const append = notes.appendChild.bind(notes);
    notes.appendChild = (n) => { shown.push(n.textContent); return append(n); };
    env.post('spawn', spawn(60));
    for (let i = 1; i <= 12; i++) env.post('throw', throwEv(60, i, { caught: i === 2 }));
    await waitFor(() => !state().queue.busy, { timeout: 10000, message: 'coda' });
    assert.ok(state().pendingNotes <= 3, 'coda delle notifiche limitata');
    await waitFor(() => state().pendingNotes === 0, { timeout: 10000, message: 'notifiche smaltite' });
    assert.ok(shown.some((t) => /ha catturato/.test(t)), `la cattura reale non viene scartata (${shown.length} mostrate)`);
    assert.ok(shown.length < 26, 'le notifiche meno importanti in eccesso vengono scartate');
  });

  test('cambi di tema rapidi: vince l\'ultimo anche se il foglio di stile precedente arriva dopo', async () => {
    env.doc.cssDelayMs = 30;
    env.post('settings', settings('neon-hud'));
    env.post('settings', settings('minimal-light'));
    await sleep(80);
    assert.equal(state().base, 'minimal-light');
    const links = env.doc.head.querySelectorAll('link').map((l) => l.dataset.theme);
    assert.deepEqual(links, ['minimal-light']);
  });
});
