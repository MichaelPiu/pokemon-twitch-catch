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
import { BackupService } from './backup/backup.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerPublicRoutes } from './api/public.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.webp': 'image/webp',
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
    for (const d of [c.dataDir, c.imagesDir, c.backupsDir, c.logsDir]) mkdirSync(d, { recursive: true });

    this.db = new Database(c.dbPath);
    const isNew = !this.db.get("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'");
    this.backups = null;
    const applied = this.db.migrate();
    if (applied.length) this.log.info(`Migrazioni applicate: ${applied.join(', ')}${isNew ? ' (nuovo database)' : ''}`);
    this.seed();

    this.gameSettings = new SettingsStore(this.db, 'game_settings', { ...GAME_DEFAULTS, commands: COMMAND_GLOBAL_DEFAULTS });
    this.adminSettings = new SettingsStore(this.db, 'admin_settings', ADMIN_DEFAULTS);
    this.overlaySettings = new SettingsStore(this.db, 'overlay_settings', OVERLAY_DEFAULTS);

    this.box = new SecretBox(loadSecretKey(join(c.dataDir, 'secret.key'), c.secretKey));
    this.auth = new AuthService({ db: this.db, dataDir: c.dataDir, log: this.logger.child('auth'), initialPassword: c.adminInitialPassword });
    await this.auth.ensureAdmin();

    this.hub = new WsHub({ auth: this.auth, log: this.logger.child('ws') });
    this.sm = new StateMachine({ db: this.db, log: this.logger.child('lifecycle') });
    this.engine = new GameEngine({ db: this.db, gameSettings: this.gameSettings, hub: this.hub, log: this.logger.child('game'), timers: this.timers, ...(this.rng ? { rng: this.rng } : {}) });
    this.engine.recoverAfterRestart();
    this.commands = new CommandHandler({ db: this.db, commandGlobals: this.gameSettings, log: this.logger.child('commands') });

    this.credentials = new TwitchCredentials({ adminSettings: this.adminSettings, box: this.box });
    this.oauth = new TwitchOAuth({ config: c, credentials: this.credentials, log: this.logger.child('oauth'), fetchImpl: this.fetchImpl });
    this.helix = new Helix({ config: c, credentials: this.credentials, oauth: this.oauth, log: this.logger.child('helix'), fetchImpl: this.fetchImpl });
    this.chat = new ChatSender({ helix: this.helix, credentials: this.credentials, log: this.logger.child('chat'), getLimits: () => this.gameSettings.get('commands') });
    this.rewards = new RewardsService({ db: this.db, helix: this.helix, credentials: this.credentials, log: this.logger.child('rewards') });
    this.monitor = new TwitchMonitor({
      config: c, db: this.db, credentials: this.credentials, helix: this.helix, oauth: this.oauth, sm: this.sm,
      engine: this.engine, commands: this.commands, chat: this.chat, gameSettings: this.gameSettings, hub: this.hub,
      log: this.logger.child('twitch'), WebSocketImpl: this.WebSocketImpl, timers: this.timers,
    });
    this.importer = new PokemonImporter({ db: this.db, config: c, log: this.logger.child('pokeapi'), fetchImpl: this.fetchImpl });
    this.importer.on('progress', (p) => this.hub.admin('import', p));
    this.backups = new BackupService({ db: this.db, config: c, adminSettings: this.adminSettings, log: this.logger.child('backup') });

    this.hub.setSnapshot('overlay', () => ({ ...this.engine.overlaySnapshot(), settings: this.overlaySettings.all() }));
    this.hub.setSnapshot('admin', () => this.liveStatus());
    this.engine.on('status', () => this.hub.admin('status', this.liveStatus()));
    // Aggiorna dashboard e barra superiore anche per i cambi di stato Twitch (non solo del motore).
    this.sm.on('transition', () => setImmediate(() => { if (this.db?.db) this.hub.admin('status', this.liveStatus()); }));
    this.logger.listeners.add((e) => { if (e.level === 'warn' || e.level === 'error') this.hub.admin('log', e); });

    this.apiLimiter = new RateLimiter({ max: 600, windowMs: 60000 });
    this.loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60000 });
    this.router = new Router();
    registerAuthRoutes(this);
    registerAdminRoutes(this);
    registerPublicRoutes(this);

    if (this.timers) this.backups.startScheduler();
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
    if (this.config.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) return String(xf).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
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
    if (!route.opts.public) {
      ctx.session = this.auth.resolve(cookies[SESSION_COOKIE]);
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
    if (path === '/admin' || path.startsWith('/admin/')) return page('admin/index.html', { noStore: true, frame: 'DENY' });
    if (path === '/overlay' || path === '/overlay/') return page('overlay/index.html', { noStore: true, frame: null });
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

  // Ripristino di un backup: arresta i servizi, sostituisce il DB, riparte.
  async restore(name) {
    if ([STATES.LIVE, STATES.PAUSED].includes(this.sm.state)) throw new HttpError(409, 'Non è possibile ripristinare un backup durante una diretta');
    if (this.engine.mode === 'demo') this.engine.stopDemo('restore');
    const { staged, safety } = this.backups.restoreFile(name);
    this.monitor.stop();
    this.engine.shutdown();
    this.db.close();
    try {
      this.backups.swapInStaged(staged);
    } finally {
      this.db.open();
      this.db.migrate();
      this.seed();
    }
    this.engine.session = null;
    this.engine.mode = null;
    this.engine.recoverAfterRestart();
    this.log.info(`Backup ripristinato: ${name}`);
    this.monitor.start().catch(() => {});
    return { restored: name, safetyBackup: safety };
  }

  async close() {
    clearInterval(this.pruneTimer);
    this.monitor?.stop();
    this.engine?.shutdown();
    this.backups?.stop();
    this.hub?.close();
    if (this.server) await new Promise((r) => { this.server.closeAllConnections?.(); this.server.close(() => r()); });
    this.db?.close();
  }
}
