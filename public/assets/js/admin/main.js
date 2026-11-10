// Dashboard amministrativa unica: login, cambio password obbligatorio, sidebar, routing.
import { h, mount, get, post, setCsrf, connectWs, fmt } from '../lib.js';
import { toast } from './ui.js';
import { pages } from './pages/index.js';
import { icon } from '../icons.js';

const root = document.getElementById('root');
export const store = { me: null, status: null, listeners: new Set(), ws: null };

export function onLive(fn) { store.listeners.add(fn); return () => store.listeners.delete(fn); }

// [chiave, icona, etichetta, sottotitolo]
const NAV = [
  ['overview', 'home', 'Panoramica', 'Stato del gioco, diretta corrente e attività in tempo reale'],
  ['game', 'gamepad', 'Controllo gioco', 'Modalità automatica (Twitch) o manuale: avvia e ferma il gioco senza andare LIVE'],
  ['leaderboard', 'trophy', 'Classifiche', 'Classifiche di sessione, overlay, risultati congelati, Hall of Fame e riepiloghi'],
  ['stats', 'chart', 'Statistiche', 'Andamento delle dirette, classifiche e confronti'],
  ['users', 'users', 'Pokédex e Utenti', 'Spettatori, collezioni, doppioni e storico catture'],
  ['pokedex', 'star', 'Modifica Pokédex', 'Correggi, registra o rimuovi i Pokémon di un allenatore, con storico delle modifiche'],
  ['spawn', 'target', 'Gestione Spawn', 'Intervalli, probabilità, eventi e Pokémon in campo'],
  ['pokemon', 'layers', 'Gestione Pokémon', 'Elenco, rarità, difficoltà e importazione da PokéAPI'],
  ['balls', 'gift', 'Poké Ball e Ricompense', 'Moltiplicatori e collegamento ai punti canale'],
  ['twitch', 'twitch', 'Gestione Twitch', 'Account, connessione, ricompense ed eventi'],
  ['commands', 'chat', 'Comandi Chat', 'Risposte, cooldown e anti-spam dei comandi'],
  ['overlay', 'monitor', 'Overlay Designer', 'Temi, editor visuale, anteprima e simulatore dell\'overlay per OBS'],
  ['audio', 'volume', 'Audio OBS', 'Effetti sonori di spawn e cattura per una Browser Source dedicata di OBS'],
  ['sessions', 'calendar', 'Storico Dirette', 'Tutte le sessioni LIVE con il loro dettaglio'],
  ['system', 'database', 'Backup e Sistema', 'Backup locali e su cartella di rete, ripristino, log e stato del servizio'],
  ['settings', 'settings', 'Impostazioni', 'Account, pagine pubbliche e modalità DEMO'],
];
const HIDDEN = { demo: ['flask', 'Modalità DEMO', 'Prova il gioco senza Twitch, separato dalle statistiche reali'] };

