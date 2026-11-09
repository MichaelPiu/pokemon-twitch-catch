// Monitor dello stato Twitch: collega EventSub (WebSocket), controlla
// periodicamente /streams e guida la macchina a stati del ciclo di vita.
// Il motore di gioco viene acceso/spento SOLO da qui.
import { STATES } from '../game_engine/stateMachine.js';
import { EventSubClient } from '../eventsub/client.js';
import { RedemptionReconciler } from './reconcile.js';

const ONLINE_GRACE_MS = 3 * 60 * 1000;

export class TwitchMonitor {
  constructor({ config, db, credentials, helix, oauth, sm, engine, commands, chat, gameSettings, hub, log, WebSocketImpl, timers = true, rewards = null }) {
    Object.assign(this, { config, db, creds: credentials, helix, oauth, sm, engine, commands, chat, gameSettings, hub, log, rewards });
    this.reconciler = new RedemptionReconciler({
      db, helix, credentials, gameSettings, log,
      process: (redemption, opts) => this.onRedemption(redemption, opts),
    });
    this.pauseChain = Promise.resolve();
    this.lastPauseSync = null;
    this.reconcileSoonTimer = null;
    this.WebSocketImpl = WebSocketImpl;
    this.timersEnabled = timers;
    this.eventsub = null;
    this.pollTimer = null;
    this.validateTimer = null;
    this.offlineCount = 0;
    this.lastOnlineEventAt = 0;
    this.lastPoll = null;
    this.lastError = null;
    this.subscriptions = [];
    this.broadcaster = null;
    this.eventsReceived = 0;
    this.started = false;

    sm.on('transition', (t) => this.onTransition(t));
  }

  configured() {
    const b = this.creds.getToken('broadcaster');
    return !!(this.creds.clientId && b?.accessToken && b?.userId);
  }

  // Reazione del motore di gioco a ogni transizione di stato.
  onTransition({ to, reason }) {
    this.hub.admin('state', { ...this.sm.snapshot() });
    // Dopo che il motore ha reagito alla transizione, allinea la pausa delle ricompense.
    setImmediate(() => this.syncRewardPause());
    if (to === STATES.LIVE) return; // l'attivazione avviene in goLive() con i dati della diretta
    if (to === STATES.OFFLINE) {
      if (this.engine.mode === 'live' || this.engine.sessions.current(false)) this.engine.deactivate(reason || 'stream_offline');
      return;
    }
    // CONNECTING, PAUSED, ERROR: il gioco viene sospeso in sicurezza.
    if (this.engine.mode === 'live') this.engine.suspend(to.toLowerCase());
  }

  async start() {
    this.started = true;
    if (!this.configured()) {
      this.sm.goTo(STATES.ERROR, 'not_configured');
      this.lastError = 'Twitch non configurato: completa la procedura guidata nella sezione Twitch';
      return;
    }
    this.broadcaster = this.creds.getToken('broadcaster');
    this.sm.goTo(STATES.CONNECTING, 'connecting');
    this.lastError = null;
    this.eventsub = new EventSubClient({ url: this.config.twitch.eventsubUrl, log: this.log, WebSocketImpl: this.WebSocketImpl, backoffBaseMs: this.config.twitch.backoffMs ?? 1000 });
    this.eventsub.on('connected', (e) => this.onConnected(e).catch((err) => this.fail(err)));
    this.eventsub.on('disconnected', (e) => this.onDisconnected(e));
    this.eventsub.on('notification', (n) => this.onNotification(n));
    this.eventsub.on('revocation', (s) => { this.lastError = `Sottoscrizione revocata: ${s?.type} (${s?.status})`; });
    this.eventsub.start();
    this.startTimers();
  }

  stop() {
    clearTimeout(this.reconcileSoonTimer);
    clearInterval(this.pollTimer);
    clearInterval(this.validateTimer);
    this.pollTimer = null;
    this.validateTimer = null;
    if (this.eventsub) { this.eventsub.removeAllListeners(); this.eventsub.stop(); }
    this.eventsub = null;
    this.started = false;
  }

