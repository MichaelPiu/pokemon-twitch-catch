// Configurazione di processo letta dalle variabili d'ambiente.
// Le impostazioni di gioco vivono nel database e si modificano dalla dashboard.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

function int(v, def) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env = process.env) {
  const dataDir = resolve(env.DATA_DIR || resolve(root, 'data'));
  return {
    version: pkg.version,
    rootDir: root,
    publicDir: resolve(root, 'public'),
    dataDir,
    dbPath: resolve(dataDir, 'db', 'livecatch.sqlite'),
    imagesDir: resolve(dataDir, 'images'),
    backupsDir: resolve(dataDir, 'backups'),
    logsDir: resolve(dataDir, 'logs'),
    port: int(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    // Password iniziale dell'amministratore (su Umbrel: ${APP_PASSWORD}).
    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD || env.ADMIN_PASSWORD || '',
    // Chiave di cifratura opzionale; se assente viene generata in DATA_DIR/secret.key.
    secretKey: env.APP_SECRET_KEY || '',
    // Endpoint Twitch (sovrascrivibili solo per i test automatici).
    twitch: {
      helixBase: env.TWITCH_HELIX_BASE || 'https://api.twitch.tv/helix',
      oauthBase: env.TWITCH_OAUTH_BASE || 'https://id.twitch.tv/oauth2',
      eventsubUrl: env.TWITCH_EVENTSUB_URL || 'wss://eventsub.wss.twitch.tv/ws',
      backoffMs: int(env.TWITCH_EVENTSUB_BACKOFF_MS, 1000),
    },
    pokeapiBase: env.POKEAPI_BASE || 'https://pokeapi.co/api/v2',
    // Se "true" i cookie di sessione vengono marcati Secure (solo dietro HTTPS).
    secureCookies: env.SECURE_COOKIES === 'true',
    // Proxy autorizzati a inoltrare X-Forwarded-For / X-Forwarded-Proto (vedi src/security/proxy.js).
    // Vuoto = nessun proxy fidato: l'IP del client è sempre quello reale del socket.
    trustedProxies: env.TRUSTED_PROXIES || '',
    legacyTrustProxy: env.TRUST_PROXY, // non più usata: solo per avvisare nei log
    // Hostname dedicati alla dashboard (separati da virgola). Se valorizzato ha la
    // precedenza sull'impostazione salvata nella dashboard.
    adminHosts: env.ADMIN_HOSTS || '',
    // Origini aggiuntive ammesse per la dashboard (es. https://livecatch.example.lan).
    allowedOrigins: env.ALLOWED_ORIGINS || '',
    logLevel: env.LOG_LEVEL || 'info',
    disableTimers: env.DISABLE_TIMERS === 'true',
  };
}
