// Overlay OBS: riceve gli eventi del gioco via WebSocket e li anima.
// In modalità ?preview=1 (anteprima nella dashboard) non si collega al server:
// riceve eventi di prova solo dalla pagina che lo contiene.
const params = new URLSearchParams(location.search);
const PREVIEW = params.get('preview') === '1';
const RAR = {
  common: ['Comune', '#c9cfdd'], uncommon: ['Non comune', '#4cc38a'], rare: ['Raro', '#4b8dff'],
  epic: ['Epico', '#b366ff'], legendary: ['Leggendario', '#ffb020'], mythical: ['Mitico', '#ff5fa2'],
};
const TYPE_IT = { normal: 'Normale', fire: 'Fuoco', water: 'Acqua', grass: 'Erba', electric: 'Elettro', ice: 'Ghiaccio', fighting: 'Lotta', poison: 'Veleno', ground: 'Terra', flying: 'Volante', psychic: 'Psico', bug: 'Coleottero', rock: 'Roccia', ghost: 'Spettro', dragon: 'Drago', dark: 'Buio', steel: 'Acciaio', fairy: 'Folletto' };

const stage = document.getElementById('stage');
const spawnEl = document.getElementById('spawn');
const notesEl = document.getElementById('notes');
const anchor = document.createElement('div');
anchor.className = 'anchor';
stage.appendChild(anchor);
anchor.appendChild(notesEl);
anchor.appendChild(spawnEl);

let settings = null;
let current = null;
let clockSkew = 0;
let timerInt = null;
const queue = [];
let showing = 0;
let animChain = Promise.resolve();

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms / (settings?.animations?.speed || 1)));
const animOn = () => settings?.animations?.enabled !== false;

function applySettings(s) {
  settings = s;
  const r = document.documentElement.style;
  r.setProperty('--primary', s.colors.primary);
  r.setProperty('--accent', s.colors.accent);
  r.setProperty('--panel', s.colors.background);
  r.setProperty('--text', s.colors.text);
  r.setProperty('--ok', s.colors.success);
  r.setProperty('--ko', s.colors.failure);
  r.setProperty('--scale', s.layout.scale);
  r.setProperty('--speed', s.animations.speed);
  r.setProperty('--ox', `${s.layout.offsetX}px`);
  r.setProperty('--oy', `${s.layout.offsetY}px`);
  if (s.font) r.setProperty('--font', `'${s.font}', 'Nunito', 'Segoe UI', system-ui, sans-serif`);
  anchor.className = `anchor pos-${s.layout.position}`;
  document.body.classList.toggle('anim', s.animations.enabled);
  // Le notifiche stanno sopra o sotto il pannello in base alla posizione.
  if (s.layout.position.startsWith('top')) anchor.append(spawnEl, notesEl); else anchor.append(notesEl, spawnEl);
}

function renderSpawn(sp) {
  current = sp;
  clearInterval(timerInt);
  spawnEl.replaceChildren();
  spawnEl.className = 'spawn';
  const [rLabel, rColor] = RAR[sp.rarity] || [sp.rarity, '#ccc'];
  spawnEl.style.setProperty('--rc', rColor);
  const E = settings.elements;
  spawnEl.appendChild(el('div', 'head', sp.shiny ? '✨ È apparso un Pokémon shiny! ✨' : 'È apparso un Pokémon selvatico!'));
  if (sp.shiny) spawnEl.appendChild(el('div', 'shiny-tag', 'SHINY'));
  if (sp.demo) spawnEl.appendChild(el('div', 'demo-badge', 'DEMO'));
  const wrap = el('div', 'img-wrap');
  if (E.image) {
    const img = el('img', 'mon');
    img.src = sp.image;
    img.alt = '';
    img.onerror = () => { img.src = '/assets/img/unknown.svg'; };
    wrap.appendChild(img);
    if (sp.shiny) for (let i = 0; i < 6; i++) {
      const s = el('div', 'sparkle');
      s.style.left = `${10 + Math.random() * 80}%`; s.style.top = `${10 + Math.random() * 70}%`; s.style.animationDelay = `${Math.random()}s`;
      wrap.appendChild(s);
    }
  }
  spawnEl.appendChild(wrap);
  if (E.name) spawnEl.appendChild(el('div', 'name', sp.name));
  if (E.dexNumber) spawnEl.appendChild(el('div', 'dex', `N° ${String(sp.dex).padStart(4, '0')}`));
  const meta = el('div', 'meta');
  if (E.rarity) { const b = el('span', 'badge', rLabel); b.style.setProperty('--c', rColor); meta.appendChild(b); }
  if (E.types) for (const t of sp.types || []) meta.appendChild(el('span', 'badge type', TYPE_IT[t] || t));
  spawnEl.appendChild(meta);
  const bar = el('div');
  if (E.timer) { const t = el('div', 'timer'); t.appendChild(bar); spawnEl.appendChild(t); }
  const foot = el('div', 'foot');
  const left = el('span');
  const att = el('span');
  if (E.timer) foot.appendChild(left);
  if (E.attempts) foot.appendChild(att);
  spawnEl.appendChild(foot);
  spawnEl._att = att;
  const total = Date.parse(sp.expiresAt) - Date.parse(sp.startedAt);
  const tick = () => {
    const remain = Math.max(0, Date.parse(sp.expiresAt) - (Date.now() + clockSkew));
    bar.style.width = `${(remain / total) * 100}%`;
    left.textContent = `⏱ ${Math.ceil(remain / 1000)}s`;
  };
  att.textContent = `🎯 ${sp.attempts || 0} tentativi`;
  tick();
  if (E.timer) timerInt = setInterval(tick, 1000);
  spawnEl.classList.add('enter');
}

