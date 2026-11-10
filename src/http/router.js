// Router HTTP minimale con parsing JSON, cookie e gestione errori uniforme.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Cookie della richiesta. Un valore con codifica percentuale non valida (es.
// lasciato da un'altra app sullo stesso host, come umbrel.local) viene ignorato:
// non deve mai bloccare le API o le connessioni WebSocket.
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie malformato: ignorato */ }
  }
  return out;
}

export async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Richiesta troppo grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object') throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'JSON non valido');
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch { throw new HttpError(400, 'Indirizzo non valido'); }
      });
      return { route: r, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

// --- Validazione input -----------------------------------------------------
export const v = {
  num(val, { min = -Infinity, max = Infinity, int = false, name = 'valore' } = {}) {
    const n = Number(val);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
      throw new HttpError(400, `${name} non valido (atteso ${int ? 'intero' : 'numero'} tra ${min} e ${max})`);
    }
    return n;
  },
  str(val, { min = 0, max = 500, name = 'testo', pattern = null } = {}) {
    if (typeof val !== 'string') throw new HttpError(400, `${name} deve essere un testo`);
    const s = val.trim();
    if (s.length < min || s.length > max) throw new HttpError(400, `${name}: lunghezza tra ${min} e ${max} caratteri`);
    if (pattern && !pattern.test(s)) throw new HttpError(400, `${name} non valido`);
    return s;
  },
  bool(val) { return val === true || val === 1 || val === '1' || val === 'true'; },
  oneOf(val, list, name = 'valore') {
    if (!list.includes(val)) throw new HttpError(400, `${name} non valido`);
    return val;
  },
  color(val, name = 'colore') {
    return v.str(val, { max: 64, name, pattern: /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/ });
  },
};
