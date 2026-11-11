// Overlay rotante nella Browser Source /overlay: classifica, ultime catture, shiny,
// obiettivi, statistiche ed evento attivo. Il server decide quale schermata
// mostrare e quando cambiarla (messaggio "rotation"): qui si disegna soltanto.
// Nessun timer di rotazione nel browser (solo la pulizia delle animazioni e il
// conto alla rovescia del badge evento, uno solo), testi sempre via textContent.
// Modulo separato dall'audio: un cambio schermata non tocca i suoni.
import { TYPE_IT } from '../lib.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const n = (x) => Number(x || 0).toLocaleString('it-IT');
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
const catt = (x) => `${n(x)} ${Number(x) === 1 ? 'cattura' : 'catture'}`;
const PERIOD = { session: 'sessione', last: 'ultima diretta', week: 'ultimi 7 giorni', month: 'ultimi 30 giorni', all: 'storico' };
const EVENT_ICON = { legendary: '🌟', shiny: '✨' };

function img(src, cls = 'rt-mon') {
  const i = el('img', cls);
  i.src = src || '/assets/img/unknown.svg';
  i.alt = '';
  i.decoding = 'async';
  i.onerror = () => { i.onerror = null; i.src = '/assets/img/unknown.svg'; };
  return i;
}

function head(title, sub) {
  const h = el('div', 'rt-head');
  h.appendChild(el('div', 'rt-title', title));
  if (sub) h.appendChild(el('div', 'rt-sub', sub));
  return h;
}

function renderLeaderboard(d, prev) {
  const box = el('div', 'rt-panel rt-leaderboard');
  box.appendChild(head('🏆 Classifica', d.session?.open ? 'sessione in corso' : 'ultima sessione'));
  const list = el('ol', 'rt-rows');
  d.rows.forEach((r, i) => {
    const li = el('li', `rt-row${r.rank === 1 ? ' first' : ''}`);
    li.style.setProperty('--i', String(i));
    const before = prev.get(r.userId);
    if (before != null && before !== r.rank) li.classList.add(before > r.rank ? 'up' : 'down');
    else if (before == null && prev.size) li.classList.add('new');
    li.appendChild(el('span', 'rt-rank', r.rank === 1 ? '👑' : r.rank));
    li.appendChild(el('span', 'rt-name', r.name));
    li.appendChild(el('span', 'rt-val main', `${n(r.points)} pt`));
    li.appendChild(el('span', 'rt-val', catt(r.captures)));
    list.appendChild(li);
  });
  box.appendChild(list);
  return box;
}

function captureItem(c) {
  const li = el('li', `rt-cap rar-${c.rarity}${c.special ? ' special' : ''}${c.shiny ? ' shiny' : ''}`);
  li.appendChild(img(c.image));
  const info = el('div', 'rt-cap-info');
  info.appendChild(el('div', 'rt-cap-name', `${c.name}${c.shiny ? ' ✨' : ''}`));
  info.appendChild(el('div', 'rt-cap-meta', `${c.user} · ${hm(c.at)}`));
  li.appendChild(info);
  li.appendChild(el('span', 'rt-chip', c.rarityLabel || c.rarity));
  return li;
}

function renderCaptures(d) {
  const box = el('div', 'rt-panel rt-captures');
  box.appendChild(head('🎯 Ultime catture'));
  const list = el('ul', 'rt-caps');
  d.items.forEach((c, i) => { const li = captureItem(c); li.style.setProperty('--i', String(i)); list.appendChild(li); });
  box.appendChild(list);
  return box;
}

function renderShiny(d) {
  const box = el('div', 'rt-panel rt-shiny');
  box.appendChild(head('✨ Shiny', d.sessionCount != null ? `${n(d.sessionCount)} in questa sessione · ${n(d.total)} in totale` : `${n(d.total)} in totale`));
  const grid = el('div', 'rt-shiny-grid');
  for (const c of d.items) {
    const card = el('div', 'rt-shiny-card');
    card.appendChild(img(c.image));
    card.appendChild(el('div', 'rt-cap-name', c.name));
    card.appendChild(el('div', 'rt-cap-meta', `trovato da ${c.user}`));
    grid.appendChild(card);
  }
  box.appendChild(grid);
  return box;
}

function progress(pct) {
  const bar = el('div', 'rt-bar');
  const fill = el('div', 'rt-fill');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  bar.appendChild(fill);
  return bar;
}