  async restart() {
    this.stop();
    if (this.sm.state === STATES.LIVE) this.sm.transition(STATES.PAUSED, 'reconfigure');
    await this.start();
  }

  startTimers() {
    if (!this.timersEnabled) return;
    const pollS = Math.max(15, this.gameSettings.get('lifecycle').pollIntervalS || 60);
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), pollS * 1000);
    this.pollTimer.unref?.();
    this.validateTimer = setInterval(() => this.validateTokens().catch(() => {}), 3600 * 1000);
    this.validateTimer.unref?.();
  }

  fail(err) {
    this.lastError = err.message;
    this.log.error('Errore Twitch', { message: err.message });
    if (err.authInvalid || err.status === 401 || err.status === 403) {
      this.sm.goTo(STATES.ERROR, 'auth_error');
    }
  }

  async onConnected({ sessionId, resubscribe }) {
    this.log.info('EventSub connesso');
    if (resubscribe) await this.subscribe(sessionId);
    await this.confirmState('eventsub_connected');
    // Riscatti avvenuti mentre l'app non riceveva eventi (avvio, disconnessione).
    await this.reconciler.run('eventsub_connected').catch((e) => this.log.warn('Riconciliazione riscatti fallita', { message: e.message }));
  }

  // --- Ricompense: pausa automatica e riconciliazione ------------------------
  // Il gioco accetta lanci solo in LIVE con il motore attivo: in tutti gli altri
  // stati le ricompense create dall'app vengono messe in pausa su Twitch.
  desiredPaused() {
    return !(this.sm.state === STATES.LIVE && this.engine.mode === 'live' && !this.engine.suspended);
  }

  // Il database può essere già chiuso quando scatta un callback ritardato (arresto, ripristino).
  alive() { return !!this.db?.db; }

  syncRewardPause({ force = false } = {}) {
    if (!this.alive() || !this.rewards || !this.gameSettings.get('rewards').autoPause || !this.configured()) return this.pauseChain;
    this.pauseChain = this.pauseChain.then(async () => {
      if (!this.alive()) return;
      const paused = this.desiredPaused();
      if (!force && !this.rewards.needsPauseSync(paused)) return;
      const r = await this.rewards.syncPause(paused, { force });
      this.lastPauseSync = { at: new Date().toISOString(), paused, ...r };
      this.hub.admin('rewards_pause', this.lastPauseSync);
    }).catch((e) => this.log.warn('Sincronizzazione pausa ricompense fallita', { message: e.message }));
    return this.pauseChain;
  }

  reconcileSoon(reason, delayMs = 5000) {
    clearTimeout(this.reconcileSoonTimer);
    this.reconcileSoonTimer = setTimeout(() => { if (this.alive()) this.reconciler.run(reason).catch(() => {}); }, delayMs);
    this.reconcileSoonTimer.unref?.();
  }

  onDisconnected({ reason }) {
    this.log.warn(`EventSub disconnesso (${reason})`);
    if (this.sm.state === STATES.LIVE) this.sm.transition(STATES.PAUSED, 'twitch_disconnected');
    else if (this.sm.state === STATES.OFFLINE) this.sm.transition(STATES.CONNECTING, 'twitch_disconnected');
  }

  async subscribe(sessionId) {
    const bid = this.broadcaster.userId;
    const subs = [
      ['stream.online', '1', { broadcaster_user_id: bid }],
      ['stream.offline', '1', { broadcaster_user_id: bid }],
      ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: bid }],
      ['channel.channel_points_custom_reward_redemption.update', '1', { broadcaster_user_id: bid }],
      ['channel.chat.message', '1', { broadcaster_user_id: bid, user_id: bid }],
    ];
    this.subscriptions = [];
    for (const [type, version, condition] of subs) {
      try {
        await this.helix.createSubscription(type, version, condition, sessionId);
        this.subscriptions.push({ type, status: 'enabled' });
      } catch (e) {
        this.subscriptions.push({ type, status: 'failed', error: e.message });
        this.log.error(`Sottoscrizione ${type} fallita`, { status: e.status, message: e.message });
        if (e.status === 401 || e.authInvalid) throw e;
        // 403 sulle ricompense = canale non Affiliate/Partner o scope mancante: il resto continua a funzionare.
      }
    }
  }

  // Verifica lo stato reale della diretta tramite API e allinea la macchina a stati.
  async confirmState(reason) {
    let stream;
    try {
      stream = await this.helix.getStream(this.broadcaster.userId);
      this.lastPoll = { at: new Date().toISOString(), live: !!stream, ok: true };
    } catch (e) {
      this.lastPoll = { at: new Date().toISOString(), ok: false, error: e.message };
      this.fail(e);
      return;
    }
    if (stream) {
      this.offlineCount = 0;
      this.goLive({ broadcastId: stream.id, title: stream.title, startedAt: stream.started_at }, reason);
    } else {
      this.goOffline(reason);
    }
  }

  goLive(info, reason) {
    if (!this.eventsub?.connected) {
      // Senza EventSub non riceviamo riscossioni: restiamo in pausa/connessione.
      if (this.sm.state === STATES.LIVE) this.sm.transition(STATES.PAUSED, 'twitch_disconnected');
      return;
    }
    const current = this.engine.sessions.current(false);
    if (this.sm.state === STATES.LIVE) {
      if (current?.broadcast_id && info.broadcastId && current.broadcast_id !== info.broadcastId) {
        // Nuova diretta mentre la precedente risultava aperta: chiude e riapre.
        this.engine.deactivate('new_broadcast');
        this.engine.activateLive(info);
      }
      return;
    }
    this.sm.goTo(STATES.LIVE, reason);
    if (this.sm.state !== STATES.LIVE) return;
    if (current?.broadcast_id && info.broadcastId && current.broadcast_id !== info.broadcastId) {
      this.engine.deactivate('new_broadcast');
    }
    if (this.engine.mode === 'live' && this.engine.suspended) this.engine.resume();
    else this.engine.activateLive(info);
  }

  goOffline(reason) {
    if ([STATES.LIVE, STATES.PAUSED, STATES.CONNECTING, STATES.ERROR].includes(this.sm.state)) {
      this.sm.goTo(STATES.OFFLINE, reason);
    } else if (this.engine.sessions.current(false)) {
      // Sessione rimasta aperta da un riavvio ma il canale è offline: la chiude.
      this.engine.deactivate(reason);
    }
  }

  // Controllo periodico (protezione contro eventi persi).
  async poll() {
    if (!this.configured() || !this.broadcaster) return;
    let stream;
    try {
      stream = await this.helix.getStream(this.broadcaster.userId);
      this.lastPoll = { at: new Date().toISOString(), live: !!stream, ok: true };
    } catch (e) {
      this.lastPoll = { at: new Date().toISOString(), ok: false, error: e.message };
      this.fail(e);
      return;
    }
    if (this.sm.state === STATES.ERROR && this.eventsub?.connected) this.sm.goTo(STATES.CONNECTING, 'recovered');
    // Ritenta la pausa/riattivazione delle ricompense non riuscita e recupera
    // periodicamente i riscatti rimasti in coda.
    this.syncRewardPause();
    const rc = this.gameSettings.get('rewards');
    if (this.eventsub?.connected && rc.reconcileEnabled && Date.now() - this.reconciler.lastRunAt >= rc.reconcileIntervalS * 1000) {
      this.reconciler.run('periodic').catch(() => {});
    }
    if (stream) {
      this.offlineCount = 0;
      if (this.sm.state !== STATES.LIVE) this.goLive({ broadcastId: stream.id, title: stream.title, startedAt: stream.started_at }, 'poll_live');
      else this.goLive({ broadcastId: stream.id }, 'poll_live');
    } else {
      if (Date.now() - this.lastOnlineEventAt < ONLINE_GRACE_MS) return; // l'API può essere in ritardo rispetto a stream.online
      this.offlineCount++;
      const need = Math.max(1, this.gameSettings.get('lifecycle').offlineConfirmations || 2);
      if ([STATES.LIVE, STATES.PAUSED].includes(this.sm.state)) {
        if (this.offlineCount >= need) this.goOffline('poll_offline');
      } else if (this.sm.state === STATES.CONNECTING && this.eventsub?.connected) {
        this.goOffline('poll_offline');
      } else if (this.sm.state === STATES.OFFLINE && this.engine.sessions.current(false)) {
        this.engine.deactivate('poll_offline');
      }
    }
  }

  async validateTokens() {
    for (const role of ['broadcaster', 'bot']) {
      const t = this.creds.getToken(role);
      if (!t?.accessToken) continue;
      const info = await this.oauth.validate(t.accessToken).catch(() => undefined);
      if (info === undefined) continue; // rete non disponibile: riprova più tardi
      if (!info) {
        try { await this.oauth.refresh(role); } catch (e) { this.fail(Object.assign(e, { authInvalid: true })); }
      }
    }
  }

  // --- Notifiche EventSub ----------------------------------------------------
  recordEvent(n) {
    // Idempotenza: ogni message_id viene elaborato una sola volta (protezione replay).
    const r = this.db.run(
      'INSERT OR IGNORE INTO twitch_events (message_id, event_type, message_timestamp, payload) VALUES (?, ?, ?, ?)',
      n.messageId, n.type, n.messageTimestamp || null, JSON.stringify(n.event ?? {}).slice(0, 4000));
    return r.changes === 1;
  }

  setEventStatus(messageId, status, detail = null) {
    this.db.run('UPDATE twitch_events SET status = ?, detail = ? WHERE message_id = ?', status, detail, messageId);
  }

  onNotification(n) {
    // Messaggi più vecchi di 10 minuti vengono scartati (protezione replay).
    if (n.messageTimestamp && Date.now() - Date.parse(n.messageTimestamp) > 10 * 60 * 1000) {
      this.log.warn('Evento EventSub troppo vecchio scartato', { type: n.type });
      this.db.run(
        "INSERT OR IGNORE INTO twitch_events (message_id, event_type, message_timestamp, status, detail, payload) VALUES (?, ?, ?, 'stale', ?, ?)",
        n.messageId, n.type, n.messageTimestamp, 'scartato: più vecchio di 10 minuti', JSON.stringify(n.event ?? {}).slice(0, 4000));
      // Un riscatto tardivo non va perso: se è ancora in coda su Twitch lo recupera la riconciliazione.
      if (n.type === 'channel.channel_points_custom_reward_redemption.add') this.reconcileSoon('evento_tardivo');
      return { skipped: 'stale' };
    }
    if (!this.recordEvent(n)) return { skipped: 'duplicate' };
    this.eventsReceived++;
    try {
      const r = this.dispatch(n);
      this.setEventStatus(n.messageId, 'processed', r?.detail || null);
      this.hub.admin('twitch_event', { type: n.type, at: new Date().toISOString(), detail: r?.detail || null });
      return r;
    } catch (e) {
      this.setEventStatus(n.messageId, 'error', e.message);
      this.log.error(`Errore elaborazione evento ${n.type}`, { message: e.message });
      return { error: e.message };
    }
  }

  dispatch(n) {
    const ev = n.event || {};
    switch (n.type) {
      case 'stream.online':
        if (ev.type && ev.type !== 'live') return { detail: `ignorato (${ev.type})` };
        this.lastOnlineEventAt = Date.now();
        this.offlineCount = 0;
        this.goLive({ broadcastId: ev.id, startedAt: ev.started_at }, 'stream.online');
        return { detail: 'live' };
      case 'stream.offline':
        this.offlineCount = 99;
        this.goOffline('stream.offline');
        return { detail: 'offline' };
      case 'channel.channel_points_custom_reward_redemption.add':
        return this.onRedemption(ev);
      case 'channel.channel_points_custom_reward_redemption.update':
        this.engine.redemptionUpdated({ redemptionId: ev.id, status: ev.status });
        return { detail: ev.status };
      case 'channel.chat.message':
        return this.onChat(ev);
      default:
        return { detail: 'non gestito' };
    }
  }

  onRedemption(ev, { source = 'eventsub' } = {}) {
    const res = this.engine.attempt({
      redemptionId: ev.id,
      rewardId: ev.reward?.id,
      user: { twitchId: ev.user_id, login: ev.user_login, displayName: ev.user_name },
      redeemedAt: ev.redeemed_at,
      isDemo: false,
      source,
    });
    if (res.ignored) return { detail: 'ricompensa non di gioco' };
    if (res.duplicate) return { detail: 'duplicato' };
    const capture = this.gameSettings.get('capture');
    // Aggiorna lo stato della riscossione su Twitch, solo per ricompense create dall'app
    // e solo se la riscossione è ancora in coda. Lo stato viene salvato e, in caso di
    // errore, ritentato dalla riconciliazione.
    if (res.managed && String(ev.status || '').toLowerCase() === 'unfulfilled') {
      const status = this.reconciler.desiredFor({ outcome: res.rejected ? 'rejected' : 'processed' });
      if (status) this.reconciler.setDesired(ev.id, status).catch(() => {});
    }
    if (res.rejected) {
      if (res.reason !== 'banned' && ['no_spawn', 'expired', 'late', 'user_limit', 'already_caught'].includes(res.reason) && this.sm.state === STATES.LIVE) {
        const why = { no_spawn: 'nessun Pokémon in giro al momento', expired: 'il Pokémon è già fuggito', late: 'il Pokémon non era ancora apparso', user_limit: 'hai esaurito i tentativi per questo Pokémon', already_caught: 'qualcuno l\'ha già catturato' }[res.reason];
        this.chat?.send(`@${res.user.display_name} ${why}${res.managed && capture.refundRejected ? ' (punti rimborsati)' : ''}.`);
      }
      return { detail: `rifiutato: ${res.reason}${source === 'recovered' ? ' (recuperato)' : ''}` };
    }
    return { detail: `${res.caught ? 'catturato' : 'fallito'}${source === 'recovered' ? ' (recuperato)' : ''}` };
  }

  onChat(ev) {
    if (this.sm.state !== STATES.LIVE || !this.engine.running) return { detail: 'gioco offline: ignorato' };
    if (ev.chatter_user_id === this.creds.getToken('bot')?.userId) return { detail: 'messaggio del bot' };
    const out = this.commands.handle({
      text: ev.message?.text || '',
      user: { twitchId: ev.chatter_user_id, login: ev.chatter_user_login, displayName: ev.chatter_user_name },
      messageId: ev.message_id,
    });
    if (out?.reply) {
      this.chat.send(out.reply, ev.message_id);
      return { detail: `comando ${out.command}` };
    }
    return { detail: out?.ignored ? `ignorato (${out.ignored})` : 'chat' };
  }

  status() {
    return {
      configured: this.configured(),
      eventsubConnected: !!this.eventsub?.connected,
      eventsubSession: this.eventsub?.sessionId ? 'attiva' : null,
      lastMessageAt: this.eventsub?.lastMessageAt ? new Date(this.eventsub.lastMessageAt).toISOString() : null,
      subscriptions: this.subscriptions,
      lastPoll: this.lastPoll,
      lastError: this.lastError,
      eventsReceived: this.eventsReceived,
      chat: this.chat?.stats(),
      reconcile: this.reconciler.last,
      rewardsPause: { autoPause: !!this.gameSettings.get('rewards').autoPause, desiredPaused: this.desiredPaused(), last: this.lastPauseSync },
    };
  }
}
