// Composizione dell'applicazione: servizi sempre attivi (API, DB, dashboard,
// monitor Twitch, backup) + motore di gioco attivato solo durante le dirette.
import { createServer } from 'node:http';
import { mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { Database, SettingsStore } from './database/index.js';
import { Logger } from './logger.js';
import { GAME_DEFAULTS, ADMIN_DEFAULTS, OVERLAY_DEFAULTS, COMMAND_GLOBAL_DEFAULTS, DEFAULT_BALLS } from './configuration/defaults.js';
import { loadSecretKey, SecretBox } from './security/crypto.js';
import { AuthService, SESSION_COOKIE } from './security/auth.js';
import { RateLimiter } from './security/rateLimit.js';
import { ProxyTrust } from './security/proxy.js';
import { RequestGuard, parseList } from './security/origin.js';
import { Router, HttpError, sendJson, parseCookies } from './http/router.js';
import { WsHub } from './websocket/hub.js';
import { StateMachine, STATES } from './game_engine/stateMachine.js';
import { GameEngine } from './game_engine/engine.js';
import { CommandHandler, seedCommands } from './commands/commands.js';
import { TwitchCredentials } from './twitch/credentials.js';
import { TwitchOAuth } from './twitch/oauth.js';
import { Helix } from './twitch/helix.js';
import { ChatSender } from './twitch/chat.js';
import { RewardsService } from './twitch/rewards.js';
import { TwitchMonitor } from './twitch/monitor.js';
import { PokemonImporter } from './pokemon_data/importer.js';
import { BackupService, preMigrationBackup } from './backup/backup.js';
import { NetworkBackupService } from './backup/network.js';
import { audit } from './audit.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerPublicRoutes } from './api/public.js';
import { registerOverlayRoutes } from './api/overlay.js';
import { registerGameRoutes } from './api/game.js';
import { registerBackupRoutes } from './api/backups.js';
import { registerPokedexRoutes } from './api/pokedex.js';
import { ThemeStore } from './overlay/themes.js';
import { OverlaySimulator } from './overlay/simulator.js';
import { LeaderboardService } from './leaderboard/leaderboard.js';
import { registerLeaderboardRoutes } from './api/leaderboard.js';
import { AudioService, AUDIO_TYPES } from './audio/audio.js';
import { registerAudioRoutes } from './api/audio.js';
import { ChatMessagesService } from './chat_messages/messages.js';
import { registerChatMessageRoutes } from './api/chatMessages.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.webp': 'image/webp',
  ...AUDIO_TYPES,
};

export class App {
  constructor(config, { fetchImpl = fetch, WebSocketImpl, timers = true, logger } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers && !config.disableTimers;
    this.logger = logger || new Logger({ dir: config.logsDir, level: config.logLevel });
    this.log = this.logger.child('app');
    this.startedAt = new Date();
  }

