// Messaggi automatici in chat ("Messaggi Twitch"): spawn, cattura confermata,
// sessioni. Gli eventi passano dal vero motore (EventSub simulato per le dirette,
// API della dashboard per le sessioni manuali); i messaggi escono dal ChatSender
// esistente verso il finto Twitch, con l'account del bot.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeApp, cleanup, seedPokemon, linkReward, FakeTwitch, FakeEventSub, waitFor, redemption, seqRng, BROADCASTER_ID, adminClient, tempDir, legacyDatabase,
} from './helpers.js';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA } from '../src/database/migrations.js';
import { renderTemplate, cleanValue, CHAT_EVENTS } from '../src/chat_messages/messages.js';
import { CHAT_MESSAGE_DEFAULTS } from '../src/configuration/defaults.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARIO = { id: '2001', login: 'mario', name: 'Mario' };
const BOT_ID = '5000';
const linkBot = (app, extra = {}) => app.credentials.setToken('bot', {
  accessToken: 'botaccess', refreshToken: 'botrefresh', expiresAt: Date.now() + 3600e3, scopes: ['user:write:chat'], userId: BOT_ID, login: 'mio_bot', displayName: 'MioBot', ...extra,
});

describe('Messaggi automatici in chat', () => {
  let ctx, app, tw, es, rng, client, reward, seq;

  beforeEach(async () => {
    tw = new FakeTwitch();
    es = await new FakeEventSub().start();
    rng = seqRng();
    ctx = await makeApp({ twitch: tw, eventsub: es, rng });
    app = ctx.app;
    seedPokemon(app.db);
    reward = linkReward(app, 'pokeball');
    linkBot(app);
    app.chatMessages.captureDelayMs = 0;
    await app.monitor.start();
    await waitFor(() => app.sm.state === 'OFFLINE' && app.monitor.eventsub?.connected, { message: 'EventSub collegato' });
    client = await adminClient(app);
    seq = 0;
  });

  afterEach(async () => {
    await app.close();
    await es.stop();
    cleanup(ctx.dir);
  });

  const enable = (extra = {}) => app.chatMessages.setSettings({ enabled: true, ...extra });
  const sent = () => tw.chat.map((c) => c.message);
  const goLive = async (id = 'b-live') => {
    tw.live = { id };
    es.notify('stream.online', { id, broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
    await waitFor(() => app.sm.state === 'LIVE', { message: 'stato LIVE' });
  };
  const spawn = async (pokemonId = 1, shiny = false) => {
    const r = await client.req('POST', '/api/admin/spawn/manual', { pokemonId, shiny });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const cancelSpawn = () => client.req('POST', '/api/admin/spawn/cancel', {});
  const manualStart = async () => assert.equal((await client.req('POST', '/api/admin/game/manual/start', {})).status, 200);
  const manualStop = async () => assert.equal((await client.req('POST', '/api/admin/game/manual/stop', {})).status, 200);
  const manualThrow = async (roll, name = 'Ash') => {
    if (roll != null) rng.push(roll);
    const r = await client.req('POST', '/api/admin/game/manual/throw', { ballTypeId: reward.ball.id, name });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const redeem = (user = MARIO) => {
    const id = `red-${++seq}`;
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id, rewardId: reward.rewardId, userId: user.id, login: user.login, name: user.name }));
    return id;
  };
  const settle = () => sleep(80);

  test('disattivati per impostazione predefinita: un aggiornamento non cambia il comportamento', async () => {
    assert.equal(app.chatMessages.settings().enabled, false);
    await manualStart();
    await spawn(1);
    await manualThrow(0.0);
    await settle();
    assert.deepEqual(tw.chat, [], 'nessun messaggio senza attivazione esplicita');
  });

  test('messaggio di spawn e di cattura riuscita, con il bot e le variabili sostituite', async () => {
    enable();
    await manualStart();
    await spawn(3); // Testmon C, rara
    await waitFor(() => tw.chat.length === 1, { message: 'messaggio di spawn' });
    assert.equal(sent()[0], '🚨 ATTENZIONE CHAT! Un Testmon C selvatico è apparso! Rarità: Raro!');
    assert.equal(tw.chat[0].sender_id, BOT_ID, 'inviato dal bot');
    assert.equal(tw.chat[0].broadcaster_id, BROADCASTER_ID);
    await manualThrow(0.0);
    await waitFor(() => tw.chat.length === 2, { message: 'messaggio di cattura' });
    assert.equal(sent()[1], '🎉 Ash ha catturato Testmon C! Rarità: Raro');
    assert.ok(tw.chat.every((c) => c.sender_id === BOT_ID), 'mai con il token del canale');
    await settle();
    assert.equal(tw.chat.length, 2, 'esattamente un messaggio per evento');
  });

  test('diretta Twitch: nome dall\'identità Twitch; nessun messaggio per falliti, rifiutati, duplicati o annullati', async () => {
    app.gameSettings.set('capture', { ...app.gameSettings.get('capture'), revokeOnCancel: true });
    enable({ events: { spawn: { enabled: false } } });
    await goLive();
    await spawn(1);
    // Tentativo fallito.
    rng.push(0.99);
    redeem();
    await waitFor(() => app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE outcome = 'failed'").n === 1, { message: 'tentativo fallito' });
    await settle();
    assert.deepEqual(sent().filter((m) => m.includes('catturato')), [], 'nessun messaggio per un tentativo fallito');

    // Cattura riuscita (nome con caratteri di controllo: ripulito).
    rng.push(0.0);
    const id = redeem({ id: '2002', login: 'luigi', name: 'Lui\u0007gi\nBros' });
    await waitFor(() => sent().some((m) => m.includes('catturato')), { message: 'messaggio di cattura' });
    assert.deepEqual(sent().filter((m) => m.includes('catturato')), ['🎉 Lui gi Bros ha catturato Testmon A! Rarità: Comune']);
    // Riscatto ripetuto da Twitch: nessun nuovo messaggio.
    es.notify('channel.channel_points_custom_reward_redemption.add', redemption({ id, rewardId: reward.rewardId, userId: '2002', login: 'luigi', name: 'Luigi' }));
    // Nessun Pokémon in campo: riscatto rifiutato (risponde solo il comando di cortesia esistente).
    redeem();
    await waitFor(() => app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE outcome = 'rejected'").n === 1, { message: 'rifiutato' });
    await settle();
    assert.equal(sent().filter((m) => m.includes('catturato')).length, 1);
    // Cattura annullata in seguito: nessun messaggio, nemmeno se l'evento arriva di nuovo.
    es.notify('channel.channel_points_custom_reward_redemption.update', { ...redemption({ id, rewardId: reward.rewardId, userId: '2002' }), status: 'canceled' });
    await waitFor(() => app.db.get('SELECT outcome FROM capture_attempts WHERE redemption_id = ?', id).outcome === 'rejected', { message: 'cattura revocata' });
    const a = app.db.get('SELECT id FROM capture_attempts WHERE redemption_id = ?', id);
    app.chatMessages.seen.clear();
    assert.equal(app.chatMessages.onAttempt({ caught: true, attemptId: a.id }), null);
    await settle();
    assert.equal(sent().filter((m) => m.includes('catturato')).length, 1);
  });

  test('riscatto annullato subito dopo la cattura: il messaggio non parte', async () => {
    app.gameSettings.set('capture', { ...app.gameSettings.get('capture'), revokeOnCancel: true });
    app.chatMessages.captureDelayMs = 150;
    enable({ events: { spawn: { enabled: false } } });
    await goLive();
    await spawn(1);
    rng.push(0.0);
    const id = redeem();
    await waitFor(() => app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE outcome = 'caught'").n === 1, { message: 'cattura' });
    es.notify('channel.channel_points_custom_reward_redemption.update', { ...redemption({ id, rewardId: reward.rewardId, userId: MARIO.id }), status: 'canceled' });
    await waitFor(() => app.db.get('SELECT outcome FROM capture_attempts WHERE redemption_id = ?', id).outcome === 'rejected', { message: 'revocata' });
    await sleep(300);
    assert.deepEqual(sent().filter((m) => m.includes('catturato')), []);
    assert.ok(app.chatMessages.recent.some((r) => r.event === 'capture' && /annullata/.test(r.reason)));
  });

  test('DEMO: nessun messaggio nella chat reale', async () => {
    enable();
    assert.equal((await client.req('POST', '/api/admin/demo/start', {})).status, 200);
    await spawn(1);
    await settle();
    assert.deepEqual(tw.chat, []);
  });

  test('sostituzione delle variabili: solo nomi conosciuti, testo semplice su una riga', () => {
    const vars = { pokemon: 'Pikachu', user: 'Ash', rarity: 'Raro' };
    assert.equal(renderTemplate('{user} ha preso {pokemon} ({rarity}) {sconosciuta}', vars), 'Ash ha preso Pikachu (Raro) {sconosciuta}');
    // Nessuna sostituzione ricorsiva né codice: i valori restano testo.
    assert.equal(renderTemplate('{user}', { user: '{pokemon} <script>alert(1)</script>' }), '{pokemon} <script>alert(1)</script>');
    assert.equal(renderTemplate('Ciao {user}', { user: '${process.exit()}' }), 'Ciao ${process.exit()}');
    // Comandi di chat iniziali rimossi, a capo e caratteri di controllo eliminati.
    assert.equal(renderTemplate('/ban {user}', { user: 'x' }), 'ban x');
    assert.equal(renderTemplate('{user} vince', { user: '/timeout\r\nqualcuno\u200b' }), 'timeout qualcuno vince');
    assert.equal(renderTemplate('Bravo {user}', { user: 'a\r\n/ban b' }), 'Bravo a /ban b', 'un "/" in mezzo al testo non è un comando');
    assert.equal(renderTemplate('.mods'), 'mods');
    assert.equal(cleanValue('a'.repeat(100)).length, 40, 'valori accorciati');
    assert.ok(renderTemplate('x'.repeat(2000)).length <= 450, 'entro il limite di Twitch');
  });

  test('variabili dei Pokémon: minuscolo, maiuscolo, shiny, livello assente; varianti shiny e leggendaria', async () => {
    enable({
      events: { shiny_spawn: { enabled: true }, legendary_capture: { enabled: true } },
      messages: [
        { event: 'spawn', text: '{pokemon_lower}|{pokemon_upper}|{rarity}|{shiny}|{level}|' },
        { event: 'shiny_spawn', text: 'SHINY {pokemon} {shiny}' },
        { event: 'capture', text: 'cattura {pokemon}' },
        { event: 'legendary_capture', text: 'LEGGENDA {user} {pokemon} {rarity}' },
      ],
    });
    await manualStart();
    await spawn(2);
    await waitFor(() => tw.chat.length === 1, { message: 'spawn' });
    assert.equal(sent()[0], 'testmon b|TESTMON B|Non comune|||');
    await cancelSpawn();
    await spawn(2, true);
    await waitFor(() => tw.chat.length === 2, { message: 'spawn shiny' });
    assert.equal(sent()[1], 'SHINY Testmon B ✨ shiny', 'il messaggio shiny sostituisce quello generico');
    await cancelSpawn();
    app.chatMessages.setSettings({ events: { spawn: { cooldownS: 0 }, shiny_spawn: { cooldownS: 0 } } });
    await spawn(4);
    await manualThrow(0.0, 'Misty');
    await waitFor(() => tw.chat.length === 4, { message: 'spawn e cattura leggendaria' });
    assert.equal(sent()[3], 'LEGGENDA Misty Testmon D Leggendario');
    await settle();
    assert.equal(tw.chat.length, 4, 'un solo messaggio per la cattura');
  });

  test('messaggi casuali da un gruppo senza ripetere l\'ultimo; messaggio fisso scelto', async () => {
    const msgs = ['A {pokemon}', 'B {pokemon}', 'C {pokemon}'].map((text, i) => ({ id: `r-${i}`, event: 'spawn', text }));
    enable({ events: { spawn: { mode: 'random', cooldownS: 0 } }, messages: [...msgs, { id: 'off', event: 'spawn', text: 'SPENTO', enabled: false }], maxPerMinute: 20 });
    app.chatMessages.rng = () => 0; // sceglierebbe sempre il primo
    for (let i = 1; i <= 6; i++) {
      assert.ok(app.chatMessages.trigger('spawn', `x-${i}`, { pokemon: 'P' }));
    }
    await waitFor(() => tw.chat.length === 6, { message: '6 messaggi' });
    const letters = sent().map((m) => m[0]);
    for (let i = 1; i < letters.length; i++) assert.notEqual(letters[i], letters[i - 1], 'nessuna ripetizione consecutiva');
    assert.ok(!sent().includes('SPENTO'), 'messaggio disattivato mai usato');
    assert.ok(new Set(letters).size >= 2);
    // Modalità fissa.
    app.chatMessages.setSettings({ events: { spawn: { mode: 'fixed', fixedId: 'r-2' } } });
    app.chatMessages.trigger('spawn', 'x-7', { pokemon: 'P' });
    await waitFor(() => tw.chat.length === 7, { message: 'fisso' });
    assert.equal(sent()[6], 'C P');
  });

  test('messaggi personalizzati dalla dashboard: crea, duplica, modifica, elimina, attiva e disattiva', async () => {
    let r = await client.req('GET', '/api/admin/chat-messages');
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.enabled, false);
    assert.ok(r.data.events.some((e) => e.key === 'evolution' && !e.available), 'eventi futuri mostrati come non disponibili');
    const base = r.data.settings.messages;
    const mine = { id: 'mio-1', event: 'capture', text: 'GG {user}! {pokemon} è tuo', enabled: true };
    const copy = { ...mine, id: 'mio-2', text: 'Copia: GG {user}' };
    r = await client.req('PUT', '/api/admin/chat-messages', {
      enabled: true,
      events: { capture: { mode: 'fixed', fixedId: 'mio-1' }, spawn: { enabled: false } },
      messages: [...base.filter((m) => m.id !== 'capture-1'), mine, copy, { event: 'session_end', text: 'Ciao a tutti', enabled: false }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!r.data.settings.messages.some((m) => m.id === 'capture-1'), 'eliminato');
    assert.equal(r.data.settings.messages.filter((m) => m.event === 'capture').length, 2);
    const added = r.data.settings.messages.find((m) => m.text === 'Ciao a tutti');
    assert.match(added.id, /^m-[a-f0-9]{10}$/, 'ID assegnato dal server');
    assert.equal(added.enabled, false);
    await manualStart();
    await spawn(1);
    await manualThrow(0.0, 'Brock');
    await waitFor(() => tw.chat.length === 1, { message: 'cattura personalizzata' });
    assert.deepEqual(sent(), ['GG Brock! Testmon A è tuo']);
    // Validazione: evento non disponibile, testo vuoto o troppo lungo, valori fuori intervallo.
    for (const bad of [
      { messages: [{ event: 'evolution', text: 'x' }] },
      { events: { leaderboard_first: { enabled: true } } },
      { messages: [{ event: 'spawn', text: '   ' }] },
      { messages: [{ event: 'spawn', text: 'x'.repeat(301) }] },
      { messages: [{ event: 'boh', text: 'x' }] },
      { maxPerMinute: 0 }, { maxPerMinute: 99 },
      { events: { spawn: { cooldownS: -1 } } },
      { events: { spawn: { mode: 'tutti' } } },
      { enabled: 'si' },
    ]) {
      const x = await client.req('PUT', '/api/admin/chat-messages', bad);
      assert.equal(x.status, 400, JSON.stringify(bad));
    }
    // Operazione registrata nel registro amministrativo.
    assert.ok(app.db.get("SELECT 1 AS ok FROM admin_audit WHERE action = 'chat_messages_settings'"));
  });

  test('solo l\'amministratore: senza sessione o senza CSRF le modifiche sono rifiutate', async () => {
    assert.equal((await client.req('GET', '/api/admin/chat-messages', undefined, { auth: false })).status, 401);
    assert.equal((await client.req('PUT', '/api/admin/chat-messages', { enabled: true }, { auth: false })).status, 401);
    assert.equal((await client.req('PUT', '/api/admin/chat-messages', { enabled: true }, { csrfToken: 'sbagliato' })).status, 403);
    assert.equal((await client.req('POST', '/api/admin/chat-messages/test', { text: 'x' }, { auth: false })).status, 401);
    assert.equal(app.chatMessages.settings().enabled, false);
  });

  test('intervallo minimo per tipo di evento e limite di messaggi al minuto', async () => {
    enable({ events: { spawn: { cooldownS: 60 }, capture: { cooldownS: 0 } }, maxPerMinute: 3 });
    await manualStart();
    await spawn(1);
    await waitFor(() => tw.chat.length === 1, { message: 'primo spawn' });
    await cancelSpawn();
    await spawn(2);
    await settle();
    assert.equal(tw.chat.length, 1, 'secondo spawn entro l\'intervallo: saltato');
    assert.ok(app.chatMessages.recent.some((r) => /intervallo/.test(r.reason || '')));
    // Limite al minuto: 3 messaggi in tutto, gli altri saltati (non accodati).
    for (let i = 0; i < 5; i++) app.chatMessages.trigger('capture', `c-${i}`, { user: 'U', pokemon: 'P', rarity: 'Raro' });
    await settle();
    assert.equal(tw.chat.length, 3);
    assert.ok(app.chatMessages.recent.some((r) => /al minuto/.test(r.reason || '')));
    // Scaduta la finestra, si riparte (nessun recupero dei messaggi saltati).
    app.chatMessages.window = app.chatMessages.window.map((t) => t - 61000);
    app.chatMessages.trigger('capture', 'c-new', { user: 'U', pokemon: 'P', rarity: 'Raro' });
    await waitFor(() => tw.chat.length === 4, { message: 'nuovo messaggio dopo la finestra' });
    await settle();
    assert.equal(tw.chat.length, 4);
  });

  test('deduplicazione: lo stesso spawn o la stessa cattura producono un solo messaggio', async () => {
    enable();
    await manualStart();
    const sp = await spawn(1);
    await waitFor(() => tw.chat.length === 1, { message: 'spawn' });
    assert.equal(app.chatMessages.onSpawn(sp), null);
    app.chatMessages.setSettings({ events: { spawn: { cooldownS: 0 } } });
    assert.equal(app.chatMessages.onSpawn(sp), null, 'anche senza intervallo minimo');
    await manualThrow(0.0);
    await waitFor(() => tw.chat.length === 2, { message: 'cattura' });
    const attemptId = app.db.get("SELECT id FROM capture_attempts WHERE outcome = 'caught'").id;
    assert.equal(app.chatMessages.onAttempt({ caught: true, attemptId }), null);
    await settle();
    assert.equal(tw.chat.length, 2);
  });

  test('bot non collegato: nessun invio con il token del canale, salvo consenso esplicito', async () => {
    app.credentials.clearToken('bot');
    enable();
    await manualStart();
    await spawn(1);
    await settle();
    assert.deepEqual(tw.chat, [], 'senza bot non si usa l\'account del canale');
    assert.equal(app.chatMessages.availability().code, 'no_bot');
    assert.ok(app.chatMessages.recent.some((r) => /Nessun bot/.test(r.reason || '')));
    // Consenso esplicito: senza bot si usa l'account del canale.
    app.chatMessages.setSettings({ allowChannelAccount: true, events: { spawn: { cooldownS: 0 } } });
    await cancelSpawn();
    await spawn(2);
    await waitFor(() => tw.chat.length === 1, { message: 'spawn con l\'account del canale' });
    assert.equal(tw.chat[0].sender_id, BROADCASTER_ID);
    // Con un bot collegato si usa sempre il bot, anche con il consenso attivo.
    linkBot(app);
    await cancelSpawn();
    await spawn(3);
    await waitFor(() => tw.chat.length === 2, { message: 'spawn con il bot' });
    assert.equal(tw.chat[1].sender_id, BOT_ID);
  });

  test('bot senza permesso di scrittura o con token revocato: nessun invio, nessun ripiego sul canale', async () => {
    enable({ allowChannelAccount: true, events: { spawn: { cooldownS: 0 } } });
    linkBot(app, { scopes: ['chat:read'] });
    await manualStart();
    await spawn(1);
    await settle();
    assert.deepEqual(tw.chat, []);
    assert.equal(app.chatMessages.availability().code, 'bot_scope');
    // Token del bot revocato da Twitch durante l'invio: segnato come non valido, il gioco continua.
    linkBot(app);
    tw.revokedTokens.add('botaccess');
    tw.revokedTokens.add('botrefresh');
    await cancelSpawn();
    await spawn(2);
    await waitFor(() => app.credentials.authError('bot'), { message: 'bot segnato come non valido' });
    assert.equal(app.chatMessages.availability().code, 'bot_auth');
    await cancelSpawn();
    await spawn(3);
    await settle();
    assert.deepEqual(tw.chat, [], 'nessun messaggio con l\'account del canale');
    assert.equal(app.engine.status().activeSpawn.pokemonId, 3, 'il gioco continua');
  });

  test('Twitch offline: niente invii e niente coda per dopo', async () => {
    enable({ events: { spawn: { cooldownS: 0 } } });
    await manualStart();
    es.refuse = true;
    es.dropAll();
    await waitFor(() => !app.monitor.eventsub?.connected, { message: 'EventSub scollegato' });
    await spawn(1);
    await settle();
    assert.deepEqual(tw.chat, []);
    assert.equal(app.chatMessages.availability().code, 'twitch_offline');
    assert.ok(app.chatMessages.recent.some((r) => /non raggiungibile/.test(r.reason || '')));
    // Il gioco continua: lo spawn è attivo e una cattura viene registrata.
    await manualThrow(0.0);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE outcome = 'caught'").n, 1);
    // Twitch torna raggiungibile: i messaggi mancati non vengono recuperati.
    es.refuse = false;
    await waitFor(() => app.monitor.eventsub?.connected, { message: 'EventSub ricollegato', timeout: 5000 });
    await sleep(150);
    assert.deepEqual(tw.chat, []);
    // L'evento successivo parte normalmente.
    await spawn(2);
    await waitFor(() => tw.chat.length === 1, { message: 'nuovo spawn dopo il ritorno di Twitch' });
  });

  test('Twitch non configurato: nessun invio', async () => {
    app.monitor.stop();
    app.credentials.clearToken('broadcaster');
    enable();
    assert.equal(app.chatMessages.availability().code, 'twitch_not_configured');
    await manualStart();
    await spawn(1);
    await settle();
    assert.deepEqual(tw.chat, []);
  });

  test('sessione manuale: messaggi di inizio e fine sessione, solo con Twitch collegato', async () => {
    enable({ events: { session_start: { enabled: true }, session_end: { enabled: true }, spawn: { enabled: false } } });
    await manualStart();
    await waitFor(() => tw.chat.length === 1, { message: 'inizio sessione' });
    assert.match(sent()[0], /^🎮 Si parte!/);
    await spawn(1);
    await manualThrow(0.0);
    await waitFor(() => tw.chat.length === 2, { message: 'cattura' });
    await manualStop();
    await waitFor(() => tw.chat.length === 3, { message: 'fine sessione' });
    assert.equal(sent()[2], '👋 Sessione finita: 1 catture su 1 Pokémon apparsi. Grazie a tutti!');
  });

  test('errori di Twitch: il motore non si blocca; 429 mette in pausa gli invii', async () => {
    enable({ events: { spawn: { cooldownS: 0 }, capture: { cooldownS: 0 } } });
    await manualStart();
    tw.fault('/helix/chat/messages', { status: 500, times: 1 });
    await spawn(1);
    await waitFor(() => app.chatMessages.stats.failed === 1, { message: 'errore registrato' });
    assert.ok(app.engine.status().activeSpawn, 'spawn attivo nonostante l\'errore');
    await manualThrow(0.0);
    await waitFor(() => tw.chat.length === 1, { message: 'cattura inviata dopo l\'errore' });
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM capture_attempts WHERE outcome = 'caught'").n, 1);
    // Rete giù durante l'invio.
    tw.fault('/helix/chat/messages', { network: true, times: 1 });
    await spawn(2);
    await waitFor(() => app.chatMessages.stats.failed === 2, { message: 'errore di rete', timeout: 5000 });
    assert.ok(app.engine.status().activeSpawn);
    await cancelSpawn();
    tw.faults = [];
    // Troppe richieste: pausa di 30 s, i messaggi intanto vengono saltati.
    tw.fault('/helix/chat/messages', { status: 429, times: 10 });
    await spawn(3);
    await waitFor(() => app.chatMessages.pauseUntil > Date.now(), { message: 'pausa dopo 429', timeout: 5000 });
    tw.faults = [];
    await cancelSpawn();
    await spawn(1);
    await settle();
    assert.equal(tw.chat.length, 1, 'durante la pausa nessun invio');
    assert.ok(app.chatMessages.recent.some((r) => /rallentare/.test(r.reason || '')));
    // Un'eccezione inattesa nel servizio non arriva al motore.
    const orig = app.chatMessages.settings;
    app.chatMessages.settings = () => { throw new Error('guasto'); };
    await cancelSpawn();
    await spawn(2);
    assert.ok(app.engine.status().activeSpawn, 'spawn creato');
    app.chatMessages.settings = orig;
    // Nessun token nei log o nelle statistiche.
    const dump = JSON.stringify(app.chatMessages.view());
    assert.ok(!dump.includes('botaccess') && !dump.includes('botrefresh') && !dump.includes('access"'));
  });

  test('anteprima e invio di prova: solo su richiesta, solo con Twitch collegato', async () => {
    let r = await client.req('POST', '/api/admin/chat-messages/preview', { text: 'Ciao {user}, ecco {pokemon} {boh}', event: 'capture' });
    assert.equal(r.status, 200);
    assert.equal(r.data.message, 'Ciao AshKetchum, ecco Pikachu {boh}');
    assert.deepEqual(tw.chat, [], 'l\'anteprima non invia nulla');
    r = await client.req('POST', '/api/admin/chat-messages/test', { text: 'Prova {pokemon}', event: 'spawn' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(sent(), ['Prova Pikachu']);
    assert.equal(tw.chat[0].sender_id, BOT_ID);
    assert.equal(app.chatMessages.settings().enabled, false, 'la prova funziona anche con i messaggi automatici spenti');
    assert.equal((await client.req('POST', '/api/admin/chat-messages/test', { text: '' })).status, 400);
    assert.equal((await client.req('POST', '/api/admin/chat-messages/test', { text: 'x', event: 'evolution' })).status, 400);
    // Twitch scollegato: la prova viene rifiutata, nulla in coda.
    es.refuse = true;
    es.dropAll();
    await waitFor(() => !app.monitor.eventsub?.connected, { message: 'EventSub scollegato' });
    r = await client.req('POST', '/api/admin/chat-messages/test', { text: 'Prova 2' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /non raggiungibile/);
    assert.equal(tw.chat.length, 1);
  });
});

test('impostazioni conservate dopo un riavvio', async () => {
  const dir = tempDir();
  let { app } = await makeApp({ dir });
  app.chatMessages.setSettings({
    enabled: true, maxPerMinute: 4,
    events: { spawn: { mode: 'random', cooldownS: 30 }, shiny_capture: { enabled: true } },
    messages: [{ id: 'keep', event: 'spawn', text: 'Resto qui {pokemon}' }],
  });
  await app.close();
  ({ app } = await makeApp({ dir }));
  const s = app.chatMessages.settings();
  assert.equal(s.enabled, true);
  assert.equal(s.maxPerMinute, 4);
  assert.equal(s.events.spawn.mode, 'random');
  assert.equal(s.events.spawn.cooldownS, 30);
  assert.equal(s.events.shiny_capture.enabled, true);
  assert.equal(s.events.capture.enabled, true, 'eventi non toccati: valori predefiniti');
  assert.deepEqual(s.messages, [{ id: 'keep', event: 'spawn', enabled: true, text: 'Resto qui {pokemon}' }]);
  await app.close();
  cleanup(dir);
});

test('catalogo degli eventi e valori predefiniti coerenti', () => {
  for (const e of CHAT_EVENTS) {
    if (e.available) {
      assert.ok(CHAT_MESSAGE_DEFAULTS.events[e.key], `predefiniti per ${e.key}`);
      assert.ok(CHAT_MESSAGE_DEFAULTS.messages.some((m) => m.event === e.key), `messaggio predefinito per ${e.key}`);
    } else {
      assert.ok(!CHAT_MESSAGE_DEFAULTS.events[e.key], `${e.key} non disponibile: nessuna impostazione`);
      assert.ok(e.reason);
    }
  }
  for (const m of CHAT_MESSAGE_DEFAULTS.messages) assert.ok(m.text.length <= 300);
});

test('backup e ripristino: le impostazioni dei messaggi tornano allo stato del backup', async () => {
  const { app, dir } = await makeApp({ configureTwitch: false });
  try {
    app.chatMessages.setSettings({ enabled: true, messages: [{ id: 'nel-backup', event: 'capture', text: 'Salvato {user}' }] });
    const b = app.backups.create('manual', 'prova messaggi');
    app.chatMessages.setSettings({ enabled: false, messages: [{ id: 'dopo', event: 'spawn', text: 'Dopo il backup' }] });
    const res = await app.restore(b.filename);
    assert.equal(res.integrity, true);
    const s = app.chatMessages.settings();
    assert.equal(s.enabled, true);
    assert.deepEqual(s.messages.map((m) => m.id), ['nel-backup']);
  } finally { await app.close(); cleanup(dir); }
});

test('database della 1.0.0: nessuna migrazione, messaggi spenti con i testi predefiniti', async () => {
  const dir = tempDir();
  const file = legacyDatabase(dir, LATEST_SCHEMA);
  const before = new DatabaseSync(file);
  const tables = before.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  before.close();
  const { app } = await makeApp({ dir });
  try {
    assert.equal(app.preUpdate, null, 'nessun aggiornamento dello schema');
    assert.equal(app.db.schemaVersion(), LATEST_SCHEMA);
    assert.deepEqual(app.db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name), tables, 'nessuna nuova tabella');
    const s = app.chatMessages.settings();
    assert.equal(s.enabled, false);
    assert.deepEqual(s.messages, CHAT_MESSAGE_DEFAULTS.messages);
    assert.equal(app.adminSettings.get('chatMessages'), undefined, 'niente scritto finché l\'amministratore non salva');
  } finally { await app.close(); cleanup(dir); }
});
