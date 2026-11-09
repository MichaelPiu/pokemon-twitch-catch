// Dashboard amministrativa unica: login, cambio password obbligatorio, sidebar, routing.
import { h, mount, get, post, setCsrf, connectWs, fmt } from '../lib.js';
import { toast } from './ui.js';
import { pages } from './pages/index.js';

const root = document.getElementById('root');
export const store = { me: null, status: null, listeners: new Set(), ws: null };

export function onLive(fn) { store.listeners.add(fn); return () => store.listeners.delete(fn); }

const NAV = [
  ['overview', '🏠', 'Panoramica'],
  ['stats', '📊', 'Statistiche'],
  ['sessions', '🎬', 'Storico dirette'],
  ['users', '👥', 'Spettatori & Pokédex'],
  null,
  ['spawn', '✨', 'Gestione spawn'],
  ['pokemon', '📚', 'Pokémon'],
  ['balls', '🎯', 'Poké Ball'],
  ['commands', '💬', 'Comandi chat'],
  ['overlay', '🖼️', 'Overlay OBS'],
  null,
  ['twitch', '📡', 'Twitch'],
  ['demo', '🧪', 'Modalità DEMO'],
  ['system', '🛠️', 'Backup & Sistema'],
];

window.addEventListener('api-error', (e) => {
  if (e.detail.status === 401) showLogin();
  else if (e.detail.status === 403 && e.detail.details?.mustChangePassword) showChangePassword(true);
});

async function boot() {
  try {
    const me = await get('/api/auth/me');
    store.me = me;
    setCsrf(me.csrf);
    if (me.mustChangePassword) return showChangePassword(true);
    showApp();
  } catch {
    showLogin();
  }
}

function brand() {
  return h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, 'Live Catch', h('small', {}, 'Dashboard amministrativa')));
}

function showLogin() {
  store.ws?.close();
  const err = h('div', { class: 'notice err hidden' });
  const user = h('input', { name: 'username', value: 'admin', autocomplete: 'username', required: true });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        const r = await post('/api/auth/login', { username: user.value, password: pass.value });
        setCsrf(r.csrf);
        store.me = r;
        if (r.mustChangePassword) showChangePassword(true);
        else showApp();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    },
  },
  h('label', { class: 'field' }, 'Utente', user),
  h('label', { class: 'field' }, 'Password', pass),
  err,
  h('button', { class: 'btn primary', type: 'submit' }, 'Accedi'),
  h('p', { class: 'muted small' }, 'Primo accesso su Umbrel: usa la password mostrata nella scheda dell\'app (icona ⓘ → credenziali).'));
  mount(root, h('div', { class: 'login-wrap' }, h('div', { class: 'card login' }, brand(), form)));
}

export function showChangePassword(forced) {
  const err = h('div', { class: 'notice err hidden' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      if (n1.value !== n2.value) { err.textContent = 'Le password non coincidono'; err.classList.remove('hidden'); return; }
      try {
        await post('/api/auth/change-password', { currentPassword: cur.value, newPassword: n1.value });
        toast('Password aggiornata', 'ok');
        const me = await get('/api/auth/me');
        store.me = me; setCsrf(me.csrf);
        showApp();
      } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    },
  },
  forced ? h('div', { class: 'notice' }, 'Per sicurezza devi scegliere una nuova password personale prima di usare la dashboard.') : null,
  h('label', { class: 'field' }, 'Password attuale', cur),
  h('label', { class: 'field' }, 'Nuova password (min. 10 caratteri, lettere e numeri)', n1),
  h('label', { class: 'field' }, 'Ripeti nuova password', n2),
  err,
  h('button', { class: 'btn primary', type: 'submit' }, 'Salva nuova password'));
  mount(root, h('div', { class: 'login-wrap' }, h('div', { class: 'card login' }, brand(), h('h2', {}, 'Cambio password'), form)));
}

let mainEl, navEl, sideStatus, sidebar, cleanup = null;

function showApp() {
  navEl = h('nav', { class: 'nav' });
  for (const item of NAV) {
    if (!item) { navEl.appendChild(h('div', { class: 'sep' })); continue; }
    const [key, ico, label] = item;
    navEl.appendChild(h('a', { href: `#/${key}`, 'data-key': key, onclick: () => sidebar.classList.remove('open') }, h('span', { class: 'ico' }, ico), label));
  }
  sideStatus = h('div', { class: 'side-status' }, '…');
  sidebar = h('aside', { class: 'sidebar' }, brand(), navEl, sideStatus,
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('a', { class: 'btn sm ghost', href: '/overlay', target: '_blank' }, 'Overlay ↗'),
      h('button', { class: 'btn sm ghost', onclick: async () => { await post('/api/auth/logout'); location.hash = ''; showLogin(); } }, 'Esci')));
  mainEl = h('main', { class: 'main' });
  mount(root, h('div', { class: 'layout' }, sidebar, mainEl));
  store.ws?.close();
  store.ws = connectWs('/ws/admin', (type, data) => {
    if (type === 'snapshot' || type === 'status') { store.status = data; renderSideStatus(); }
    if (type === 'log' && data.level === 'error') toast(data.message, 'err');
    for (const l of store.listeners) { try { l(type, data); } catch (e) { console.error(e); } }
  });
  window.onhashchange = route;
  route();
}

function renderSideStatus() {
  const s = store.status;
  if (!s || !sideStatus) return;
  const st = s.lifecycle.state;
  const label = { OFFLINE: 'Offline', CONNECTING: 'Connessione…', LIVE: 'IN DIRETTA', PAUSED: 'In pausa', ERROR: 'Errore' }[st] || st;
  mount(sideStatus,
    h('div', { class: 'row' }, h('span', { class: `pill state-pill state-${st}` }, h('span', { class: `dot ${st === 'LIVE' ? 'live' : ''}` }), label)),
    h('div', { class: 'muted', style: { marginTop: '6px' } },
      s.engine.running ? (s.engine.mode === 'demo' ? '🧪 Motore in modalità DEMO' : '🟢 Motore di gioco attivo') : '⏸ Motore di gioco fermo'),
    s.session && !s.session.is_demo ? h('div', { class: 'muted' }, `Diretta: ${fmt.dur((Date.now() - Date.parse(s.session.started_at)) / 1000)}`) : null);
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  const [key, ...rest] = hash.split('/');
  const page = pages[key] || pages.overview;
  for (const a of navEl.querySelectorAll('a')) a.classList.toggle('active', a.dataset.key === key);
  if (cleanup) { try { cleanup(); } catch { /* ignora */ } cleanup = null; }
  const title = NAV.find((n) => n && n[0] === key)?.[2] || 'Panoramica';
  const content = h('div');
  mount(mainEl,
    h('div', { class: 'topbar' },
      h('button', { class: 'btn menu-btn', onclick: () => sidebar.classList.toggle('open') }, '☰'),
      h('h1', {}, title)),
    content);
  document.title = `${title} · Live Catch`;
  Promise.resolve(page({ el: content, params: rest, store })).then((c) => { cleanup = typeof c === 'function' ? c : null; })
    .catch((e) => mount(content, h('div', { class: 'notice err' }, e.message)));
}

setInterval(renderSideStatus, 30000);
boot();
