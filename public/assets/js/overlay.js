// Overlay OBS: riceve gli eventi del gioco via WebSocket e li anima con il tema attivo.
//
// - Il tema (stile grafico + configurazione) arriva nello snapshot e nei messaggi
//   "settings": il cambio di tema è immediato, senza ricaricare la pagina.
// - Tutto è disegnato su una tela logica 1920×1080 scalata alla dimensione reale
//   della sorgente (1920×1080, 1280×720, …): l'aspetto è identico a ogni risoluzione.
// - Spawn, lanci e fughe passano da una coda limitata (event-queue.js): con molti
//   eventi ravvicinati le animazioni si accorciano o si saltano, lo stato resta esatto.
//   Il cambio tema NON passa dalla coda: viene applicato subito.
// - Gli elementi simulati (sim: true) vengono tolti con "sim_clear" senza toccare
//   quelli reali.
// - ?preview=1 (anteprima dell'Overlay Designer): nessuna connessione al server,
//   riceve impostazioni ed eventi di prova solo dalla pagina che la contiene.
// - Effetti sonori (overlay/audio-client.js): la stessa pagina riproduce i suoni di
//   spawn e cattura, ma solo nella Browser Source di OBS (o con ?audio=1). Modulo
//   separato dalla grafica: un aggiornamento grafico non interrompe né ripete un suono.
import { effectiveSettings, sanitizeConfig, defaultConfig, fontStack, LAYOUTS } from './overlay/theme-core.js';
import { EventQueue } from './overlay/event-queue.js';
import { LeaderboardLayer } from './overlay/leaderboard-view.js';
import { startOverlayAudio } from './overlay/audio-client.js';
import { TYPE_IT } from './lib.js'; // nomi dei tipi: un'unica tabella per dashboard e overlay

const params = new URLSearchParams(location.search);
const PREVIEW = params.get('preview') === '1';
// Colori delle rarità propri dell'overlay (più luminosi di quelli della dashboard,
// pensati per stare sopra la scena di gioco).
const RAR = {
  common: ['Comune', '#c9cfdd'], uncommon: ['Non comune', '#4cc38a'], rare: ['Raro', '#4b8dff'],
  epic: ['Epico', '#b366ff'], legendary: ['Leggendario', '#ffb020'], mythical: ['Mitico', '#ff5fa2'],
};
const DESIGN_W = 1920;
const DESIGN_H = 1080;
const RING_C = 2 * Math.PI * 46;

const root = document.documentElement;
const stage = document.getElementById('stage');
const canvas = document.createElement('div');
canvas.id = 'canvas';
const anchor = document.createElement('div');
anchor.className = 'anchor';
const spawnEl = document.getElementById('spawn');
const notesEl = document.getElementById('notes');
anchor.append(notesEl, spawnEl);
canvas.appendChild(anchor);
stage.appendChild(canvas);
// Schermate delle classifiche: livello separato, non toccato da fine diretta o azzeramenti.
const board = new LeaderboardLayer(canvas);

let theme = null; // { base, config, ... }
let current = null;
let clockSkew = 0;
let timerInt = null;
const queue = []; // notifiche in attesa di essere mostrate
let showing = 0;
let cssBase = null;
let cssLink = null;
// Coda degli eventi animati. epoch cambia a ogni azzeramento (snapshot, fine
// diretta), simEpoch quando vengono tolti gli elementi simulati: un'animazione
// già partita si interrompe se la sua epoca non è più quella corrente.
const events = new EventQueue({ limit: 6 });
let epoch = 0;
let simEpoch = 0;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const cfg = () => theme.config;
const speed = () => cfg().animation.speed || 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms / speed()));
const animOn = () => cfg().animation.enabled !== false;

// --- Scala della tela -----------------------------------------------------------
function fit() {
  const s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H) || 1;
  root.style.setProperty('--vs', String(s));
}
window.addEventListener('resize', fit);
fit();