function renderGoals(d) {
  const box = el('div', 'rt-panel rt-goals');
  box.appendChild(head('🤝 Obiettivi della community'));
  const c = d.community;
  if (c) {
    const g = el('div', `rt-goal${c.completedAt ? ' done' : ''}`);
    g.appendChild(el('div', 'rt-goal-line', c.completedAt ? `Obiettivo raggiunto: ${n(c.goal)} catture!` : `${n(c.progress)} / ${n(c.goal)} catture`));
    g.appendChild(progress(c.pct));
    g.appendChild(el('div', 'rt-goal-pct', `${c.pct}%`));
    if (c.reward) g.appendChild(el('div', 'rt-goal-reward', `🎁 ${c.reward}`));
    box.appendChild(g);
  }
  const p = d.pokemonOfDay;
  if (p) {
    const card = el('div', 'rt-potd');
    card.appendChild(img(p.image));
    const info = el('div', 'rt-cap-info');
    info.appendChild(el('div', 'rt-sub', '📅 Pokémon del giorno'));
    info.appendChild(el('div', 'rt-cap-name', p.name));
    info.appendChild(el('div', 'rt-cap-meta', p.catchersCount ? `catturato oggi da ${p.catchers.slice(0, 3).join(', ')}${p.catchersCount > 3 ? ` e altri ${p.catchersCount - 3}` : ''}` : 'nessuno l\'ha ancora catturato oggi'));
    card.appendChild(info);
    box.appendChild(card);
  }
  return box;
}

function renderStats(d) {
  const box = el('div', 'rt-panel rt-stats');
  box.appendChild(head('📊 Statistiche Community', PERIOD[d.period] || d.periodLabel));
  const grid = el('div', 'rt-tiles');
  const tile = (label, value, sub, image) => {
    const t = el('div', 'rt-tile');
    if (image) t.appendChild(img(image, 'rt-mon sm'));
    const w = el('div');
    w.appendChild(el('div', 'rt-tile-v', value));
    w.appendChild(el('div', 'rt-tile-l', label));
    if (sub) w.appendChild(el('div', 'rt-tile-s', sub));
    t.appendChild(w);
    grid.appendChild(t);
  };
  tile('Catture totali', n(d.totals.captures), `${n(d.totals.trainers)} allenatori · ✨ ${n(d.totals.shiny)}`);
  if (d.mostCaught) tile('Più catturato', d.mostCaught.name, `${catt(d.mostCaught.count)}`, d.mostCaught.image);
  if (d.luckiest) tile('Più fortunato', d.luckiest.name, `${n(d.luckiest.value)} · ${d.luckiest.label}${d.luckiest.tie ? ' (pari merito)' : ''}`);
  if (d.topTrainer) tile('Più catture', d.topTrainer.name, `${catt(d.topTrainer.value)}${d.topTrainer.tie ? ' (pari merito)' : ''}`);
  if (d.rarest) tile('Più raro', `${d.rarest.name}${d.rarest.shiny ? ' ✨' : ''}`, `di ${d.rarest.player}`, d.rarest.image);
  if (d.topType) tile('Tipo preferito', TYPE_IT[d.topType.type] || d.topType.type, catt(d.topType.count));
  box.appendChild(grid);
  return box;
}

function renderEvent(d) {
  const a = d.active;
  const box = el('div', `rt-panel rt-event ev-${a.type}`);
  box.appendChild(head(`${EVENT_ICON[a.type] || '🎉'} ${a.label}`, a.endsAt ? `fino alle ${hm(a.endsAt)}` : ''));
  box.appendChild(el('div', 'rt-event-bonus', a.bonusText));
  box.appendChild(el('div', 'rt-event-hint', a.type === 'legendary' ? 'I Pokémon leggendari appaiono più spesso: tieni pronte le Poké Ball!' : 'Gli shiny appaiono più spesso: occhi aperti!'));
  if (d.community) {
    box.appendChild(el('div', 'rt-goal-line', `Obiettivo community: ${n(d.community.progress)} / ${n(d.community.goal)}`));
    box.appendChild(progress(d.community.pct));
  }
  return box;
}

const RENDER = { leaderboard: renderLeaderboard, captures: renderCaptures, shiny: renderShiny, goals: renderGoals, stats: renderStats, event: renderEvent };

export class RotationLayer {
  constructor(parent) {
    this.root = el('div', 'rt-layer hidden');
    this.root.setAttribute('aria-live', 'polite');
    this.timerEl = el('div', 'rt-timer');
    this.badge = el('div', 'rt-badge hidden');
    this.celebrateEl = el('div', 'rt-celebrate hidden');
    parent.append(this.root, this.badge, this.celebrateEl);
    this.state = { visible: false, rev: -1, screen: null, suppressed: false };
    this.ranks = new Map(); // ranghi della classifica mostrata (animazione dei cambi di posizione)
    this.badgeTimer = null;
    this.skew = 0;
    this.renders = 0;
  }

  reset() { this.state.rev = -1; }

  setSkew(ms) { this.skew = ms || 0; }

