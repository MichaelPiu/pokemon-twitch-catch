// Libreria condivisa frontend: DOM builder, client API, WebSocket, formattazione.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // usato solo con contenuti statici interni
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

let csrf = null;
export function setCsrf(t) { csrf = t; }

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function api(method, path, body, { raw = false } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (csrf && method !== 'GET') opts.headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(path, opts);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* vuoto */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error || `Errore ${res.status}`, data?.details);
    window.dispatchEvent(new CustomEvent('api-error', { detail: err }));
    throw err;
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

// WebSocket con riconnessione automatica.
export function connectWs(path, onMessage, { onState } = {}) {
  let ws, timer, closed = false, attempt = 0;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}${path}`);
    ws.onopen = () => { attempt = 0; onState?.(true); };
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); onMessage(m.type, m.data); } catch { /* ignora */ } };
    ws.onclose = () => {
      onState?.(false);
      if (closed) return;
      timer = setTimeout(open, Math.min(15000, 1000 * 2 ** attempt++));
    };
  };
  open();
  return { close() { closed = true; clearTimeout(timer); ws?.close(); } };
}

// --- Formattazione --------------------------------------------------------------
export const RARITY = {
  common: { label: 'Comune', color: '#9aa3b5' },
  uncommon: { label: 'Non comune', color: '#4cc38a' },
  rare: { label: 'Raro', color: '#4b8dff' },
  epic: { label: 'Epico', color: '#b366ff' },
  legendary: { label: 'Leggendario', color: '#ffb020' },
  mythical: { label: 'Mitico', color: '#ff5fa2' },
};
export const RARITY_KEYS = Object.keys(RARITY);

export const TYPE_IT = {
  normal: 'Normale', fire: 'Fuoco', water: 'Acqua', grass: 'Erba', electric: 'Elettro', ice: 'Ghiaccio', fighting: 'Lotta',
  poison: 'Veleno', ground: 'Terra', flying: 'Volante', psychic: 'Psico', bug: 'Coleottero', rock: 'Roccia', ghost: 'Spettro',
  dragon: 'Drago', dark: 'Buio', steel: 'Acciaio', fairy: 'Folletto', stellar: 'Astrale', unknown: '???',
};

export function rarityBadge(r) {
  const x = RARITY[r] || { label: r, color: '#999' };
  return h('span', { class: 'badge', style: { '--c': x.color } }, x.label);
}

export const fmt = {
  n: (x) => (x ?? 0).toLocaleString('it-IT'),
  pct: (x) => `${((x || 0) * 100).toFixed(1)}%`,
  dt: (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—'),
  date: (iso) => (iso ? new Date(iso).toLocaleDateString('it-IT') : '—'),
  time: (iso) => (iso ? new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—'),
  dur: (s) => {
    if (s == null) return '—';
    s = Math.max(0, Math.round(s));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m ${String(ss).padStart(2, '0')}s`;
  },
  bytes: (b) => {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  dex: (n) => `#${String(n ?? 0).padStart(4, '0')}`,
  ago: (iso) => {
    if (!iso) return '—';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'adesso';
    if (s < 3600) return `${Math.floor(s / 60)} min fa`;
    if (s < 86400) return `${Math.floor(s / 3600)} h fa`;
    return `${Math.floor(s / 86400)} g fa`;
  },
};

// Grafico a barre SVG (nessuna dipendenza esterna).
export function barChart(data, { key = 'value', label = 'label', height = 180, color = 'var(--accent)', secondary = null, secondaryColor = 'var(--primary)' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = Math.max(300, data.length * 28), H = height, pad = 22;
  const max = Math.max(1, ...data.map((d) => Math.max(d[key] || 0, secondary ? d[secondary] || 0 : 0)));
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('preserveAspectRatio', 'none');
  const bw = (W - pad) / Math.max(1, data.length);
  data.forEach((d, i) => {
    const mk = (val, c, off, w) => {
      const bh = ((val || 0) / max) * (H - pad - 6);
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', pad + i * bw + off);
      r.setAttribute('y', H - pad - bh);
      r.setAttribute('width', w);
      r.setAttribute('height', Math.max(0, bh));
      r.setAttribute('rx', 3);
      r.setAttribute('fill', c);
      const t = document.createElementNS(ns, 'title');
      t.textContent = `${d[label]}: ${val || 0}`;
      r.appendChild(t);
      svg.appendChild(r);
    };
    const w = Math.max(2, bw * 0.7);
    if (secondary) { mk(d[key], color, bw * 0.15, w / 2); mk(d[secondary], secondaryColor, bw * 0.15 + w / 2, w / 2); }
    else mk(d[key], color, bw * 0.15, w);
    if (data.length <= 16 || i % Math.ceil(data.length / 12) === 0) {
      const tx = document.createElementNS(ns, 'text');
      tx.setAttribute('x', pad + i * bw + bw / 2);
      tx.setAttribute('y', H - 6);
      tx.setAttribute('text-anchor', 'middle');
      tx.setAttribute('class', 'chart-label');
      tx.textContent = String(d[label]).slice(-5);
      svg.appendChild(tx);
    }
  });
  const ax = document.createElementNS(ns, 'text');
  ax.setAttribute('x', 2); ax.setAttribute('y', 12); ax.setAttribute('class', 'chart-label');
  ax.textContent = String(max);
  svg.appendChild(ax);
  return svg;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