// --- Tema -------------------------------------------------------------------------
// Il foglio di stile del tema viene caricato al primo uso e sostituito senza
// lasciare il vecchio attivo (nessun accumulo di CSS dopo molti cambi).
// Con cambi rapidi (A → B) vince sempre l'ultimo richiesto, anche se il file di A
// finisce di caricare dopo quello di B.
function loadThemeCss(base) {
  if (cssBase === base) return Promise.resolve();
  cssBase = base;
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/assets/css/themes/${base}.css`;
    link.dataset.theme = base;
    cssLink = link;
    const done = () => {
      if (cssLink !== link) { link.remove(); resolve(); return; }
      for (const old of document.querySelectorAll('link[data-theme]')) if (old !== link) old.remove();
      resolve();
    };
    link.onload = done;
    link.onerror = done;
    document.head.appendChild(link);
  });
}

// Accetta le impostazioni nel formato attuale (con "theme") e in quello delle
// versioni precedenti (solo colori/layout/…), convertendole nel tema Classico.
function normalize(s) {
  if (s?.theme?.config && LAYOUTS[s.theme.base]) {
    return { ...s.theme, config: sanitizeConfig(s.theme.config, defaultConfig(s.theme.base)).config };
  }
  const c = defaultConfig('classic');
  if (s?.colors) Object.assign(c.colors, { primary: s.colors.primary, secondary: s.colors.accent, panel: s.colors.background, text: s.colors.text, success: s.colors.success, failure: s.colors.failure });
  if (s?.layout) Object.assign(c.layout, { position: s.layout.position, scale: s.layout.scale, offsetX: s.layout.offsetX, offsetY: s.layout.offsetY });
  if (s?.animations) Object.assign(c.animation, s.animations);
  if (s?.notifications) Object.assign(c.notifications, s.notifications);
  if (s?.elements) Object.assign(c.elements, s.elements);
  return { base: 'classic', name: 'Classico', config: sanitizeConfig(c, defaultConfig('classic')).config };
}

async function applySettings(s) {
  const next = normalize(s);
  const baseChanged = !theme || theme.base !== next.base;
  theme = next;
  const c = theme.config;
  const r = root.style;
  const set = (k, v) => r.setProperty(k, String(v));
  set('--primary', c.colors.primary);
  set('--accent', c.colors.secondary);
  set('--secondary', c.colors.secondary);
  set('--bg', c.colors.background);
  set('--panel', c.colors.panel);
  set('--text', c.colors.text);
  set('--muted', c.colors.muted);
  set('--ok', c.colors.success);
  set('--ko', c.colors.failure);
  set('--font', fontStack(c.typography));
  set('--fs', `${c.typography.baseSize}px`);
  set('--fs-title', `${c.typography.titleSize}px`);
  set('--fw', c.typography.weight);
  set('--tt', c.typography.uppercase ? 'uppercase' : 'none');
  set('--ls', `${c.typography.letterSpacing}em`);
  set('--radius', `${c.shape.radius}px`);
  set('--bw', `${c.shape.borderWidth}px`);
  set('--shadow', c.shape.shadow / 100);
  set('--glow', c.shape.glow / 100);
  set('--fx', c.effects.intensity / 100);
  set('--scale', c.layout.scale);
  set('--speed', c.animation.speed);
  set('--ox', `${c.layout.offsetX}px`);
  set('--oy', `${c.layout.offsetY}px`);
  set('--pw', `${c.layout.panelWidth}px`);
  set('--img', `${c.layout.imageSize}px`);
  const b = document.body.classList;
  for (const k of [...b]) if (/^(t-|fx-)/.test(k)) b.remove(k);
  b.add(`t-${theme.base}`);
  b.toggle('anim', c.animation.enabled);
  b.toggle('idle', c.animation.enabled && c.animation.idle && c.effects.intensity > 0);
  b.toggle('fx-particles', c.effects.particles && c.effects.intensity > 0);
  b.toggle('fx-scanlines', c.effects.scanlines && c.effects.intensity > 0);
  b.toggle('fx-shimmer', c.effects.shimmer && c.effects.intensity > 0);
  b.toggle('fx-off', c.effects.intensity === 0);
  events.setLimit(c.animation.queueLimit);
  anchor.className = `anchor pos-${c.layout.position}`;
  // Le notifiche stanno dal lato opposto al bordo dello schermo.
  if (c.layout.position.startsWith('top')) anchor.append(spawnEl, notesEl); else anchor.append(notesEl, spawnEl);
  // Struttura diversa per ogni stile: lo spawn visibile viene ridisegnato subito
  // (con il contatore dei tentativi aggiornato) e di nuovo a foglio caricato.
  if (current) renderSpawn(current, { entrance: false });
  const applied = theme;
  await loadThemeCss(theme.base);
  if (current && baseChanged && theme === applied) renderSpawn(current, { entrance: false });
  return baseChanged;
}

// --- Spawn ------------------------------------------------------------------------
function renderSpawn(sp, { entrance = true } = {}) {
  current = sp;
  clearInterval(timerInt);
  spawnEl.replaceChildren();
  const c = cfg();
  const E = c.elements;
  const [rLabel, rColor] = RAR[sp.rarity] || [sp.rarity, '#ccc'];
  spawnEl.className = `spawn rar-${sp.rarity} timer-${E.timerStyle}${sp.shiny ? ' is-shiny' : ''}`;
  spawnEl.style.setProperty('--rc', E.rarityColors ? rColor : 'var(--secondary)');
  spawnEl.style.setProperty('--rarity', rColor);

  // Decorazioni usate solo da alcuni stili (staffe HUD, riflesso olografico, forme…).
  const deco = el('div', 'deco');
  for (const k of ['c1', 'c2', 'c3', 'c4', 'sheen', 'blob1', 'blob2', 'scan', 'line']) deco.appendChild(el('span', k));
  spawnEl.appendChild(deco);

  if (E.header) {
    const head = el('div', 'head', sp.shiny ? '✨ È apparso un Pokémon shiny! ✨' : 'È apparso un Pokémon selvatico!');
    head.dataset.text = head.textContent;
    spawnEl.appendChild(head);
  }
  if (sp.shiny) spawnEl.appendChild(el('div', 'shiny-tag', 'SHINY'));
  if (sp.sim) spawnEl.appendChild(el('div', 'sim-badge', 'SIMULAZIONE'));
  else if (sp.demo) spawnEl.appendChild(el('div', 'demo-badge', 'DEMO'));

  const wrap = el('div', 'img-wrap');
  if (E.image) {
    const img = el('img', 'mon');
    img.src = sp.image;
    img.alt = '';
    img.decoding = 'async';
    img.onerror = () => { img.onerror = null; img.src = '/assets/img/unknown.svg'; };
    wrap.appendChild(img);
    if (sp.shiny && c.effects.intensity > 0) {
      const n = Math.round(2 + 6 * (c.effects.intensity / 100));
      for (let i = 0; i < n; i++) {
        const s = el('div', 'sparkle');
        s.style.left = `${10 + Math.random() * 80}%`; s.style.top = `${10 + Math.random() * 70}%`; s.style.animationDelay = `${Math.random()}s`;
        wrap.appendChild(s);
      }
    }
  }
  // Timer circolare attorno all'immagine (stile "ring").
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('viewBox', '0 0 100 100');
  ring.setAttribute('class', 'ring');
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const prog = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const ci of [track, prog]) { ci.setAttribute('cx', '50'); ci.setAttribute('cy', '50'); ci.setAttribute('r', '46'); }
  track.setAttribute('class', 'track');
  prog.setAttribute('class', 'prog');
  prog.setAttribute('stroke-dasharray', String(RING_C));
  ring.append(track, prog);
  if (E.timer && E.timerStyle === 'ring') wrap.appendChild(ring);
  spawnEl.appendChild(wrap);

  const info = el('div', 'info');
  if (E.name) { const n = el('div', 'name', sp.name); n.dataset.text = sp.name; info.appendChild(n); }
  if (E.dexNumber) info.appendChild(el('div', 'dex', `N° ${String(sp.dex).padStart(4, '0')}`));
  const meta = el('div', 'meta');
  if (E.rarity) { const b = el('span', 'badge rarity', rLabel); b.style.setProperty('--c', rColor); meta.appendChild(b); }
  if (E.types) for (const t of sp.types || []) meta.appendChild(el('span', 'badge type', TYPE_IT[t] || t));
  info.appendChild(meta);
  spawnEl.appendChild(info);

  const bar = el('div');
  if (E.timer && E.timerStyle === 'bar') { const t = el('div', 'timer'); t.appendChild(bar); spawnEl.appendChild(t); }
  const digits = el('div', 'digits');
  if (E.timer && E.timerStyle === 'digits') spawnEl.appendChild(digits);
  const foot = el('div', 'foot');
  const left = el('span', 'left');
  const att = el('span', 'att');
  if (E.timer && E.timerStyle !== 'digits') foot.appendChild(left);
  if (E.attempts) foot.appendChild(att);
  if (foot.childNodes.length) spawnEl.appendChild(foot);
  spawnEl._att = att;

  const total = Math.max(1, Date.parse(sp.expiresAt) - Date.parse(sp.startedAt));
  const tick = () => {
    const remain = Math.max(0, Date.parse(sp.expiresAt) - (Date.now() + clockSkew));
    const frac = remain / total;
    bar.style.width = `${frac * 100}%`;
    prog.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
    const sec = Math.ceil(remain / 1000);
    left.textContent = `⏱ ${sec}s`;
    digits.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    spawnEl.classList.toggle('hurry', sec <= 10);
  };
  att.textContent = `🎯 ${sp.attempts || 0} tentativi`;
  tick();
  if (E.timer) timerInt = setInterval(tick, 1000);
  if (entrance && animOn()) spawnEl.classList.add('enter', `in-${c.animation.entrance}`);
}

async function hideSpawn(pause = wait) {
  clearInterval(timerInt);
  if (spawnEl.classList.contains('hidden')) return;
  const leaving = current;
  if (animOn()) { spawnEl.classList.remove('enter'); spawnEl.classList.add('leave', `out-${cfg().animation.exit}`); await pause(500); }
  // Nel frattempo potrebbe essere apparso un altro spawn (cambio stato, snapshot).
  if (current !== leaving) return;
  hideNow();
}

function hideNow() {
  clearInterval(timerInt);
  spawnEl.className = 'spawn hidden';
  spawnEl.replaceChildren();
  current = null;
}

// Il contatore resta anche nello stato: un cambio tema ridisegna lo spawn con il valore giusto.
function updateAttempts(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (current) current.attempts = v;
  if (spawnEl._att) spawnEl._att.textContent = `🎯 ${v} tentativi`;
}

// --- Coda notifiche (niente sovrapposizioni) ----------------------------------
// Coda piena: si scarta la notifica meno importante più vecchia (le catture
// restano). Con molte notifiche in attesa ognuna resta visibile meno a lungo.
function notify(parts, kind = '', { big = false, important = false, sim = false } = {}) {
  const max = cfg().notifications.maxQueue || 20;
  if (queue.length >= max) {
    const i = queue.findIndex((n) => !n.important);
    if (i >= 0) queue.splice(i, 1);
    else if (!important) return;
    else queue.shift();
  }
  queue.push({ parts, kind, big, important, sim });
  pump();
}

function pump() {
  const maxVisible = cfg().notifications.maxVisible || 3;
  while (showing < maxVisible && queue.length) {
    const n = queue.shift();
    showing++;
    const node = el('div', `note ${n.kind} ${n.big ? 'big' : ''}`);
    if (n.sim) node.dataset.sim = '1';
    node.append(...n.parts);
    notesEl.appendChild(node);
    const rush = queue.length >= maxVisible ? 0.5 : 1;
    const dur = (cfg().notifications.durationMs || 4500) * (n.big ? 1.4 : 1) * rush;
    setTimeout(async () => {
      if (!node.isConnected) return; // già rimossa (azzeramento o pulizia simulazione)
      node.classList.add('out');
      if (animOn()) await wait(350);
      if (!node.isConnected) return;
      node.remove();
      showing = Math.max(0, showing - 1);
      pump();
    }, dur);
  }
}

const b = (t) => { const x = el('b'); x.textContent = t; return x; };
const t = (s) => document.createTextNode(s);

function confetti() {
  const c = cfg();
  if (!animOn() || !c.effects.particles || c.effects.intensity === 0) return;
  const colors = [c.colors.secondary, c.colors.primary, c.colors.success, '#fff'];
  const n = Math.round(10 + 40 * (c.effects.intensity / 100));
  for (let i = 0; i < n; i++) {
    const p = el('div', 'confetti');
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 500}px`);
    p.style.setProperty('--dy', `${-100 - Math.random() * 300}px`);
    spawnEl.appendChild(p);
    setTimeout(() => p.remove(), 1600 / speed());
  }
}