  apply(d, { animate = true } = {}) {
    if (!d || typeof d !== 'object') return;
    if (!d.preview && Number.isFinite(d.rev) && d.rev <= this.state.rev && this.state.rev >= 0) return;
    if (Number.isFinite(d.rev)) this.state.rev = d.rev;
    if (!d.visible || !RENDER[d.screen] || !d.data) { this.hide(); return; }
    const changed = d.screen !== this.state.screen || !this.state.visible;
    const prev = d.screen === 'leaderboard' && !changed ? this.ranks : new Map();
    const panel = RENDER[d.screen](d.data, prev);
    if (d.screen === 'leaderboard') this.ranks = new Map(d.data.rows.map((r) => [r.userId, r.rank]));
    this.state.visible = true;
    this.state.screen = d.screen;
    this.renders++;
    const t = ['fade', 'slide', 'zoom', 'none'].includes(d.transition) ? d.transition : 'fade';
    this.root.className = `rt-layer pos-${['left', 'right', 'bottom'].includes(d.position) ? d.position : 'left'} tr-${t}${this.state.suppressed ? ' suppressed' : ''}`;
    // Barra del tempo: solo CSS, calcolata sull'ora del server.
    if (d.endsAt && d.durationS) {
      const left = Math.max(0, Date.parse(d.endsAt) - (Date.now() + this.skew));
      this.timerEl.style.setProperty('--dur', `${left}ms`);
      this.timerEl.style.setProperty('--from', String(Math.min(1, left / (d.durationS * 1000))));
      this.timerEl.className = 'rt-timer run';
      void this.timerEl.offsetWidth; // riavvia l'animazione
    } else {
      this.timerEl.className = 'rt-timer';
    }
    if (changed && animate && d.enter !== false && t !== 'none') {
      const old = this.root.querySelector('.rt-panel:not(.out)');
      if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 450); }
      panel.classList.add('in');
      this.root.append(panel, this.timerEl);
    } else {
      for (const p of this.root.querySelectorAll('.rt-panel')) p.remove();
      if (!changed) panel.classList.add('refresh');
      this.root.append(panel, this.timerEl);
    }
  }

  hide() {
    this.state.visible = false;
    this.state.screen = null;
    this.ranks = new Map();
    if (this.root.classList.contains('hidden')) return;
    this.root.classList.add('leave');
    setTimeout(() => { if (!this.state.visible) { this.root.className = 'rt-layer hidden'; this.root.replaceChildren(); } }, 450);
  }

  // Una schermata delle classifiche (centrale) è visibile: il pannello si fa da parte.
  suppress(on) {
    this.state.suppressed = !!on;
    this.root.classList.toggle('suppressed', !!on);
  }

  // Badge dell'evento attivo, sempre visibile mentre l'evento dura.
  setEvents(ev) {
    clearInterval(this.badgeTimer);
    this.badgeTimer = null;
    const a = ev?.enabled ? ev.active : null;
    if (!a) { this.badge.className = 'rt-badge hidden'; this.badge.replaceChildren(); return; }
    this.badge.className = `rt-badge ev-${a.type}${a.paused ? ' paused' : ''}`;
    const label = el('span', 'rt-badge-l', `${EVENT_ICON[a.type] || '🎉'} ${a.label}`);
    const time = el('span', 'rt-badge-t');
    this.badge.replaceChildren(label, el('span', 'rt-badge-b', a.bonusText), time);
    if (a.paused || !a.endsAt) { time.textContent = 'in pausa'; return; }
    const tick = () => {
      const s = Math.max(0, Math.ceil((Date.parse(a.endsAt) - (Date.now() + this.skew)) / 1000));
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s <= 0) { clearInterval(this.badgeTimer); this.badgeTimer = null; }
    };
    tick();
    this.badgeTimer = setInterval(tick, 1000);
  }

  // Obiettivo della community raggiunto: premio grafico per qualche secondo.
  celebrate(d) {
    if (!d || typeof d !== 'object') return;
    this.celebrateEl.replaceChildren(el('div', 'rt-cel-title', `🎉 ${String(d.title || 'Obiettivo raggiunto!').slice(0, 80)}`), el('div', 'rt-cel-text', String(d.text || '').slice(0, 140)));
    const conf = el('div', 'rt-cel-confetti');
    for (let i = 0; i < 36; i++) { const c = el('i'); c.style.setProperty('--x', `${Math.random() * 100}%`); c.style.setProperty('--d', `${Math.random() * 1.5}s`); c.style.setProperty('--h', String(Math.round(Math.random() * 360))); conf.appendChild(c); }
    this.celebrateEl.appendChild(conf);
    this.celebrateEl.className = 'rt-celebrate show';
    clearTimeout(this.celebrateTimer);
    this.celebrateTimer = setTimeout(() => { this.celebrateEl.className = 'rt-celebrate hidden'; this.celebrateEl.replaceChildren(); }, 7000);
  }

  info() {
    return {
      visible: this.state.visible, screen: this.state.screen, rev: this.state.rev, suppressed: this.state.suppressed, renders: this.renders,
      panels: this.root.querySelectorAll('.rt-panel').length, badge: !this.badge.classList.contains('hidden'), badgeTimer: !!this.badgeTimer,
    };
  }
}
