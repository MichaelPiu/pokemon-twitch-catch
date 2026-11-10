// Schermate delle classifiche nell'overlay OBS: classifica Top 10, podio,
// vincitore, riepilogo della sessione e Hall of Fame. Ricevono il payload
// calcolato dal server (messaggio WebSocket "leaderboard" o snapshot iniziale):
// nessun calcolo qui, solo disegno. Testi sempre via textContent (mai HTML).
//
// La schermata resta visibile finché il server non invia visible: false
// (pulsante Nascondi o !leaderboard hide): nessuna chiusura automatica, e la
// fine della diretta o l'azzeramento dell'overlay non la toccano.

const KIND = { twitch: 'DIRETTA TWITCH', manual: 'SESSIONE MANUALE' };
const STATUS = { live: 'LIVE', frozen: 'RISULTATI CONGELATI', final: 'CLASSIFICA FINALE' };
const RAR = { common: 'Comune', uncommon: 'Non comune', rare: 'Raro', epic: 'Molto raro', legendary: 'Leggendario', mythical: 'Mitico' };
const HOF = { all: 'Tutte le sessioni', twitch: 'Dirette Twitch', manual: 'Sessioni manuali' };

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const n = (x) => Number(x || 0).toLocaleString('it-IT');
const catt = (x) => `${n(x)} ${Number(x) === 1 ? 'cattura' : 'catture'}`;
const dt = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const dur = (s) => { const m = Math.floor((s || 0) / 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

function monImg(p, cls = 'lb-mon') {
  if (!p?.image) return el('span', `${cls} empty`);
  const img = el('img', cls);
  img.src = p.image;
  img.alt = '';
  img.decoding = 'async';
  img.onerror = () => { img.onerror = null; img.src = '/assets/img/unknown.svg'; };
  return img;
}

function header(d, title) {
  const h = el('div', 'lb-head');
  h.appendChild(el('div', 'lb-title', title));
  const tags = el('div', 'lb-tags');
  if (d.session) {
    tags.appendChild(el('span', `lb-tag kind-${d.session.kind}`, KIND[d.session.kind] || d.session.kind));
    tags.appendChild(el('span', `lb-tag st-${d.session.status}`, STATUS[d.session.status] || d.session.status));
    tags.appendChild(el('span', 'lb-tag muted', `#${d.session.id} · ${dt(d.session.startedAt)}`));
  }
  if (d.preview) tags.appendChild(el('span', 'lb-tag preview', 'ANTEPRIMA'));
  h.appendChild(tags);
  return h;
}

function boardRows(rows, board) {
  const list = el('ol', 'lb-list');
  if (!rows.length) list.appendChild(el('li', 'lb-empty', 'Nessuna cattura ancora: lancia una Poké Ball!'));
  rows.slice(0, 10).forEach((r, i) => {
    const li = el('li', `lb-row r${r.rank}`);
    li.style.setProperty('--i', String(i));
    li.appendChild(el('span', 'lb-rank', r.rank));
    li.appendChild(el('span', 'lb-name', r.name));
    li.appendChild(el('span', `lb-val ${board === 'captures' ? 'main' : ''}`, catt(r.captures)));
    li.appendChild(el('span', `lb-val ${board === 'points' ? 'main' : ''}`, `${n(r.points)} pt`));
    li.appendChild(el('span', 'lb-val shiny', r.shiny ? `✨ ${r.shiny}` : ''));
    list.appendChild(li);
  });
  return list;
}

function renderBoard(d) {
  const box = el('div', 'lb-panel board');
  const board = d.board === 'captures' ? 'captures' : 'points';
  box.appendChild(header(d, board === 'captures' ? '🏆 Classifica catture' : '🏆 Classifica punti'));
  box.appendChild(boardRows(d[board] || [], board));
  return box;
}

function renderPodium(d) {
  const board = d.board === 'captures' ? 'captures' : 'points';
  const box = el('div', 'lb-panel podium');
  box.appendChild(header(d, `🏆 Podio · ${board === 'captures' ? 'catture' : 'punti'}`));
  const row = el('div', 'lb-podium');
  const top = (d[board] || []).slice(0, 3);
  for (const pos of [2, 1, 3]) {
    const r = top[pos - 1];
    const col = el('div', `lb-step p${pos}${r ? '' : ' vacant'}`);
    col.style.setProperty('--i', String(pos === 1 ? 2 : pos === 2 ? 1 : 0));
    if (r) {
      col.appendChild(monImg(r.rarest));
      col.appendChild(el('div', 'lb-pname', r.name));
      col.appendChild(el('div', 'lb-pval', `${n(r.points)} pt · ${catt(r.captures)}`));
    }
    col.appendChild(el('div', 'lb-block', pos));
    row.appendChild(col);
  }
  box.appendChild(row);
  return box;
}

function renderWinner(d) {
  const box = el('div', 'lb-panel winner');
  box.appendChild(header(d, '🏆 Vincitore'));
  const w = d.winner;
  if (!w) { box.appendChild(el('div', 'lb-empty', 'Nessuna cattura in questa sessione')); return box; }
  const card = el('div', 'lb-win');
  card.appendChild(monImg(w.rarest, 'lb-mon big'));
  const info = el('div', 'lb-win-info');
  info.appendChild(el('div', 'lb-win-name', w.name));
  info.appendChild(el('div', 'lb-win-stats', `${n(w.points)} punti · ${catt(w.captures)}${w.shiny ? ` · ✨ ${w.shiny} shiny` : ''}`));
  if (w.rarest) info.appendChild(el('div', 'lb-win-rare', `Pokémon più raro: ${w.rarest.name}${w.rarest.shiny ? ' ✨' : ''} (${RAR[w.rarest.rarity] || w.rarest.rarity || '—'})`));
  card.appendChild(info);
  box.appendChild(card);
  const conf = el('div', 'lb-confetti');
  for (let i = 0; i < 40; i++) { const c = el('i'); c.style.setProperty('--x', `${Math.random() * 100}%`); c.style.setProperty('--d', `${Math.random() * 2}s`); c.style.setProperty('--h', String(Math.round(Math.random() * 360))); conf.appendChild(c); }
  box.appendChild(conf);
  return box;
}

function renderRecap(d) {
  const r = d.recap;
  const box = el('div', 'lb-panel recap');
  box.appendChild(header(d, '📊 Riepilogo della sessione'));
  if (!r) return box;
  const grid = el('div', 'lb-stats');
  const stat = (label, value) => { const s = el('div', 'lb-stat'); s.appendChild(el('div', 'v', value)); s.appendChild(el('div', 'l', label)); grid.appendChild(s); };
  stat('Durata', dur(r.durationS));
  stat('Partecipanti', n(r.participants));
  stat('Incontrati', n(r.encounters));
  stat('Catturati', n(r.captures));
  stat('Cattura', `${Math.round((r.captureRate || 0) * 100)}%`);
  stat('Shiny', n(r.shiny));
  box.appendChild(grid);
  const lines = el('div', 'lb-lines');
  const line = (label, value) => { const p = el('div', 'lb-line'); p.appendChild(el('b', null, `${label}: `)); p.appendChild(document.createTextNode(value)); lines.appendChild(p); };
  line('Vincitore punti', r.winners.points ? `${r.winners.points.name} (${n(r.winners.points.points)} pt)` : '—');
  line('Vincitore catture', r.winners.captures ? `${r.winners.captures.name} (${n(r.winners.captures.captures)})` : '—');
  line('Più catturato', r.mostCaught ? `${r.mostCaught.name} ×${r.mostCaught.count}` : '—');
  line('Più rari', r.rarest.length ? r.rarest.slice(0, 3).map((p) => `${p.name}${p.shiny ? ' ✨' : ''} (${p.player})`).join(', ') : '—');
  box.appendChild(lines);
  return box;
}

function renderHof(d) {
  const f = d.hallOfFame;
  const box = el('div', 'lb-panel hof');
  const h = header(d, '👑 Hall of Fame');
  h.querySelector('.lb-tags').appendChild(el('span', 'lb-tag kind-hof', HOF[f.kind] || f.kind));
  box.appendChild(h);
  const cols = el('div', 'lb-cols');
  const col = (title, rows, board) => { const c = el('div', 'lb-col'); c.appendChild(el('div', 'lb-sub', title)); c.appendChild(boardRows(rows.slice(0, 8), board)); cols.appendChild(c); };
  col('Per punti', f.byPoints, 'points');
  col('Per catture', f.byCaptures, 'captures');
  box.appendChild(cols);
  box.appendChild(el('div', 'lb-foot', `${catt(f.totals.captures)} · ${n(f.totals.shiny)} shiny · ${n(f.totals.players)} giocatori · ${n(f.totals.sessions)} sessioni`));
  return box;
}

const RENDER = { board: renderBoard, podium: renderPodium, winner: renderWinner, recap: renderRecap, halloffame: renderHof };

export class LeaderboardLayer {
  constructor(parent) {
    this.root = el('div', 'lb-layer hidden');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
    this.state = { visible: false, rev: -1, screen: null };
  }

  // Applica un payload del server. Un payload più vecchio (rev minore) viene
  // ignorato; lo stesso schermo con dati nuovi viene ridisegnato senza animazione
  // d'ingresso (aggiornamento live), un nuovo schermo con l'animazione.
  apply(d, { animate = true } = {}) {
    if (!d || typeof d !== 'object') return;
    if (!d.preview && Number.isFinite(d.rev) && d.rev < this.state.rev) return;
    const wasKey = this.state.visible ? `${this.state.screen}:${this.state.board}:${this.state.session}` : null;
    this.state = { visible: !!d.visible, rev: d.rev ?? this.state.rev, screen: d.screen, board: d.board, session: d.session?.id ?? d.hallOfFame?.kind };
    if (!d.visible || !RENDER[d.screen]) { this.hide(); return; }
    const key = `${d.screen}:${d.board}:${this.state.session}`;
    const panel = RENDER[d.screen](d);
    this.root.className = `lb-layer screen-${d.screen}${animate && key !== wasKey ? ' enter' : ''}`;
    this.root.replaceChildren(panel);
  }

  // Snapshot iniziale (connessione, riavvio, ripristino): è lo stato autorevole.
  reset() { this.state.rev = -1; }

  hide() {
    this.state.visible = false;
    if (this.root.classList.contains('hidden')) return;
    this.root.classList.add('leave');
    setTimeout(() => { if (!this.state.visible) { this.root.className = 'lb-layer hidden'; this.root.replaceChildren(); } }, 400);
  }

  info() { return { visible: this.state.visible, screen: this.state.visible ? this.state.screen : null, board: this.state.board, session: this.state.session, rev: this.state.rev, rows: this.root.querySelectorAll('.lb-row').length }; }
}