// Accoda un evento animato. Il job riceve il contesto della coda (modalità e
// attesa accorciata) e un controllo "stale" per fermarsi se l'overlay è stato
// azzerato o gli elementi simulati sono stati rimossi nel frattempo.
function enqueue(fn, { sim = false, important = false } = {}) {
  const ep = epoch;
  const sep = simEpoch;
  events.push(async (ctx) => {
    const stale = () => ep !== epoch || (sim && sep !== simEpoch);
    if (stale()) return;
    const pause = (ms) => ctx.wait(ms / speed());
    await fn({ ...ctx, pause, stale });
  }, { sim, important });
}

function onThrow(d) {
  const sim = !!d.sim;
  enqueue(async ({ mode, pause, stale }) => {
    const N = cfg().notifications;
    if (N.showThrows && (d.caught || N.showFailures)) notify([b(d.user), t(' lancia una '), b(d.ball.name), t('!')], '', { sim });
    // Con la coda piena l'animazione della ball viene saltata: resta solo l'esito.
    if (mode !== 'instant' && current && current.id === d.spawnId && !spawnEl.classList.contains('hidden') && animOn()) {
      const orb = el('div', 'orb fly');
      orb.style.setProperty('--bc', d.ball.color || cfg().colors.primary);
      spawnEl.querySelector('.img-wrap')?.appendChild(orb);
      await pause(700);
      orb.className = 'orb shake';
      await pause(d.caught ? 1350 : 700);
      orb.className = 'orb burst';
      if (d.caught && current?.id === d.spawnId) spawnEl.classList.add('caught');
      await pause(400);
      orb.remove();
      if (stale()) return;
    }
    if (d.attempts != null && current && current.id === d.spawnId) updateAttempts(d.attempts);
    if (d.caught) {
      if (mode !== 'instant') confetti();
      if (N.showCatches !== false) notify([t('🎉 '), b(d.user), t(' ha catturato '), b(`${d.pokemon.name}${d.pokemon.shiny ? ' ✨' : ''}`), t('!')], 'ok', { big: true, important: !sim, sim });
    } else if (N.showFailures) {
      notify([t('💨 '), b(d.pokemon.name), t(` è uscito dalla ${d.ball.name}!`)], 'ko', { sim });
    }
    if (d.fled && N.showFlee !== false) notify([t('🏃 '), b(d.pokemon.name), t(' è fuggito!')], 'ko', { sim });
  }, { sim, important: !!d.caught && !sim });
}