  async init() {
    const c = this.config;
    for (const d of [c.dataDir, c.imagesDir, c.backupsDir, c.logsDir, c.audioDir]) mkdirSync(d, { recursive: true });

    this.db = new Database(c.dbPath);
    // Database di una versione più recente (es. dopo un ritorno a una versione
    // precedente senza ripristinare il backup pre-migrazione): avvio rifiutato
    // senza modificare nulla.
    try {
      this.db.assertSupportedSchema();
    } catch (e) {
      this.db.close();
      this.log.error('Avvio annullato: database non compatibile', { message: e.message });
      throw e;
    }
    const isNew = !this.db.get("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'");
    this.backups = null;
    // Prima di aggiornare lo schema di un database esistente ne salva una copia.
    this.preUpdate = null;
    if (!isNew && this.db.pendingMigrations().length) {
      const f = preMigrationBackup(this.db, c.backupsDir, this.db.schemaVersion());
      this.preUpdate = { file: join(c.backupsDir, f), fromSchema: this.db.schemaVersion() };
      this.log.info(`Backup di sicurezza prima dell'aggiornamento dello schema: ${f}`);
    }
    const applied = this.db.migrate();
    if (applied.length) this.log.info(`Migrazioni applicate: ${applied.join(', ')}${isNew ? ' (nuovo database)' : ''}`);
    this.seed();

    this.gameSettings = new SettingsStore(this.db, 'game_settings', { ...GAME_DEFAULTS, commands: COMMAND_GLOBAL_DEFAULTS });
    this.adminSettings = new SettingsStore(this.db, 'admin_settings', ADMIN_DEFAULTS);
    this.overlaySettings = new SettingsStore(this.db, 'overlay_settings', OVERLAY_DEFAULTS);
    this.themes = new ThemeStore({ db: this.db, overlaySettings: this.overlaySettings, log: this.logger.child('overlay') });
    this.themes.init();

    this.box = new SecretBox(loadSecretKey(join(c.dataDir, 'secret.key'), c.secretKey));
    this.auth = new AuthService({ db: this.db, dataDir: c.dataDir, log: this.logger.child('auth'), initialPassword: c.adminInitialPassword });
    const adminInit = await this.auth.ensureAdmin();
    if (adminInit.reset) {
      // Recupero accesso: rimuove anche l'eventuale hostname dedicato, che potrebbe essere la causa del blocco.
      this.adminSettings.set('security', { ...this.adminSettings.get('security'), adminHosts: [] });
    }

    // Sicurezza delle richieste: proxy fidati e controlli Host/Origin.
    this.proxy = new ProxyTrust({ spec: c.trustedProxies, log: this.logger.child('security') });
    await this.proxy.start();
    if (c.legacyTrustProxy !== undefined && c.legacyTrustProxy !== '') {
      this.log.warn('TRUST_PROXY non è più supportata e viene ignorata: usa TRUSTED_PROXIES con gli indirizzi dei proxy autorizzati');
    }
    if (this.proxy.enabled) this.log.info(`Proxy fidati: ${this.proxy.info().entries.join(', ')}`);
    const envAdminHosts = parseList(c.adminHosts);
    this.guard = new RequestGuard({
      getAdminHosts: () => (envAdminHosts.length ? envAdminHosts : this.adminSettings.get('security').adminHosts || []),
      allowedOrigins: parseList(c.allowedOrigins),
    });
    this.adminHostsFromEnv = envAdminHosts.length > 0;

    this.hub = new WsHub({
      authorizeAdmin: (req) => this.authorizeAdminSocket(req),
      log: this.logger.child('ws'),
      clientIp: (req) => this.clientIp(req),
      overlayLimits: c.wsOverlayLimits,
    });
    this.sm = new StateMachine({ db: this.db, log: this.logger.child('lifecycle') });
    this.engine = new GameEngine({ db: this.db, gameSettings: this.gameSettings, hub: this.hub, log: this.logger.child('game'), timers: this.timers, ...(this.rng ? { rng: this.rng } : {}) });
    // Classifiche: alimentate dalle catture del motore, riepilogo a fine sessione.
    this.leaderboard = new LeaderboardService({
      db: this.db, hub: this.hub, log: this.logger.child('classifiche'), timers: this.timers,
      currentSession: () => (['live', 'manual'].includes(this.engine.mode) && this.engine.session ? this.engine.sessions.byId(this.engine.session.id) : null),
    });
    this.engine.sessions.onClosed = (s) => this.leaderboard.onSessionClosed(s);
    this.engine.on('attempt', (res) => { if (res?.leaderboardEvent) this.leaderboard.onCapture(res.leaderboardEvent); });
    this.engine.on('revoked', ({ sessionId }) => this.leaderboard.changed(sessionId));
    // Effetti sonori per OBS: stessi eventi del motore, inviati solo al canale "audio".
    this.audio = new AudioService({ dir: c.audioDir, db: this.db, settings: this.adminSettings, hub: this.hub, log: this.logger.child('audio') });
    this.engine.on('spawn', (sp) => this.audio.onSpawn(sp));
    this.engine.on('attempt', (res) => this.audio.onAttempt(res));
    this.engine.recoverAfterRestart();
    this.commands = new CommandHandler({ db: this.db, commandGlobals: this.gameSettings, log: this.logger.child('commands'), leaderboard: this.leaderboard });

    this.credentials = new TwitchCredentials({ adminSettings: this.adminSettings, box: this.box });
    this.oauth = new TwitchOAuth({ config: c, credentials: this.credentials, log: this.logger.child('oauth'), fetchImpl: this.fetchImpl });
    this.helix = new Helix({ config: c, credentials: this.credentials, oauth: this.oauth, log: this.logger.child('helix'), fetchImpl: this.fetchImpl });
    this.chat = new ChatSender({ helix: this.helix, credentials: this.credentials, log: this.logger.child('chat'), getLimits: () => this.gameSettings.get('commands') });
    this.rewards = new RewardsService({ db: this.db, helix: this.helix, credentials: this.credentials, log: this.logger.child('rewards') });
    this.monitor = new TwitchMonitor({
      rewards: this.rewards,
      config: c, db: this.db, credentials: this.credentials, helix: this.helix, oauth: this.oauth, sm: this.sm,
      engine: this.engine, commands: this.commands, chat: this.chat, gameSettings: this.gameSettings, hub: this.hub,
      log: this.logger.child('twitch'), WebSocketImpl: this.WebSocketImpl, timers: this.timers,
    });
    // Messaggi automatici in chat: stessi eventi del motore, inviati dal ChatSender
    // esistente con l'account del bot (nessuna seconda connessione a Twitch).
    this.chatMessages = new ChatMessagesService({
      db: this.db, settings: this.adminSettings, chat: this.chat, credentials: this.credentials, log: this.logger.child('chat-auto'),
      twitch: () => {
        const m = this.monitor;
        return {
          configured: !!m?.configured(),
          connected: !!m?.eventsub?.connected && !m.transientIssue && this.sm.state !== STATES.ERROR,
          broadcasterError: !!this.credentials.authError('broadcaster'),
          credentialsUnreadable: !!this.credentials.unreadable()?.broadcaster,
        };
      },
    });
    this.engine.on('spawn', (sp) => this.chatMessages.onSpawn(sp));
    this.engine.on('attempt', (res) => this.chatMessages.onAttempt(res));
    this.engine.on('session', (e) => this.chatMessages.onSession(e));
    {
      const prev = this.engine.sessions.onClosed;
      this.engine.sessions.onClosed = (s) => {
        try { prev?.(s); } finally { setImmediate(() => { if (this.db?.db) this.chatMessages.onSessionClosed(s); }); }
      };
    }
    this.importer = new PokemonImporter({ db: this.db, config: c, log: this.logger.child('pokeapi'), fetchImpl: this.fetchImpl });
    this.importer.on('progress', (p) => this.hub.admin('import', p));
    this.backups = new BackupService({ db: this.db, config: c, adminSettings: this.adminSettings, log: this.logger.child('backup') });
    this.networkBackups = new NetworkBackupService({ db: () => this.db, config: c, adminSettings: this.adminSettings, log: this.logger.child('backup-rete'), version: c.version, timers: this.timers });
    this.scheduleUpdateBackup();

    this.simulator = new OverlaySimulator({
      db: this.db, hub: this.hub, engine: this.engine, sm: this.sm, log: this.logger.child('overlay'), timers: this.timers,
      channelLive: () => !!this.monitor?.channelLive(),
    });
    // Gioco che si attiva (diretta, ripresa, DEMO): via gli elementi simulati dagli overlay.
    this.sm.on('transition', ({ to }) => { if (to === STATES.LIVE || to === STATES.PAUSED) this.simulator.purge(`stato ${to}`); });
    this.engine.on('status', () => { if (this.engine.mode) this.simulator.purge(this.engine.mode === 'demo' ? 'DEMO' : 'diretta'); });
    this.hub.setSnapshot('overlay', () => ({ ...this.engine.overlaySnapshot(), settings: this.themes.effective(), leaderboard: this.leaderboard.overlayPayload() }));
    this.hub.setSnapshot('admin', () => this.liveStatus());
    this.hub.setSnapshot('audio', () => this.audio.snapshot());
    this.engine.on('status', () => this.hub.admin('status', this.liveStatus()));
    // Aggiorna dashboard e barra superiore anche per i cambi di stato Twitch (non solo del motore).
    this.sm.on('transition', () => setImmediate(() => { if (this.db?.db) this.hub.admin('status', this.liveStatus()); }));
    this.logger.listeners.add((e) => { if (e.level === 'warn' || e.level === 'error') this.hub.admin('log', e); });

    this.apiLimiter = new RateLimiter({ max: 600, windowMs: 60000 });
    this.loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60000 });
    // Limite per account indipendente dall'IP: protegge anche se l'IP venisse falsificato.
    this.loginFailLimiter = new RateLimiter({ max: 30, windowMs: 15 * 60000 });
    this.router = new Router();
    registerAuthRoutes(this);
    registerAdminRoutes(this);
    registerPublicRoutes(this);
    registerOverlayRoutes(this);
    registerGameRoutes(this);
    registerBackupRoutes(this);
    registerPokedexRoutes(this);
    registerLeaderboardRoutes(this);
    registerAudioRoutes(this);
    registerChatMessageRoutes(this);

    if (this.timers) { this.backups.startScheduler(); this.networkBackups.startScheduler(); }
    this.pruneTimer = setInterval(() => this.prune(), 6 * 3600 * 1000);
    this.pruneTimer.unref?.();
    return this;
  }

  seed() {
    for (const b of DEFAULT_BALLS) {
      this.db.run('INSERT OR IGNORE INTO ball_types (code, name, multiplier, guaranteed, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        b.code, b.name, b.multiplier, b.guaranteed, b.color, b.sort_order);
    }
    seedCommands(this.db);
  }

  prune() {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    this.db.run('DELETE FROM twitch_events WHERE received_at < ?', cutoff);
    this.db.run('DELETE FROM state_transitions WHERE created_at < ?', cutoff);
    this.db.run('DELETE FROM admin_sessions WHERE expires_at < ?', new Date().toISOString());
  }

  liveStatus() {
    const session = this.engine.session ? this.engine.sessions.byId(this.engine.session.id) : null;
    return {
      lifecycle: this.sm.snapshot(),
      engine: this.engine.status(),
      session,
      twitch: this.monitor.status(),
      ws: this.hub.counts(),
    };
  }

  // --- HTTP ------------------------------------------------------------------
  clientIp(req) {
    return this.proxy.clientIp(req);
  }

  secureRequest(req) {
    return this.config.secureCookies || this.proxy.isHttps(req);
  }

  // Sessione amministratore della richiesta, con i vincoli configurati.
  sessionFor(req, token, { websocket = false } = {}) {
    const sec = this.adminSettings.get('security');
    return this.auth.resolve(token, {
      userAgent: req.headers['user-agent'] || '',
      ip: !websocket && sec.bindSessionIp ? this.clientIp(req) : null,
      idleMs: Math.max(0, Number(sec.idleTimeoutH) || 0) * 3600 * 1000,
    });
  }

  // Autorizzazione del WebSocket admin: host ammesso, Origin obbligatorio e uguale
  // all'host della dashboard, sessione valida per questo browser.
  authorizeAdminSocket(req) {
    if (!this.guard.hostAllowed(req)) return { ok: false, status: 421, reason: 'host non ammesso' };
    if (!this.guard.originAllowed(req, { required: true })) {
      this.logger.child('security').warn('WebSocket admin rifiutato: origine non consentita', { origin: String(req.headers.origin || '(assente)').slice(0, 100) });
      return { ok: false, status: 403, reason: 'origine non consentita' };
    }
    const session = this.sessionFor(req, parseCookies(req.headers.cookie)[SESSION_COOKIE], { websocket: true });
    if (!session || session.mustChangePassword) return { ok: false, status: 401, reason: 'sessione non valida' };
    return { ok: true, session };
  }

  securityHeaders(res, { frame = 'SAMEORIGIN' } = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (frame) res.setHeader('X-Frame-Options', frame);
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https://raw.githubusercontent.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'self'");
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) return await this.handleApi(req, res, url);
      if (path === '/health') return this.health(res);
      return this.serveStatic(req, res, path);
    } catch (e) {
      if (!(e instanceof HttpError)) this.log.error('Errore non gestito', { path, message: e.message, stack: e.stack });
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Errore interno del server', details: e.details });
      else res.end();
    }
  }

  health(res) {
    let db = 'ok';
    try { this.db.get('SELECT 1'); } catch { db = 'error'; }
    sendJson(res, db === 'ok' ? 200 : 503, {
      status: db === 'ok' ? 'ok' : 'degraded', version: this.config.version, db, state: this.sm.state,
      engine: this.engine.running ? (this.engine.mode === 'demo' ? 'demo' : 'running') : 'stopped',
      uptimeS: Math.round(process.uptime()),
    });
  }

  async handleApi(req, res, url) {
    this.securityHeaders(res);
    const ip = this.clientIp(req);
    if (!this.apiLimiter.hit(ip)) throw new HttpError(429, 'Troppe richieste, riprova tra poco');
    const m = this.router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Endpoint non trovato');
    if (m.methodNotAllowed) throw new HttpError(405, 'Metodo non consentito');
    const { route, params } = m;
    const cookies = parseCookies(req.headers.cookie);
    const ctx = { req, res, url, params, query: url.searchParams, ip, cookies, session: null };
    const adminArea = url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/auth/');
    if (adminArea) {
      if (!this.guard.hostAllowed(req)) {
        throw new HttpError(421, 'La dashboard è raggiungibile solo dall\'hostname dedicato', { adminUrl: this.guard.dedicatedUrl(req) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !this.guard.originAllowed(req)) {
        this.logger.child('security').warn('Richiesta admin rifiutata: origine non consentita', { path: url.pathname, origin: String(req.headers.origin || '').slice(0, 100) });
        throw new HttpError(403, 'Origine della richiesta non consentita');
      }
    }
    if (!route.opts.public) {
      ctx.session = this.sessionFor(req, cookies[SESSION_COOKIE]);
      if (!ctx.session) throw new HttpError(401, 'Accesso richiesto');
      if (ctx.session.mustChangePassword && !route.opts.allowPasswordChange) throw new HttpError(403, 'Devi cambiare la password prima di continuare', { mustChangePassword: true });
      if (req.method !== 'GET' && !this.auth.checkCsrf(ctx.session, req.headers['x-csrf-token'])) throw new HttpError(403, 'Token CSRF non valido');
    }
    const out = await route.handler(ctx);
    if (res.writableEnded || res.headersSent) return;
    if (out && out.__httpStatus) sendJson(res, out.__httpStatus, out.body);
    else sendJson(res, 200, out ?? { ok: true });
  }

  serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const pub = this.adminSettings.get('publicPages');
    const page = (file, opts) => this.sendFile(req, res, join(this.config.publicDir, file), opts);
    if (path === '/' ) return pub.landing ? page('index.html') : page('disabled.html', { status: 404 });
    if (path === '/admin' || path.startsWith('/admin/')) {
      if (!this.guard.hostAllowed(req)) return this.misdirected(res, this.guard.dedicatedUrl(req));
      return page('admin/index.html', { noStore: true, frame: 'DENY' });
    }
    // Overlay OBS: una sola Browser Source per grafica ed effetti sonori.
    if (path === '/overlay' || path === '/overlay/') return page('overlay/index.html', { noStore: true, frame: null });
    // File audio: solo quelli della whitelist (ID opaco), mai un percorso.
    if (path.startsWith('/audio/')) {
      const m = /^\/audio\/([a-f0-9]{16})\.([a-z0-9]{2,4})$/.exec(path);
      const f = m ? this.audio.byId(m[1]) : null;
      if (!f || f.ext !== m[2]) return this.notFound(res);
      return this.sendFile(req, res, f.full, { cache: 'public, max-age=86400' });
    }
    if (path === '/leaderboard') return pub.leaderboard ? page('leaderboard.html') : page('disabled.html', { status: 404 });
    if (/^\/pokedex\/[A-Za-z0-9_]{1,25}\/?$/.test(path)) return pub.pokedex ? page('pokedex.html') : page('disabled.html', { status: 404 });
    if (path.startsWith('/images/')) {
      const name = path.slice(8);
      if (!/^[a-z0-9-]+\.png$/.test(name)) return this.notFound(res);
      return this.sendFile(req, res, join(this.config.imagesDir, name), { cache: 'public, max-age=604800' });
    }
    if (path.startsWith('/assets/') || path === '/favicon.svg') {
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
      const full = join(this.config.publicDir, safe);
      if (!full.startsWith(this.config.publicDir)) return this.notFound(res);
      return this.sendFile(req, res, full, { cache: 'no-cache' });
    }
    return this.notFound(res);
  }

  // Pagina mostrata aprendo la dashboard da un host diverso da quello dedicato.
  misdirected(res, url) {
    this.securityHeaders(res, { frame: 'DENY' });
    const safe = String(url || '').replace(/[^a-zA-Z0-9:/._-]/g, '');
    res.writeHead(421, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Live Catch</title><link rel="stylesheet" href="/assets/css/base.css"></head>`
      + `<body style="display:grid;place-items:center;min-height:100vh;font-family:system-ui"><div style="max-width:520px;padding:24px">`
      + `<h1>Indirizzo della dashboard</h1><p>Per sicurezza la dashboard di Live Catch è raggiungibile solo da un indirizzo dedicato.</p>`
      + `<p><a href="${safe}">${safe}</a></p><p style="opacity:.7">Overlay e pagine pubbliche restano disponibili anche da questo indirizzo.</p></div></body></html>`);
  }

  notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Pagina non trovata');
  }

  sendFile(req, res, file, { status = 200, noStore = false, cache = null, frame = 'SAMEORIGIN' } = {}) {
    if (!existsSync(file)) return this.notFound(res);
    const st = statSync(file);
    if (!st.isFile()) return this.notFound(res);
    this.securityHeaders(res, { frame });
    const lastMod = st.mtime.toUTCString();
    if (!noStore && status === 200 && req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304, { 'Last-Modified': lastMod, 'Cache-Control': cache || 'no-cache' });
      return res.end();
    }
    res.writeHead(status, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': noStore ? 'no-store' : cache || 'no-cache',
      ...(noStore ? {} : { 'Last-Modified': lastMod }),
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  listen(port = this.config.port, host = this.config.host) {
    this.server = createServer((req, res) => { this.handle(req, res); });
    this.server.on('upgrade', (req, socket, head) => this.hub.handleUpgrade(req, socket, head));
    return new Promise((resolve) => this.server.listen(port, host, () => {
      this.log.info(`Live Catch ${this.config.version} in ascolto su http://${host}:${this.server.address().port}`);
      resolve(this.server.address().port);
    }));
  }

  async startServices() {
    await this.monitor.start();
  }

  // Aggiornamento dell'app (nuova versione o nuove migrazioni): se richiesto, copia
  // anche sulla cartella di rete il backup fatto prima dell'aggiornamento. Non blocca
  // l'avvio: la copia locale "pre-migration" esiste comunque.
  scheduleUpdateBackup() {
    const prev = this.adminSettings.get('lastAppVersion');
    const version = this.config.version;
    this.adminSettings.set('lastAppVersion', version);
    const conf = this.networkBackups.conf();
    if (!conf.enabled || !conf.beforeUpdate) return;
    if (!this.preUpdate && (!prev || prev === version)) return;
    const note = prev ? `prima dell'aggiornamento da v${prev}` : 'prima dell\'aggiornamento dello schema';
    const job = this.preUpdate
      ? this.networkBackups.copyLocal(this.preUpdate.file, 'pre-update', prev ? `${note} v${prev}` : note)
      : this.networkBackups.create('pre-update', { note });
    this.pendingUpdateBackup = job.then(
      (r) => this.log.info(`Backup prima dell'aggiornamento salvato sulla cartella di rete: ${r.file}`),
      (e) => this.log.warn('Backup prima dell\'aggiornamento non salvato sulla cartella di rete', { message: e.message }),
    );
  }

  // Ripristino di un backup locale (cartella backups/).
  async restore(name, { admin = null, keepSessionOf = null } = {}) {
    const raw = this.backups.readVerified(name);
    return this.restoreRaw(raw, { label: name, source: 'local', admin, keepSessionOf });
  }

  // Ripristino da un database già verificato (backup locale o di rete).
  // 1. rifiuta durante una diretta; ferma in modo controllato sessione manuale/DEMO;
  // 2. backup di sicurezza dello stato attuale (locale, non dipende dalla rete);
  // 3. ferma monitor e motore, chiude il DB (checkpoint del WAL), sostituisce il file;
  // 4. riapre, migra e verifica; in caso di errore torna automaticamente allo stato
  //    precedente (copia "before-restore", poi il backup di sicurezza);
  // 5. conserva la sessione dell'amministratore e le impostazioni della cartella di rete.
  async restoreRaw(raw, { label, source = 'local', admin = null, keepSessionOf = null } = {}) {
    if ([STATES.LIVE, STATES.PAUSED].includes(this.sm.state) || this.engine.mode === 'live') {
      throw new HttpError(409, 'Non è possibile ripristinare un backup durante una diretta Twitch: attendi la fine della diretta');
    }
    if (this.restoring) throw new HttpError(409, 'Un ripristino è già in corso');
    this.restoring = true;
    try {
      this.backups.verifySqlite(raw);
      const stopped = [];
      if (this.engine.mode === 'manual') { stopped.push(this.engine.stopManual('restore', { admin })?.id); }
      if (this.engine.mode === 'demo') { this.engine.stopDemo('restore'); stopped.push('demo'); }
      const safety = this.backups.create('pre-restore', `prima del ripristino di ${label}`);
      // Dati da conservare attraverso il ripristino.
      const keep = {
        networkBackup: this.adminSettings.get('networkBackup'),
        networkBackupState: this.adminSettings.get('networkBackupState'),
        lastAppVersion: this.adminSettings.get('lastAppVersion'),
        session: keepSessionOf ? this.db.get(
          `SELECT s.token_hash, s.csrf_token, s.created_at, s.expires_at, s.ip, s.user_agent, s.last_seen_at, u.username
           FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id WHERE s.id = ?`, keepSessionOf) : null,
      };
      const staged = this.backups.stage(raw);
      this.monitor.stop();
      this.engine.shutdown();
      this.db.close();
      let rolledBack = null;
      try {
        this.backups.swapInStaged(staged);
        this.db.open();
        if (!this.db.integrityCheck()) throw new Error('il database ripristinato non supera il controllo di integrità');
        this.db.migrate();
        this.seed();
        this.themes.init();
      } catch (e) {
        this.log.error('Ripristino non riuscito: ritorno allo stato precedente', { message: e.message });
        try { this.db.close(); } catch { /* già chiuso */ }
        rolledBack = this.backups.rollbackSwap(safety.filename);
        this.db.open();
        this.db.migrate();
        this.seed();
        this.themes.init();
        this.afterDbSwap();
        audit(this.db, { admin, action: 'restore_failed', targetType: 'backup', targetId: label, detail: { source, error: e.message, rolledBackFrom: rolledBack } }, this.log);
        throw new HttpError(500, `Ripristino non riuscito (${e.message}). I dati precedenti sono stati ripristinati automaticamente (${rolledBack}).`);
      }
      for (const k of ['networkBackup', 'networkBackupState', 'lastAppVersion']) if (keep[k] !== undefined) this.adminSettings.set(k, keep[k]);
      if (keep.session) {
        const u = this.db.get('SELECT id FROM admin_users WHERE username = ?', keep.session.username);
        if (u) {
          this.db.run(`INSERT OR IGNORE INTO admin_sessions (token_hash, csrf_token, admin_user_id, created_at, expires_at, ip, user_agent, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, keep.session.token_hash, keep.session.csrf_token, u.id, keep.session.created_at,
          keep.session.expires_at, keep.session.ip, keep.session.user_agent, keep.session.last_seen_at);
        }
      }
      this.afterDbSwap();
      audit(this.db, { admin, action: 'restore', targetType: 'backup', targetId: label, detail: { source, safetyBackup: safety.filename, stoppedSessions: stopped, schema: this.db.schemaVersion() } }, this.log);
      this.log.info(`Backup ripristinato: ${label}`, { source, safety: safety.filename });
      return { restored: label, source, safetyBackup: safety.filename, schemaVersion: this.db.schemaVersion(), integrity: this.db.integrityCheck(), stoppedSessions: stopped };
    } finally {
      this.restoring = false;
    }
  }

  afterDbSwap() {
    this.hub.overlay('settings', this.themes.effective());
    this.engine.session = null;
    this.engine.mode = null;
    this.engine.suspended = false;
    this.engine.recoverAfterRestart('restore');
    this.engine.emitStatus();
    this.leaderboard.pushOverlay(); // schermata classifica come salvata nel backup ripristinato
    this.monitor.start().catch(() => {});
  }

  async close() {
    clearInterval(this.pruneTimer);
    this.proxy?.stop();
    this.monitor?.stop();
    this.engine?.shutdown();
    this.leaderboard?.shutdown();
    this.chatMessages?.close();
    this.simulator?.stop();
    this.backups?.stop();
    this.networkBackups?.stop();
    this.hub?.close();
    if (this.server) await new Promise((r) => { this.server.closeAllConnections?.(); this.server.close(() => r()); });
    this.db?.close();
  }
}
