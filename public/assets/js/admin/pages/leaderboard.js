// Classifiche: classifica della sessione (catture e punti), controlli della
// schermata nell'overlay OBS, congelamento dei risultati, Hall of Fame,
// riepiloghi delle sessioni, profili dei giocatori e regole di punteggio.
// Tutto passa dalle API /api/admin/leaderboard*: nessun calcolo nel browser.
import { h, mount, get, post, put, fmt, rarityBadge, debounce } from '../../lib.js';
import { card, table, stat, act, confirmDialog, promptDialog, modal, toast } from '../ui.js';
import { onLive } from '../main.js';
import { icon } from '../../icons.js';

const KIND = { twitch: 'TWITCH', manual: 'MANUALE' };
const STATUS = { live: ['LIVE', 'var(--ok)'], frozen: ['CONGELATA', '#60a5fa'], final: ['FINALE', 'var(--muted)'] };
const SCREEN_LABEL = { board: 'Classifica', podium: 'Podio', winner: 'Vincitore', recap: 'Riepilogo', halloffame: 'Hall of Fame' };
const RAR_LABEL = { common: 'Comune', uncommon: 'Non comune', rare: 'Raro', epic: 'Molto raro (Epico)', legendary: 'Leggendario', mythical: 'Mitico' };

const kindPill = (k) => h('span', { class: `mode-pill ${k === 'manual' ? 'manual' : ''}` }, KIND[k] || k);
const statusPill = (st) => { const [l, c] = STATUS[st] || [st, 'var(--muted)']; return h('span', { class: 'pill', style: { '--c': c, color: c, borderColor: c } }, l); };
const mon = (p) => (p ? h('span', {}, `${p.name}${p.shiny ? ' ✨' : ''} `, rarityBadge(p.rarity)) : '—');
const originPill = (o) => h('span', { class: 'badge', style: { '--c': o === 'local' ? '#f59e0b' : '#a855f7' } }, o === 'local' ? 'Locale' : 'Twitch');

function boardTable(rows, board, onPlayer) {
  return table([
    { label: '#', key: 'rank' },
    { label: 'Giocatore', render: (r) => h('span', {}, r.name, ' ', originPill(r.origin)) },
    { label: 'Catture', render: (r) => (board === 'captures' ? h('b', {}, r.captures) : r.captures) },
    { label: 'Punti', render: (r) => (board === 'points' ? h('b', {}, r.points) : r.points) },
    { label: 'Shiny', key: 'shiny' },
    { label: 'Specie', key: 'species' },
    { label: 'Pokémon più raro', render: (r) => mon(r.rarest) },
  ], rows, { onRow: onPlayer ? (r) => onPlayer(r.userId) : null, empty: 'Nessuna cattura in questa sessione' });
}