function onDespawn(d) {
  const sim = !!d.sim;
  enqueue(async ({ pause, stale }) => {
    if (!current || d.id !== current.id) return;
    if (d.reason === 'expired' && cfg().notifications.showFlee !== false) notify([t('🌫️ '), b(current.name), t(' è scappato via…')], 'ko', { sim });
    if (d.reason === 'caught' && animOn()) await pause(600);
    if (stale()) return;
    await hideSpawn(pause);
  }, { sim });
}

function onSpawn(d) {
  enqueue(() => { renderSpawn(d); }, { sim: !!d.sim });
}

// Azzeramento completo (snapshot, fine diretta o pausa, "clear" reale).
function clearAll() {
  epoch++;
  events.clear();
  queue.length = 0;
  notesEl.replaceChildren();
  showing = 0;
  hideNow();
}

// Toglie solo ciò che è simulato: eventi in coda, spawn visibile e notifiche.
// Gli eventi reali (in coda o in corso) non vengono toccati.
function purgeSim() {
  simEpoch++;
  const dropped = events.clear((j) => j.sim);
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].sim) queue.splice(i, 1);
  for (const n of notesEl.querySelectorAll('.note[data-sim]')) { n.remove(); showing = Math.max(0, showing - 1); }
  if (current?.sim) hideNow();
  pump();
  return dropped;
}