async function hideSpawn() {
  clearInterval(timerInt);
  if (spawnEl.classList.contains('hidden')) return;
  if (animOn()) { spawnEl.classList.add('leave'); await wait(500); }
  spawnEl.className = 'spawn hidden';
  spawnEl.replaceChildren();
  current = null;
}

function updateAttempts(n) {
  if (spawnEl._att) spawnEl._att.textContent = `🎯 ${n} tentativi`;
}

// --- Coda notifiche (niente sovrapposizioni) ----------------------------------
function notify(html, kind = '', { big = false } = {}) {
  const max = settings?.notifications?.maxQueue || 20;
  if (queue.length >= max) queue.shift();
  queue.push({ html, kind, big });
  pump();
}

function pump() {
  const maxVisible = 3;
  while (showing < maxVisible && queue.length) {
    const n = queue.shift();
    showing++;
    const node = el('div', `note ${n.kind} ${n.big ? 'big' : ''}`);
    node.append(...n.html);
    notesEl.appendChild(node);
    const dur = (settings?.notifications?.durationMs || 4500) * (n.big ? 1.4 : 1);
    setTimeout(async () => {
      node.classList.add('out');
      await wait(350);
      node.remove();
      showing--;
      pump();
    }, dur);
  }
}

const b = (t) => { const x = el('b'); x.textContent = t; return x; };
const t = (s) => document.createTextNode(s);

function confetti() {
  if (!animOn()) return;
  const colors = [settings.colors.accent, settings.colors.primary, settings.colors.success, '#fff'];
  for (let i = 0; i < 40; i++) {
    const c = el('div', 'confetti');
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', `${(Math.random() - 0.5) * 500}px`);
    c.style.setProperty('--dy', `${-100 - Math.random() * 300}px`);
    spawnEl.appendChild(c);
    setTimeout(() => c.remove(), 1600);
  }
}

// Animazione di un lancio: le animazioni sono serializzate per evitare sovrapposizioni.
function onThrow(d) {
  animChain = animChain.then(async () => {
    const N = settings.notifications;
    if (N.showThrows && (d.caught || N.showFailures)) notify([b(d.user), t(' lancia una '), b(d.ball.name), t('!')]);
    if (current && current.id === d.spawnId && !spawnEl.classList.contains('hidden') && animOn()) {
      const orb = el('div', 'orb fly');
      orb.style.setProperty('--bc', d.ball.color || settings.colors.primary);
      spawnEl.querySelector('.img-wrap')?.appendChild(orb);
      await wait(700);
      orb.className = 'orb shake';
      await wait(d.caught ? 1350 : 700);
      orb.className = 'orb burst';
      if (d.caught) spawnEl.classList.add('caught');
      await wait(400);
      orb.remove();
    }
    if (d.attempts != null) updateAttempts(d.attempts);
    if (d.caught) {
      confetti();
      notify([t('🎉 '), b(d.user), t(' ha catturato '), b(`${d.pokemon.name}${d.pokemon.shiny ? ' ✨' : ''}`), t('!')], 'ok', { big: true });
    } else if (N.showFailures) {
      notify([t('💨 '), b(d.pokemon.name), t(` è uscito dalla ${d.ball.name}!`)], 'ko');
    }
    if (d.fled) notify([t('🏃 '), b(d.pokemon.name), t(' è fuggito!')], 'ko');
  }).catch(() => {});
}

function onDespawn(d) {
  animChain = animChain.then(async () => {
    if (current && d.id !== current.id) return;
    if (d.reason === 'expired' && current) notify([t('🌫️ '), b(current.name), t(' è scappato via…')], 'ko');
    if (d.reason === 'caught' && animOn()) await wait(600);
    await hideSpawn();
  }).catch(() => {});
}

function clearAll() {
  queue.length = 0;
  notesEl.replaceChildren();
  showing = 0;
  clearInterval(timerInt);
  spawnEl.className = 'spawn hidden';
  spawnEl.replaceChildren();
  current = null;
}

function handle(type, data, ts) {
  if (ts) clockSkew = ts - Date.now();
  switch (type) {
    case 'snapshot':
      applySettings(data.settings);
      clearAll();
      if (data.active && data.spawn) renderSpawn(data.spawn);
      break;
    case 'settings': applySettings(data); break;
    case 'spawn': animChain = animChain.then(() => renderSpawn(data)); break;
    case 'throw': onThrow(data); break;
    case 'despawn': onDespawn(data); break;
    case 'state': if (!data.active) clearAll(); break; // diretta terminata o in pausa: overlay inattivo
    case 'clear': clearAll(); break;
    default: break;
  }
}

async function start() {
  const res = await fetch('/api/public/overlay').then((r) => r.json()).catch(() => null);
  if (res) handle('snapshot', PREVIEW ? { ...res, active: false } : res);
  if (PREVIEW) {
    const tag = el('div', 'preview-badge', 'ANTEPRIMA');
    document.body.appendChild(tag);
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.data?.source !== 'livecatch-preview') return;
      handle(e.data.type, e.data.data, Date.now());
    });
    return;
  }
  let attempt = 0;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/overlay`);
    ws.onopen = () => { attempt = 0; };
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); handle(m.type, m.data, m.ts); } catch { /* ignora */ } };
    ws.onclose = () => setTimeout(connect, Math.min(10000, 1000 * 2 ** attempt++));
  };
  connect();
}

start();
