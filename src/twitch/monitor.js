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
    this.knownLive = null; // ultimo stato della diretta comunicato da Twitch: { live, at }
    this.lastError = null;
    this.transientIssue = null;
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
    this.authFailed = false;
    if (!this.configured()) {
      this.knownLive = null;
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
    this.eventsub.on('revocation', (s) => this.onRevocation(s));
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
    // Problema temporaneo (rete, timeout, 429, 5xx): nessuna revoca e nessun
    // cambio di stato; il gioco continua e il controllo successivo riprova.
    if (err.transient && !err.authInvalid) return this.noteTransient(err);
    this.transientIssue = null;
    this.lastError = err.message;
    this.log.error('Errore Twitch', { message: err.message });
    if (err.authInvalid || err.status === 401) {
      this.creds.markInvalid('broadcaster', err.message);
      this.authFailed = true;
    }
    if (err.authInvalid || err.status === 401 || err.status === 403) {
      this.sm.goTo(STATES.ERROR, 'auth_error');
    }
  }

  // Il canale risulta in diretta secondo l'ultima informazione ricevuta da
  // Twitch (API /streams o evento stream.online/offline), anche se il gioco è
  // fermo per un errore o una connessione in corso.
  // L'informazione vale 30 minuti: oltre, senza conferme, lo stato è ignoto.
  channelLive(now = Date.now()) {
    return !!this.knownLive?.live && now - Date.parse(this.knownLive.at) < 30 * 60 * 1000;
  }

  setKnownLive(live) { this.knownLive = { live: !!live, at: new Date().toISOString() }; }

  noteTransient(err) {
    const first = !this.transientIssue;
    this.transientIssue = { since: this.transientIssue?.since || new Date().toISOString(), at: new Date().toISOString(), message: err.message, status: err.status || null };
    this.lastError = `Problema temporaneo di Twitch: ${err.message}. Il gioco continua, nuovo tentativo automatico.`;
    if (first) this.log.warn('Problema temporaneo di Twitch', { message: err.message, http: err.status });
  }

  // Twitch ha risposto di nuovo correttamente: rimuove l'avviso temporaneo.
  clearTransient() {
    if (!this.transientIssue) return;
    this.log.info('Twitch di nuovo raggiungibile', { since: this.transientIssue.since });
    this.transientIssue = null;
    this.lastError = null;
  }

  // Twitch revoca le sottoscrizioni quando il canale scollega l'app o il token
  // perde validità: il gioco si ferma subito invece di attendere il controllo periodico.
  onRevocation(sub) {
    this.lastError = `Sottoscrizione revocata da Twitch: ${sub?.type} (${sub?.status})`;
    this.log.error('Sottoscrizione EventSub revocata', { type: sub?.type, status: sub?.status });
    if (['authorization_revoked', 'user_removed'].includes(sub?.status)) {
      this.fail(Object.assign(new Error(`Autorizzazione Twitch revocata (${sub.status}): ricollega l'account del canale`), { authInvalid: true }));
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

  // Ricompense che potrebbero essere riscattabili su Twitch mentre il gioco non
  // accetta lanci: create dall'app ma non confermate in pausa (es. token revocato),
  // oppure collegate a mano (Twitch non ne consente la pausa via API).
  rewardsAtRisk() {
    if (!this.alive() || !this.desiredPaused()) return { atRisk: [], linkedActive: 0 };
    const autoPause = !!this.gameSettings.get('rewards').autoPause;
    const atRisk = this.db.all(
      `SELECT id, title, sync_error FROM twitch_rewards WHERE is_enabled = 1 AND managed_by_app = 1
       AND (? = 0 OR is_paused = 0 OR sync_error IS NOT NULL)`, autoPause ? 1 : 0)
      .map((r) => ({ id: r.id, title: r.title, error: r.sync_error }));
    const linkedActive = this.db.get('SELECT COUNT(*) AS n FROM twitch_rewards WHERE is_enabled = 1 AND managed_by_app = 0').n;
    return { atRisk, linkedActive };
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
      this.setKnownLive(stream);
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
      this.setKnownLive(stream);
    } catch (e) {
      this.lastPoll = { at: new Date().toISOString(), ok: false, error: e.message };
      this.fail(e);
      return;
    }
    this.clearTransient();
    if (this.authFailed) {
      // Il rinnovo del token è tornato a funzionare: le sottoscrizioni potrebbero
      // essere state revocate, quindi si ricollega EventSub da capo.
      this.authFailed = false;
      this.creds.clearAuthError('broadcaster');
      this.log.info('Autorizzazione Twitch di nuovo valida: riconnessione');
      return this.restart();
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
      let info;
      try {
        info = await this.oauth.validate(t.accessToken);
      } catch (e) {
        // Esito sconosciuto (rete, timeout, 429, 5xx): nessuna conclusione sul token.
        if (role === 'broadcaster') this.noteTransient(e);
        else this.log.warn('Verifica del token del bot non conclusa: nuovo tentativo più tardi', { message: e.message });
        continue;
      }
      if (info) {
        this.creds.clearAuthError(role);
        if (role === 'broadcaster') this.clearTransient();
        continue;
      }
      // Token di accesso non più valido (401): si rinnova, passando dal rinnovo
      // condiviso con le richieste Helix (un solo rinnovo alla volta).
      try {
        await this.helix.refresh(role);
        if (role === 'broadcaster') this.clearTransient();
      } catch (e) {
        if (!e.authInvalid) {
          // Rinnovo non concluso per un problema temporaneo: il token non è revocato.
          if (role === 'broadcaster') this.noteTransient(e);
          else this.log.warn('Rinnovo del token del bot non concluso: nuovo tentativo più tardi', { message: e.message });
        } else if (role === 'bot') {
          // Il bot serve solo per la chat: il gioco continua e risponde l'account del canale.
          this.creds.markInvalid('bot', e.message);
          this.log.error('Token del bot non più valido: ricollega il bot. Nel frattempo risponde l\'account del canale', { message: e.message });
        } else {
          this.fail(e); // Twitch ha rifiutato il refresh token (400/401): revoca reale
        }
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
        this.setKnownLive(true);
        this.goLive({ broadcastId: ev.id, startedAt: ev.started_at }, 'stream.online');
        return { detail: 'live' };
      case 'stream.offline':
        this.offlineCount = 99;
        this.setKnownLive(false);
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
    // Ruolo di chi scrive dall'evento firmato da Twitch (ID e badge), mai dal nickname.
    const broadcasterId = this.creds.getToken('broadcaster')?.userId;
    const badges = Array.isArray(ev.badges) ? ev.badges : [];
    const out = this.commands.handle({
      text: ev.message?.text || '',
      user: { twitchId: ev.chatter_user_id, login: ev.chatter_user_login, displayName: ev.chatter_user_name },
      messageId: ev.message_id,
      live: true,
      isBroadcaster: !!broadcasterId && String(ev.chatter_user_id) === String(broadcasterId),
      isModerator: badges.some((b) => b?.set_id === 'moderator'),
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
      transientIssue: this.transientIssue || null,
      eventsReceived: this.eventsReceived,
      chat: this.chat?.stats(),
      reconcile: this.reconciler.last,
      rewardsPause: { autoPause: !!this.gameSettings.get('rewards').autoPause, desiredPaused: this.desiredPaused(), last: this.lastPauseSync, ...this.rewardsAtRisk() },
      authErrors: { broadcaster: this.creds.authError('broadcaster'), bot: this.creds.authError('bot') },
    };
  }
}