function handle(type, data, ts) {
  if (ts) clockSkew = ts - Date.now();
  switch (type) {
    case 'snapshot':
      clearAll();
      // Il tema si applica subito; lo spawn reale viene mostrato senza attese.
      applySettings(data.settings).catch(() => {});
      if (data.active && data.spawn) renderSpawn(data.spawn);
      board.reset();
      board.apply(data.leaderboard || { visible: false }, { animate: false });
      break;
    case 'leaderboard': board.apply(data); break;
    case 'settings': applySettings(data).catch(() => {}); break; // immediato, fuori dalla coda
    case 'spawn': onSpawn(data); break;
    case 'throw': onThrow(data); break;
    case 'despawn': onDespawn(data); break;
    case 'notice': if (theme && typeof data?.text === 'string') notify([t(data.text.slice(0, 140))], data.kind === 'ok' || data.kind === 'ko' ? data.kind : 'info', { sim: !!data.sim }); break;
    // Diretta terminata o in pausa: overlay inattivo. Diretta (ri)partita: via gli elementi simulati.
    case 'state': if (!data?.active) clearAll(); else purgeSim(); break;
    case 'sim_clear': purgeSim(); break;
    case 'clear': if (data?.sim) purgeSim(); else clearAll(); break;
    default: break;
  }
}