window.addEventListener('api-error', (e) => {
  if (e.detail.status === 401 && !String(e.detail.path).startsWith('/api/auth/login')) showLogin();
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
  return h('div', { class: 'brand' }, icon('logo', { size: 44, cls: 'logo' }),
    h('div', { class: 'txt' }, h('div', { class: 'title' }, 'Pokémon Live Catch'), h('div', { class: 'sub' }, icon('twitch', { size: 16 }), 'Twitch Integration')));
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

let mainEl, navEl, sideFoot, sidebar, layout, topTitle, topSub, twPill, modePill, cleanup = null;

function showApp() {
  navEl = h('nav', { class: 'nav' });
  for (const [key, ico, label] of NAV) {
    navEl.appendChild(h('a', { href: `#/${key}`, 'data-key': key, title: label, onclick: () => sidebar.classList.remove('open') }, icon(ico, { size: 22 }), h('span', { class: 'lbl' }, label)));
  }
  sideFoot = h('div', { class: 'side-foot' });
  sidebar = h('aside', { class: 'sidebar' }, brand(), navEl, sideFoot);
  topTitle = h('h1');
  topSub = h('div', { class: 'subtitle' });
  twPill = h('span', { class: 'tw-pill', style: { '--c': 'var(--muted)' } }, h('span', { class: 'dot' }), '…');
  modePill = h('a', { class: 'mode-pill manual hidden', href: '#/game', title: 'Sessione manuale in corso: il canale resta OFFLINE su Twitch' }, h('span', { class: 'manual-dot' }), 'SESSIONE MANUALE');
  const menu = h('div', { class: 'dropdown hidden' },
    h('a', { href: '#/settings' }, icon('key', { size: 18 }), 'Cambia password'),
    h('a', { href: '/overlay', target: '_blank' }, icon('external', { size: 18 }), 'Apri overlay'),
    h('a', { href: '/', target: '_blank' }, icon('external', { size: 18 }), 'Pagina pubblica'),
    h('button', { onclick: async () => { await post('/api/auth/logout'); location.hash = ''; showLogin(); } }, icon('logout', { size: 18 }), 'Esci'));
  const userMenu = h('div', { class: 'user-menu' },
    h('button', { class: 'user-btn', onclick: (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); } },
      h('span', { class: 'avatar' }, icon('user', { size: 22 })), h('span', { class: 'uname' }, store.me?.username === 'admin' ? 'Admin' : store.me?.username || 'Admin'), icon('chevronDown', { size: 18 })),
    menu);
  document.addEventListener('click', () => menu.classList.add('hidden'));
  mainEl = h('main', { class: 'main' });
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'btn menu-btn', onclick: () => sidebar.classList.toggle('open') }, icon('menu', { size: 20 })),
    h('div', {}, topTitle, topSub),
    h('div', { class: 'right' }, modePill, twPill, h('span', { class: 'vsep' }), userMenu));
  layout = h('div', { class: `layout ${localStorage.getItem('lc_collapsed') === '1' ? 'collapsed' : ''}` }, sidebar, h('div', { class: 'content' }, topbar, mainEl));
  mount(root, layout);
  renderSideStatus();
  store.ws?.close();
  store.ws = connectWs('/ws/admin', (type, data) => {
    if (type === 'snapshot' || type === 'status') { store.status = data; renderSideStatus(); }
    if (type === 'log' && data.level === 'error') toast(data.message, 'err');
    for (const l of store.listeners) { try { l(type, data); } catch (e) { console.error(e); } }
  }, { onState: (ok) => { store.wsOk = ok; renderSideStatus(); } });
  window.onhashchange = route;
  route();
}

function renderSideStatus() {
  if (!sideFoot) return;
  const ok = store.wsOk !== false;
  mount(sideFoot,
    h('div', { class: 'txt' },
      h('div', { class: 'svc' }, h('span', { class: 'dot', style: { background: ok ? 'var(--ok)' : 'var(--err)' } }), ok ? 'Servizio attivo' : 'Servizio non raggiungibile'),
      h('div', { class: 'ver' }, `v${store.me?.version || ''}`)),
    h('button', { class: 'collapse-btn', title: 'Riduci/espandi menu', onclick: () => {
      layout.classList.toggle('collapsed');
      localStorage.setItem('lc_collapsed', layout.classList.contains('collapsed') ? '1' : '0');
      renderSideStatus();
    } }, icon(layout?.classList.contains('collapsed') ? 'chevronRight' : 'chevronLeft', { size: 18 })));
  const s = store.status;
  if (!s || !twPill) return;
  const tw = s.twitch;
  const [c, label] = !tw.configured ? ['var(--muted)', 'Twitch da configurare']
    : tw.eventsubConnected ? ['var(--ok)', 'Twitch connesso'] : ['var(--err)', 'Twitch non connesso'];
  modePill.classList.toggle('hidden', s.engine?.mode !== 'manual');
  twPill.style.setProperty('--c', c);
  mount(twPill, h('span', { class: 'dot' }), label);
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  const [key, ...rest] = hash.split('/');
  const page = pages[key] || pages.overview;
  for (const a of navEl.querySelectorAll('a')) a.classList.toggle('active', a.dataset.key === (pages[key] ? key : 'overview'));
  if (cleanup) { try { cleanup(); } catch { /* ignora */ } cleanup = null; }
  const nav = NAV.find((n) => n[0] === key);
  const title = nav?.[2] || HIDDEN[key]?.[1] || 'Panoramica';
  const sub = nav?.[3] || HIDDEN[key]?.[2] || NAV[0][3];
  topTitle.textContent = title;
  topSub.textContent = sub;
  const content = h('div');
  mount(mainEl, content);
  document.title = `${title} · Pokémon Live Catch`;
  Promise.resolve(page({ el: content, params: rest, store })).then((c) => { cleanup = typeof c === 'function' ? c : null; })
    .catch((e) => mount(content, h('div', { class: 'notice err' }, e.message)));
}

setInterval(renderSideStatus, 30000);
boot();