export async function leaderboard({ el, params }) {
  const st = { tab: params[0] || 'session', sessionId: 'current', kind: '', player: '', board: 'points' };
  let off = null;

  const tabs = () => h('div', { class: 'tabs', style: { marginBottom: '14px' } },
    [['session', 'Sessione'], ['hof', 'Hall of Fame'], ['recaps', 'Riepiloghi'], ['players', 'Giocatori'], ['rules', 'Punteggi e comandi']]
      .map(([k, l]) => h('button', { class: `btn sm ${st.tab === k ? 'on' : ''}`, onclick: () => { st.tab = k; render(); } }, l)));

  async function render() {
    const body = h('div', {});
    mount(el, tabs(), body);
    if (st.tab === 'session') await sessionTab(body);
    else if (st.tab === 'hof') await hofTab(body);
    else if (st.tab === 'recaps') await recapsTab(body);
    else if (st.tab === 'players') await playersTab(body);
    else await rulesTab(body);
  }

  // --- Sessione ----------------------------------------------------------------------
  async function sessionTab(body) {
    const qs = new URLSearchParams({ sessionId: st.sessionId });
    if (st.player) qs.set('player', st.player);
    const [d, list] = await Promise.all([get(`/api/admin/leaderboard?${qs}`), get(`/api/admin/leaderboard/sessions${st.kind ? `?kind=${st.kind}` : ''}`)]);
    const v = d.view;
    const sid = v?.session.id;
    const disp = d.display;
    const onThis = disp.visible && disp.sessionId === sid;
    const reload = () => render();
    const afterShow = (r) => { if (r) toast(r.overlays ? `Mostrata su ${r.overlays} overlay` : 'Schermata attiva (nessun overlay collegato al momento)', 'ok'); reload(); };

    const sel = h('select', { onchange: (e) => { st.sessionId = e.target.value; reload(); } },
      h('option', { value: 'current', selected: st.sessionId === 'current' }, d.current ? `Sessione corrente (#${d.current})` : 'Sessione corrente (nessuna)'),
      list.sessions.map((s) => h('option', { value: String(s.id), selected: String(st.sessionId) === String(s.id) },
        `#${s.id} · ${KIND[s.kind]} · ${fmt.dt(s.startedAt)} · ${s.participants} giocatori${s.status === 'frozen' ? ' · congelata' : ''}`)));
    const kindSel = h('select', { onchange: (e) => { st.kind = e.target.value; reload(); } },
      [['', 'Twitch e Manuale'], ['twitch', 'Solo Twitch'], ['manual', 'Solo Manuale']].map(([k, l]) => h('option', { value: k, selected: st.kind === k }, l)));
    const search = h('input', { placeholder: 'Filtra per giocatore…', value: st.player, oninput: debounce((e) => { st.player = e.target.value.trim(); reload(); }, 350) });

    const overlayState = disp.visible
      ? h('div', { class: 'notice', style: { marginTop: '12px' } }, icon('monitor', { size: 16 }), ' Overlay: ', h('b', {}, SCREEN_LABEL[disp.screen]),
        disp.screen === 'halloffame' ? ` (${disp.hofKind})` : ` della sessione #${disp.sessionId}`, ` · ${disp.board === 'captures' ? 'catture' : 'punti'} · visibile dalle ${fmt.time(disp.shownAt)}`,
        disp.via === 'chat' ? ` (comando chat di ${String(disp.shownBy).replace('twitch:', '')})` : '', ' — resta visibile finché non premi Nascondi.')
      : h('div', { class: 'muted small', style: { marginTop: '12px' } }, `Overlay: nessuna classifica visibile · ${d.overlays} overlay collegati`);

    const controls = v ? h('div', { class: 'row', style: { marginTop: '14px', flexWrap: 'wrap', gap: '8px' } },
      h('div', { class: 'tabs' }, ['points', 'captures'].map((b) => h('button', { class: `btn sm ${st.board === b ? 'on' : ''}`, onclick: () => { st.board = b; reload(); } }, b === 'points' ? 'Classifica punti' : 'Classifica catture'))),
      h('button', { class: 'btn primary', onclick: async () => afterShow(await act(() => post('/api/admin/leaderboard/show', { sessionId: sid, screen: 'board', board: st.board }), null)) }, icon('trophy', { size: 16 }), ' Mostra classifica'),
      h('button', { class: 'btn', onclick: async () => afterShow(await act(() => post('/api/admin/leaderboard/show', { sessionId: sid, screen: 'podium', board: st.board }), null)) }, 'Podio'),
      h('button', { class: 'btn', onclick: async () => afterShow(await act(() => post('/api/admin/leaderboard/winner', { sessionId: sid, board: st.board }), null)) }, icon('star', { size: 16 }), ' Mostra vincitore'),
      h('button', { class: 'btn', onclick: async () => afterShow(await act(() => post('/api/admin/leaderboard/show', { sessionId: sid, screen: 'recap', board: st.board }), null)) }, 'Riepilogo sessione'),
      h('button', { class: 'btn danger', disabled: !disp.visible, onclick: async () => { if (await act(() => post('/api/admin/leaderboard/hide'), 'Classifica nascosta')) reload(); } }, 'Nascondi classifica'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: () => preview({ sessionId: sid, screen: disp.visible && onThis ? disp.screen : 'board', board: st.board }) }, icon('monitor', { size: 16 }), ' Anteprima overlay'),
      h('button', { class: 'btn ghost', onclick: async () => { if (await act(() => post('/api/admin/leaderboard/refresh', { sessionId: sid }), v.session.frozen ? 'Risultati congelati: nessuna variazione' : 'Classifica aggiornata')) reload(); } }, 'Aggiorna'),
      v.session.frozen
        ? h('button', { class: 'btn', onclick: () => unfreeze(sid) }, 'Sblocca risultati')
        : h('button', { class: 'btn accent', onclick: async () => {
          if (!await confirmDialog(`Congelare i risultati della sessione #${sid}? La classifica verrà salvata in modo definitivo e non si aggiornerà più automaticamente.`, { okLabel: 'Congela risultati' })) return;
          if (await act(() => post('/api/admin/leaderboard/freeze', { sessionId: sid }), 'Risultati congelati')) reload();
        } }, '🔒 Congela risultati')) : null;

    const s = v?.session;
    mount(body,
      card('Classifica della sessione',
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, sel, kindSel, search),
        d.error ? h('div', { class: 'notice warn', style: { marginTop: '12px' } }, d.error) : null,
        s ? h('div', { class: 'grid c4', style: { marginTop: '14px' } },
          stat('Sessione', h('span', {}, `#${s.id} `, kindPill(s.kind)), `${fmt.dt(s.startedAt)}${s.endedAt ? ` → ${fmt.time(s.endedAt)}` : ' · in corso'}`),
          stat('Stato classifica', statusPill(s.status), s.frozen ? `congelata ${fmt.dt(s.frozen.at)} da ${s.frozen.by || '—'} (v${s.frozen.version}, ${s.frozen.via})` : s.open ? 'aggiornata in tempo reale' : 'sessione terminata'),
          stat('Partecipanti', fmt.n(v.totals.participants), `${fmt.n(v.totals.captures)} catture · ${fmt.n(v.totals.shiny)} shiny`),
          stat('Punti assegnati', fmt.n(v.totals.points), `regole v${v.rulesVersion}${v.pendingSinceFreeze ? ` · ${v.pendingSinceFreeze} catture dopo il congelamento` : ''}`)) : null,
        overlayState, controls),
      v ? card(st.board === 'points' ? 'Classifica punti' : 'Classifica catture', boardTable(st.board === 'points' ? v.points : v.captures, st.board, (uid) => playerModal(uid, reload))) : null,
      v && d.snapshots.length ? card('Istantanee congelate', table([
        { label: 'Versione', key: 'version' },
        { label: 'Stato', render: (x) => (x.status === 'active' ? 'attiva' : 'sbloccata') },
        { label: 'Congelata', render: (x) => `${fmt.dt(x.created_at)} · ${x.created_by || '—'} (${x.created_via})` },
        { label: 'Sbloccata', render: (x) => (x.unlocked_at ? `${fmt.dt(x.unlocked_at)} · ${x.unlocked_by || '—'}: ${x.unlock_reason}` : '—') },
        { label: 'Checksum', render: (x) => h('code', {}, x.checksum.slice(0, 12)) },
      ], d.snapshots)) : null);
  }

  async function unfreeze(sid) {
    const reason = await promptDialog('Motivazione dello sblocco (obbligatoria, registrata nel registro operazioni):', { placeholder: 'es. cattura annullata per errore', okLabel: 'Sblocca risultati', danger: true });
    if (!reason) return;
    if (await act(() => post('/api/admin/leaderboard/unfreeze', { sessionId: sid, reason, confirm: true }), 'Risultati sbloccati: la classifica torna live')) render();
  }

  // Anteprima: l'overlay vero in modalità preview, che riceve i dati solo da questa pagina.
  async function preview(q) {
    let data;
    try { data = await get(`/api/admin/leaderboard/preview?${new URLSearchParams({ sessionId: q.sessionId ?? 'current', screen: q.screen, board: q.board || 'points', hofKind: q.hofKind || 'all' })}`); } catch (e) { toast(e.message, 'err'); return; }
    const frame = h('iframe', { src: '/overlay?preview=1', title: 'Anteprima overlay', style: { width: '100%', aspectRatio: '16 / 9', border: '0', borderRadius: '10px', background: '#1b1d2b' } });
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || e.data?.source !== 'livecatch-overlay' || e.data.type !== 'ready') return;
      frame.contentWindow.postMessage({ source: 'livecatch-preview', type: 'leaderboard', data }, location.origin);
    };
    window.addEventListener('message', onMsg);
    modal(`Anteprima: ${SCREEN_LABEL[q.screen]} (non pubblicata)`, h('div', {}, frame, h('p', { class: 'muted small' }, 'Solo anteprima: l\'overlay in OBS non cambia finché non premi un pulsante "Mostra".')),
      { onClose: () => window.removeEventListener('message', onMsg) });
  }

  // --- Hall of Fame ----------------------------------------------------------------------
  async function hofTab(body) {
    const kind = st.hofKind || 'all';
    const d = await get(`/api/admin/leaderboard/halloffame?kind=${kind}&limit=25`);
    mount(body,
      card('Hall of Fame',
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('div', { class: 'tabs' }, [['all', 'Tutte le sessioni'], ['twitch', 'Twitch'], ['manual', 'Manuale']].map(([k, l]) => h('button', { class: `btn sm ${kind === k ? 'on' : ''}`, onclick: () => { st.hofKind = k; render(); } }, l))),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn ghost', onclick: () => preview({ screen: 'halloffame', hofKind: kind }) }, 'Anteprima overlay'),
          h('button', { class: 'btn primary', onclick: async () => { const r = await act(() => post('/api/admin/leaderboard/show', { screen: 'halloffame', hofKind: kind }), 'Hall of Fame mostrata sull\'overlay'); if (r) render(); } }, icon('trophy', { size: 16 }), ' Mostra Hall of Fame'),
          h('button', { class: 'btn danger', onclick: async () => { if (await act(() => post('/api/admin/leaderboard/hide'), 'Nascosta')) render(); } }, 'Nascondi')),
        h('div', { class: 'grid c4', style: { marginTop: '14px' } },
          stat('Catture totali', fmt.n(d.totals.captures)), stat('Shiny totali', fmt.n(d.totals.shiny)),
          stat('Giocatori', fmt.n(d.totals.players)), stat('Sessioni', fmt.n(d.totals.sessions))),
        h('p', { class: 'muted small' }, 'Solo catture reali delle dirette Twitch e delle sessioni manuali: esclusi DEMO, registrazioni manuali del Pokédex e importazioni.')),
      h('div', { class: 'grid c2' },
        card('Top per punti', hofTable(d.byPoints, 'points')),
        card('Top per catture', hofTable(d.byCaptures, 'captures'))),
      card('Pokémon più rari catturati', table([
        { label: 'Pokémon', render: (r) => mon(r) }, { label: 'Giocatore', key: 'player' },
        { label: 'Sessione', render: (r) => KIND[r.sessionKind] }, { label: 'Data', render: (r) => fmt.dt(r.caughtAt) },
      ], d.rarest)));
  }
  const hofTable = (rows, board) => table([
    { label: '#', key: 'rank' }, { label: 'Giocatore', render: (r) => h('span', {}, r.name, ' ', originPill(r.origin)) },
    { label: 'Catture', render: (r) => (board === 'captures' ? h('b', {}, r.captures) : r.captures) },
    { label: 'Punti', render: (r) => (board === 'points' ? h('b', {}, r.points) : r.points) },
    { label: 'Shiny', key: 'shiny' }, { label: 'Sessioni', key: 'sessions' }, { label: 'Più raro', render: (r) => mon(r.rarest) },
  ], rows, { onRow: (r) => playerModal(r.userId, render), empty: 'Ancora nessuna cattura' });

  // --- Riepiloghi ----------------------------------------------------------------------
  async function recapsTab(body) {
    const d = await get(`/api/admin/recaps${st.kind ? `?kind=${st.kind}` : ''}`);
    mount(body, card('Riepiloghi delle sessioni',
      h('div', { class: 'row' }, h('select', { onchange: (e) => { st.kind = e.target.value; render(); } },
        [['', 'Twitch e Manuale'], ['twitch', 'Solo Twitch'], ['manual', 'Solo Manuale']].map(([k, l]) => h('option', { value: k, selected: st.kind === k }, l)))),
      h('p', { class: 'muted small' }, 'Il riepilogo viene salvato automaticamente alla chiusura di ogni sessione e resta consultabile anche senza Twitch.'),
      table([
        { label: '#', key: 'sessionId' }, { label: 'Tipo', render: (r) => kindPill(r.kind) },
        { label: 'Data', render: (r) => fmt.dt(r.startedAt) }, { label: 'Durata', render: (r) => fmt.dur(r.durationS) },
        { label: 'Partecipanti', key: 'participants' }, { label: 'Catture', key: 'captures' }, { label: 'Shiny', key: 'shiny' },
        { label: 'Vincitore punti', render: (r) => r.winnerPoints || '—' }, { label: 'Vincitore catture', render: (r) => r.winnerCaptures || '—' },
      ], d.recaps, { onRow: (r) => recapModal(r.sessionId), empty: 'Nessun riepilogo salvato' })));
  }

  async function recapModal(sid) {
    const d = await get(`/api/admin/recaps/${sid}`);
    const w = d.winners;
    modal(`Riepilogo sessione #${sid} · ${KIND[d.session.kind]}`, h('div', {},
      h('div', { class: 'grid c4' },
        stat('Durata', fmt.dur(d.durationS), `${fmt.dt(d.session.startedAt)}`), stat('Partecipanti', fmt.n(d.participants)),
        stat('Incontrati', fmt.n(d.encounters), `${d.shinyEncounters} shiny`), stat('Catturati', fmt.n(d.captures), `${fmt.pct(d.captureRate)} dei lanci · ${d.shiny} shiny`)),
      h('p', {}, h('b', {}, 'Vincitore punti: '), w.points ? `${w.points.name} (${w.points.points} punti)` : '—', ' · ', h('b', {}, 'Vincitore catture: '), w.captures ? `${w.captures.name} (${w.captures.captures})` : '—'),
      h('p', {}, h('b', {}, 'Più catturato: '), d.mostCaught ? `${d.mostCaught.name} ×${d.mostCaught.count}` : '—'),
      h('p', {}, h('b', {}, 'Più rari: '), d.rarest.length ? d.rarest.map((p) => `${p.name}${p.shiny ? ' ✨' : ''} (${p.player})`).join(', ') : '—'),
      boardTable(d.top10.points, 'points'),
      h('p', { class: 'muted small' }, d.stored ? `Salvato ${fmt.dt(d.updatedAt)} · classifica ${d.leaderboardSource === 'snapshot' ? 'congelata' : 'live'}` : 'Riepilogo provvisorio (sessione in corso o precedente a questa versione): non ancora salvato.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { if (await act(() => post('/api/admin/leaderboard/show', { sessionId: sid, screen: 'recap' }), 'Riepilogo mostrato sull\'overlay')) document.querySelector('.modal-bg')?.click(); } }, 'Mostra sull\'overlay'),
        d.session.endedAt ? h('button', { class: 'btn ghost', onclick: async () => { if (await act(() => post(`/api/admin/recaps/${sid}/regenerate`), 'Riepilogo rigenerato')) { document.querySelector('.modal-bg')?.click(); recapModal(sid); } } }, 'Rigenera') : null)));
  }

  // --- Giocatori ----------------------------------------------------------------------
  async function playersTab(body) {
    const qs = new URLSearchParams();
    if (st.q) qs.set('q', st.q);
    if (st.origin) qs.set('origin', st.origin);
    const d = await get(`/api/admin/players?${qs}`);
    const input = h('input', { placeholder: 'Cerca per nome, nickname precedente o Twitch User ID…', value: st.q || '', oninput: debounce((e) => { st.q = e.target.value.trim(); render(); }, 350) });
    mount(body, card('Giocatori',
      h('div', { class: 'row', style: { gap: '8px' } }, input,
        h('select', { onchange: (e) => { st.origin = e.target.value; render(); } },
          [['', 'Tutti'], ['twitch', 'Twitch'], ['local', 'Locali (sessioni manuali)']].map(([k, l]) => h('option', { value: k, selected: (st.origin || '') === k }, l)))),
      table([
        { label: 'Nome', render: (r) => h('span', {}, r.name, r.customName ? h('span', { class: 'muted small' }, ` (Twitch: ${r.twitchName || r.login})`) : null) },
        { label: 'Tipo', render: (r) => originPill(r.origin) },
        { label: 'Identificativo', render: (r) => h('code', {}, r.twitchId || r.localId) },
        { label: 'Catture', key: 'captures' }, { label: 'Punti', key: 'points' },
        { label: 'Ultima attività', render: (r) => fmt.dt(r.lastSeenAt) },
      ], d.players, { onRow: (r) => playerModal(r.id, render), empty: 'Nessun giocatore' })));
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
  }

  async function playerModal(uid, after) {
    const p = await get(`/api/admin/players/${uid}`);
    const nameIn = h('input', { value: p.customName || '', placeholder: p.twitchName || p.login, maxlength: 25 });
    const s = p.stats;
    modal(`Giocatore: ${p.name}`, h('div', {},
      h('p', {}, originPill(p.origin), ' ', p.twitchId ? h('span', {}, 'Twitch User ID ', h('code', {}, p.twitchId)) : h('span', {}, 'ID locale ', h('code', {}, p.localId)),
        p.twitchName ? h('span', { class: 'muted' }, ` · nickname Twitch attuale: ${p.twitchName}`) : null),
      h('div', { class: 'grid c3' },
        stat('Totale', `${s.all.points} punti`, `${s.all.captures} catture · ${s.all.shiny} shiny · ${s.all.species} specie`),
        stat('Dirette Twitch', `${s.twitch.points} punti`, `${s.twitch.captures} catture`),
        stat('Sessioni manuali', `${s.manual.points} punti`, `${s.manual.captures} catture`)),
      h('label', { class: 'field' }, 'Nome visualizzato nelle classifiche (vuoto = nickname Twitch)', nameIn),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          const r = await act(() => put(`/api/admin/players/${uid}/name`, { name: nameIn.value.trim() || null }), 'Nome aggiornato (i dati storici non cambiano)');
          if (r) { document.querySelector('.modal-bg')?.click(); after?.(); }
        } }, 'Salva nome')),
      h('h3', {}, 'Storico dei nomi'),
      table([{ label: 'Tipo', render: (a) => (a.kind === 'admin' ? 'Rinomina admin' : 'Nickname Twitch precedente') }, { label: 'Nome', key: 'display_name' },
        { label: 'Fino a', render: (a) => fmt.dt(a.last_seen_at) }, { label: 'Da', render: (a) => a.changed_by || '—' }], p.aliases, { empty: 'Nessun cambio di nome' }),
      h('h3', {}, 'Sessioni'),
      table([{ label: '#', key: 'id' }, { label: 'Tipo', render: (x) => kindPill(x.kind) }, { label: 'Data', render: (x) => fmt.dt(x.started_at) },
        { label: 'Lanci', key: 'attempts' }, { label: 'Catture', key: 'captures' }, { label: 'Punti', key: 'points' }], p.sessions, { empty: 'Nessuna sessione' }),
      h('h3', {}, 'Ultime catture in classifica'),
      table([{ label: 'Pokémon', render: (e) => `${e.pokemon}${e.is_shiny ? ' ✨' : ''}` }, { label: 'Rarità', render: (e) => (e.rarity ? rarityBadge(e.rarity) : '—') },
        { label: 'Punti', render: (e) => `${e.points} (${e.base_points}+${e.rarity_bonus}+${e.shiny_bonus}, v${e.rules_version})` },
        { label: 'Sessione', render: (e) => `#${e.session_id} ${KIND[e.session_kind]}` }, { label: 'Data', render: (e) => fmt.dt(e.caught_at) },
        { label: 'Stato', render: (e) => (e.voided_at ? `annullata (${e.void_reason})` : e.source === 'backfill' ? 'storica' : 'valida') }], p.recent, { empty: 'Nessuna cattura' })));
  }

  // --- Punteggi e comandi ----------------------------------------------------------------
  async function rulesTab(body) {
    const d = await get('/api/admin/leaderboard/rules');
    const r = structuredClone(d.rules);
    const num = (obj, key) => h('input', { type: 'number', min: 0, max: 10000, step: 1, value: obj[key], oninput: (e) => { obj[key] = Number(e.target.value); } });
    const c = structuredClone(d.commands);
    const ids = h('input', { value: (c.moderatorIds || []).join(', '), placeholder: 'vuoto = tutti i moderatori' });
    mount(body,
      card(`Regole di punteggio (versione ${r.version})`,
        h('p', { class: 'muted small' }, 'Punteggio = punti base + bonus rarità + bonus shiny. La rarità è quella del Pokémon al momento dell\'incontro. Ogni modifica crea una nuova versione: i punti già assegnati non cambiano.'),
        h('div', { class: 'form grid c3' },
          h('label', { class: 'field' }, 'Punti base (cattura)', num(r, 'base')),
          h('label', { class: 'field' }, 'Bonus shiny', num(r, 'shiny')),
          ...Object.keys(RAR_LABEL).map((k) => h('label', { class: 'field' }, `Bonus ${RAR_LABEL[k]}`, num(r.rarity, k)))),
        h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: async () => {
          const out = await act(() => put('/api/admin/leaderboard/rules', r), null);
          if (out) { toast(out.changed ? `Nuove regole salvate (versione ${out.rules.version})` : 'Nessuna modifica', 'ok'); render(); }
        } }, 'Salva regole'))),
      card('Storico delle regole', table([
        { label: 'Versione', key: 'version' }, { label: 'Base', key: 'base' }, { label: 'Shiny', key: 'shiny' },
        { label: 'Rarità', render: (x) => Object.entries(x.rarity).map(([k, n]) => `${RAR_LABEL[k].split(' ')[0]} +${n}`).join(' · ') },
        { label: 'Creata', render: (x) => `${fmt.dt(x.createdAt)} · ${x.createdBy || '—'}` },
      ], d.history)),
      card('Comando chat !leaderboard',
        h('p', { class: 'muted small' }, '!leaderboard mostra la classifica, !leaderboard hide la nasconde, !leaderboard winner mostra il vincitore: broadcaster e moderatori autorizzati. !leaderboard freeze: solo il broadcaster. Funziona solo durante una diretta Twitch; il ruolo è verificato dai dati dell\'evento Twitch, mai dal nickname.'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.allowModerators, onchange: (e) => { c.allowModerators = e.target.checked; } }), ' Consenti ai moderatori'),
        h('label', { class: 'field' }, 'Solo questi moderatori (Twitch User ID, separati da virgola)', ids),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.replies, onchange: (e) => { c.replies = e.target.checked; } }), ' Risposte brevi in chat'),
        h('button', { class: 'btn primary', onclick: async () => {
          const moderatorIds = ids.value.split(/[\s,]+/).filter(Boolean);
          if (await act(() => put('/api/admin/leaderboard/commands', { ...c, moderatorIds }), 'Impostazioni del comando salvate')) render();
        } }, 'Salva')));
  }

  await render();
  // Aggiornamento in tempo reale (catture, congelamenti, comandi chat) solo nella scheda Sessione.
  let pending = null;
  off = onLive((type) => {
    if (type !== 'leaderboard' || st.tab !== 'session') return;
    if (document.querySelector('.modal-bg') || el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    clearTimeout(pending);
    pending = setTimeout(() => render().catch(() => {}), 400);
  });
  return () => { off?.(); clearTimeout(pending); };
}