// Diagnostica per test e anteprima (nessun dato sensibile).
window.__liveCatchOverlay = {
  state: () => ({
    base: theme?.base, name: theme?.name, rev: theme?.rev, spawn: current?.id ?? null, sim: !!current?.sim,
    attempts: current?.attempts ?? null, notes: notesEl.childElementCount, pendingNotes: queue.length, leaderboard: board.info(),
    queue: { size: events.size, busy: events.busy, limit: events.limit, ...events.stats },
  }),
};

async function start() {
  if (PREVIEW) {
    document.body.classList.add('preview');
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.data?.source !== 'livecatch-preview') return;
      if (e.data.type === 'reset') { clearAll(); return; }
      handle(e.data.type, e.data.data, Date.now());
    });
    // Tema attivo come punto di partenza, poi l'editor invia la bozza.
    const res = await fetch('/api/public/overlay').then((r) => r.json()).catch(() => null);
    await applySettings(res?.settings || effectiveSettings({ base: 'classic', name: 'Classico', config: defaultConfig('classic') }));
    window.parent?.postMessage({ source: 'livecatch-overlay', type: 'ready' }, location.origin);
    return;
  }
  const res = await fetch('/api/public/overlay').then((r) => r.json()).catch(() => null);
  if (res) handle('snapshot', res);
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
// Audio indipendente dalla grafica: un suo errore non tocca l'overlay.
try { startOverlayAudio(); } catch (e) { console.warn('Audio overlay non avviato:', e); }
