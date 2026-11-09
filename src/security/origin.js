// Controlli su Host e Origin per l'area amministrativa (HTTP e WebSocket).
//
// - Host: se è configurato un hostname amministrativo dedicato (ADMIN_HOSTS o
//   Impostazioni → Sicurezza) la dashboard, le API admin e il WebSocket admin
//   rispondono SOLO su quel nome. Così il cookie di sessione viene creato solo per
//   quell'host e il browser non lo invia alle altre app servite su umbrel.local
//   (i cookie non sono isolati per porta).
// - Origin: le richieste del browser che modificano dati e le connessioni al
//   WebSocket admin devono provenire dalla stessa origine della dashboard
//   (Origin == Host) o da un'origine elencata in ALLOWED_ORIGINS.
//   Il gateway di umbrelOS non riscrive l'header Host (changeOrigin: false),
//   quindi il confronto funziona anche dietro al proxy.

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function parseHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  let hostname = raw;
  let port = '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    hostname = raw.slice(1, end);
    port = raw.slice(end + 1).replace(/^:/, '');
  } else if (raw.includes(':')) {
    const i = raw.lastIndexOf(':');
    hostname = raw.slice(0, i);
    port = raw.slice(i + 1);
  }
  if (port && !/^\d{1,5}$/.test(port)) return null;
  if (!hostname) return null;
  return { hostname, port, host: port ? `${raw.startsWith('[') ? `[${hostname}]` : hostname}:${port}` : hostname };
}

export function validHostname(h) {
  const s = String(h || '').trim().toLowerCase();
  return HOSTNAME_RE.test(s) || IPV4_RE.test(s);
}

export function parseList(value) {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export class RequestGuard {
  // getAdminHosts: () => string[] (hostname senza porta)
  constructor({ getAdminHosts = () => [], allowedOrigins = [] } = {}) {
    this.getAdminHosts = getAdminHosts;
    this.allowedOrigins = new Set(allowedOrigins.map((o) => o.replace(/\/+$/, '').toLowerCase()));
  }

  adminHosts() { return (this.getAdminHosts() || []).map((h) => String(h).toLowerCase()); }

  // L'host della richiesta è ammesso per l'area amministrativa?
  hostAllowed(req) {
    const h = parseHost(req.headers.host);
    if (!h) return false;
    const list = this.adminHosts();
    if (!list.length) return true;
    return list.includes(h.hostname);
  }

  // L'origine dichiarata dal browser è quella della dashboard?
  // required=true: un Origin mancante viene rifiutato (WebSocket: i browser lo inviano sempre).
  originAllowed(req, { required = false } = {}) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') {
      if (required || origin === 'null') return false;
      // Nessun Origin: richiesta non proveniente da un browser moderno (es. curl).
      // Resta comunque obbligatorio il token CSRF. Un browser che dichiara
      // "cross-site" viene rifiutato.
      return String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site';
    }
    let o;
    try { o = new URL(origin); } catch { return false; }
    const normalized = `${o.protocol}//${o.host}`.toLowerCase();
    if (this.allowedOrigins.has(normalized)) return true;
    const h = parseHost(req.headers.host);
    if (!h) return false;
    if (o.host.toLowerCase() !== h.host) return false;
    const list = this.adminHosts();
    return !list.length || list.includes(o.hostname.toLowerCase());
  }

  // URL della dashboard sull'hostname dedicato (mantiene la porta usata ora).
  dedicatedUrl(req, path = '/admin/') {
    const list = this.adminHosts();
    if (!list.length) return null;
    const h = parseHost(req.headers.host);
    const port = h?.port ? `:${h.port}` : '';
    return `http://${list[0]}${port}${path}`;
  }
}
