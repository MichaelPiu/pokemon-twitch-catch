// Libreria condivisa frontend: DOM builder, client API, WebSocket, formattazione.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined || sv === null) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
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
    err.path = path;
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
  common: { label: 'Comune', color: '#9ca3af' },
  uncommon: { label: 'Non comune', color: '#22c55e' },
  rare: { label: 'Raro', color: '#a78bfa' },
  epic: { label: 'Epico', color: '#e879f9' },
  legendary: { label: 'Leggendario', color: '#fbbf24' },
  mythical: { label: 'Mitico', color: '#f472b6' },
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

// Grafico a barre SVG (nessuna dipendenza esterna). Barre a larghezza limitata, proporzioni fisse.
export function barChart(data, { key = 'value', label = 'label', height = 200, color = '#a855f7', secondary = null, secondaryColor = '#22c55e' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 760, H = height, L = 34, R = 10, T = 12, B = 24;
  const max = Math.max(1, ...data.map((d) => Math.max(d[key] || 0, secondary ? d[secondary] || 0 : 0)));
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  const y = (v) => T + (1 - v / max) * (H - T - B);
  for (const v of [0, max / 2, max]) {
    svg.appendChild(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'rgba(255,255,255,0.07)' }));
    svg.appendChild(el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-label' }, Math.round(v)));
  }
  const slot = (W - L - R) / Math.max(1, data.length);
  const group = Math.min(64, slot * 0.7);
  const bars = secondary ? 2 : 1;
  const bw = group / bars;
  data.forEach((d, i) => {
    const x0 = L + i * slot + (slot - group) / 2;
    [[d[key], color], ...(secondary ? [[d[secondary], secondaryColor]] : [])].forEach(([val, c], j) => {
      const r = el('rect', { x: x0 + j * bw, y: y(val || 0), width: Math.max(2, bw - 2), height: Math.max(0, y(0) - y(val || 0)), rx: 4, fill: c });
      r.appendChild(el('title', {}, `${d[label]}: ${val || 0}`));
      svg.appendChild(r);
    });
    if (data.length <= 16 || i % Math.ceil(data.length / 12) === 0) {
      svg.appendChild(el('text', { x: L + i * slot + slot / 2, y: H - 6, 'text-anchor': 'middle', class: 'chart-label' }, String(d[label]).slice(-5)));
    }
  });
  return svg;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Colori dei tipi (chip nella dashboard).
export const TYPE_COLOR = {
  normal: '#9fa19f', fire: '#e8562a', water: '#3d8ef0', grass: '#4caf50', electric: '#f2c12e', ice: '#5fd3e6', fighting: '#e07b39',
  poison: '#9b59d0', ground: '#b98a4a', flying: '#7fa7e8', psychic: '#ec5f8a', bug: '#93b52a', rock: '#b5a265', ghost: '#7a5ca8',
  dragon: '#5767e0', dark: '#5b4c47', steel: '#6f9bb0', fairy: '#ee8fe0',
};

// Grafico a linee con aree sfumate (SVG). series: [{ key, label, color }], points: [{ t, ...valori }]
export function lineChart(points, series, { height = 220, yTicks = 5 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 640, H = height, L = 34, R = 26, T = 10, B = 26;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'line-chart');
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const rawMax = Math.max(1, ...points.flatMap((p) => series.map((s) => p[s.key] || 0)));
  const stepY = niceStep(rawMax / yTicks);
  const max = Math.ceil(rawMax / stepY) * stepY;
  const x = (i) => L + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const defs = el('defs', {});
  svg.appendChild(defs);
  for (let v = 0; v <= max + 1e-9; v += stepY) {
    svg.appendChild(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
    const t = el('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' });
    t.textContent = Math.round(v);
    svg.appendChild(t);
  }
  const nLabels = Math.min(7, points.length);
  for (let k = 0; k < nLabels; k++) {
    const i = nLabels <= 1 ? 0 : Math.round((k / (nLabels - 1)) * (points.length - 1));
    const t = el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'axis' });
    t.textContent = new Date(points[i].t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    svg.appendChild(t);
  }
  series.forEach((s, si) => {
    const pts = points.map((p, i) => [x(i), y(p[s.key] || 0)]);
    if (!pts.length) return;
    const d = smoothPath(pts);
    const gid = `g${si}${Math.random().toString(36).slice(2, 7)}`;
    const g = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(el('stop', { offset: '0', 'stop-color': s.color, 'stop-opacity': '0.35' }));
    g.appendChild(el('stop', { offset: '1', 'stop-color': s.color, 'stop-opacity': '0' }));
    defs.appendChild(g);
    svg.appendChild(el('path', { d: `${d} L${pts.at(-1)[0]},${y(0)} L${pts[0][0]},${y(0)} Z`, fill: `url(#${gid})` }));
    svg.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 3, 'stroke-linecap': 'round', class: 'line' }));
    const last = pts.at(-1);
    svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 4, fill: s.color }));
  });
  return svg;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// Curva morbida (Catmull-Rom → Bézier) senza superare i valori reali.
function smoothPath(pts) {
  if (pts.length < 2) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    // Limita i punti di controllo per evitare "rimbalzi" sopra/sotto i dati.
    const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
    c1[1] = Math.min(hi, Math.max(lo, c1[1]));
    c2[1] = Math.min(hi, Math.max(lo, c2[1]));
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}
