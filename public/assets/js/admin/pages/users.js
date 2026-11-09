import { h, mount, get, post, del, fmt, rarityBadge, debounce } from '../../lib.js';
import { stat, card, table, pager, act, confirmDialog, modal } from '../ui.js';
import { REJECT_LABEL } from './common.js';

export async function users({ el, params }) {
  if (params[0]) return detail(el, params[0]);
  let q = '', offset = 0, demo = false;
  const list = h('div');
  const load = async () => {
    const d = await get(`/api/admin/users?q=${encodeURIComponent(q)}&offset=${offset}&limit=50&demo=${demo ? 1 : 0}`);
    mount(list, table([
      { label: 'Spettatore', render: (r) => h('span', {}, h('b', {}, r.display_name), h('span', { class: 'muted small' }, ` @${r.login}`)) },
      { label: 'Pokémon', key: 'total' },
      { label: 'Specie', key: 'species' },
      { label: 'Shiny', key: 'shiny' },
      { label: 'Prima interazione', render: (r) => fmt.date(r.first_seen_at) },
      { label: 'Ultima attività', render: (r) => fmt.ago(r.last_seen_at) },
      { label: 'Stato', render: (r) => (r.banned ? h('span', { class: 'badge', style: { '--c': 'var(--err)' } }, 'escluso') : '') },
    ], d.items, { onRow: (r) => { location.hash = `#/users/${r.id}`; }, empty: 'Nessuno spettatore trovato' }),
    pager(d.total, 50, offset, (o) => { offset = o; load(); }));
  };
  const search = h('input', { placeholder: 'Cerca username…', oninput: debounce((e) => { q = e.target.value; offset = 0; load(); }) });
  mount(el, card(null,
    h('div', { class: 'row', style: { marginBottom: '12px' } }, h('div', { style: { flex: 1, minWidth: '220px' } }, search),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { demo = e.target.checked; offset = 0; load(); } }), 'Mostra utenti DEMO')),
    list));
  await load();
}

async function detail(el, id) {
  const d = await get(`/api/admin/users/${id}`);
  const u = d.user, s = d.summary;
  const banned = d.bans.some((b) => b.active);
  const reload = () => detail(el, id);
  mount(el,
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('a', { class: 'btn sm', href: '#/users' }, '← Spettatori'),
      h('h2', { style: { margin: 0 } }, u.display_name), h('span', { class: 'muted' }, `@${u.login} · ID Twitch ${u.twitch_id}`),
      u.is_demo ? h('span', { class: 'badge', style: { '--c': '#7dd3fc' } }, 'DEMO') : null,
      banned ? h('span', { class: 'badge', style: { '--c': 'var(--err)' } }, 'escluso dal gioco') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => addPokemon(id, reload) }, '➕ Aggiungi Pokémon'),
      banned
        ? h('button', { class: 'btn sm', onclick: async () => { await act(() => del(`/api/admin/users/${id}/ban`), 'Utente riammesso'); reload(); } }, 'Riammetti')
        : h('button', { class: 'btn sm danger', onclick: async () => { const reason = prompt('Motivo dell\'esclusione (facoltativo):') ?? null; if (reason === null) return; await act(() => post(`/api/admin/users/${id}/ban`, { reason }), 'Utente escluso'); reload(); } }, 'Escludi dal gioco'),
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!await confirmDialog(`Vuoi davvero azzerare il Pokédex di ${u.display_name}? Verranno eliminati ${s.total} Pokémon. L'operazione non è reversibile (salvo ripristino di un backup).`, { danger: true, okLabel: 'Azzera Pokédex' })) return;
        await act(() => post(`/api/admin/users/${id}/reset`), 'Pokédex azzerato'); reload();
      } }, 'Reset Pokédex')),
    h('div', { class: 'grid c4' },
      stat('Pokémon', fmt.n(s.total)), stat('Specie scoperte', fmt.n(s.species)), stat('Shiny', fmt.n(s.shiny)),
      stat('Tentativi', fmt.n(s.attempts), `successo ${fmt.pct(s.successRate)}`), stat('Prima interazione', fmt.date(u.first_seen_at))),
    card('Pokémon più rari', s.rarest.length ? h('div', { class: 'row' }, s.rarest.map((r) => h('span', { class: 'pill' }, rarityBadge(r.rarity), r.name, r.shiny ? ' ✨' : '', ` ×${r.count}`))) : h('div', { class: 'empty' }, '—')),
    card('Pokédex', d.collection.length ? h('div', { class: 'mon-grid' }, d.collection.map((m) => h('div', { class: 'mon-card' },
      m.count > 1 ? h('span', { class: 'cnt' }, `×${m.count}`) : null,
      m.shinyCount ? h('span', { class: 'shiny', title: `${m.shinyCount} shiny` }, '✨') : null,
      h('img', { src: m.shinyCount ? m.shinyImage : m.image, alt: m.name, loading: 'lazy' }),
      h('div', { class: 'muted small' }, fmt.dex(m.dex)), h('div', { class: 'nm' }, m.name), rarityBadge(m.rarity),
      m.duplicates ? h('div', { class: 'muted small' }, `${m.duplicates} doppioni`) : null))) : h('div', { class: 'empty' }, 'Pokédex vuoto')),
    card('Storico catture', table([
      { label: 'Data', render: (r) => fmt.dt(r.caughtAt) },
      { label: 'Pokémon', render: (r) => h('span', {}, fmt.dex(r.dex), ' ', r.name, r.shiny ? ' ✨' : '') },
      { label: 'Rarità', render: (r) => rarityBadge(r.rarity) },
      { label: 'Ball', render: (r) => r.ball || '—' },
      { label: 'Origine', render: (r) => ({ capture: 'cattura', admin: 'admin', import: 'import' }[r.source]) },
      { label: '', render: (r) => h('button', { class: 'btn sm danger', onclick: async (e) => {
        e.stopPropagation();
        if (!await confirmDialog(`Rimuovere ${r.name} dalla collezione?`, { danger: true })) return;
        await act(() => del(`/api/admin/users/${id}/pokemon/${r.id}`), 'Rimosso'); reload();
      } }, 'Rimuovi') },
    ], d.captures)),
    card('Storico tentativi', table([
      { label: 'Data', render: (r) => fmt.dt(r.created_at) },
      { label: 'Pokémon', render: (r) => r.pokemon || '—' },
      { label: 'Ball', render: (r) => r.ball || '—' },
      { label: 'Probabilità', render: (r) => (r.probability != null ? fmt.pct(r.probability) : '—') },
      { label: 'Esito', render: (r) => (r.outcome === 'caught' ? '✅ catturato' : r.outcome === 'failed' ? '❌ fallito' : `⛔ ${REJECT_LABEL[r.reject_reason] || r.reject_reason}`) },
    ], d.attempts)));
}

function addPokemon(userId, done) {
  const state = { q: '', pokemonId: null, shiny: false, quantity: 1 };
  const results = h('div');
  const search = debounce(async () => {
    const d = await get(`/api/admin/pokemon?q=${encodeURIComponent(state.q)}&limit=12`);
    mount(results, h('div', { class: 'mon-grid' }, d.items.map((p) => h('div', {
      class: 'mon-card', style: { cursor: 'pointer', outline: state.pokemonId === p.id ? '2px solid var(--accent)' : '' },
      onclick: () => { state.pokemonId = p.id; search(); },
    }, h('img', { src: p.image, alt: '' }), h('div', { class: 'small' }, fmt.dex(p.dex_number)), h('div', { class: 'nm' }, p.name_it || p.name)))));
  }, 250);
  const m = modal('Aggiungi Pokémon alla collezione', h('div', { style: { display: 'grid', gap: '12px' } },
    h('input', { placeholder: 'Cerca per nome o numero…', oninput: (e) => { state.q = e.target.value; search(); } }),
    results,
    h('div', { class: 'row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { state.shiny = e.target.checked; } }), 'Shiny'),
      h('label', { class: 'field', style: { width: '120px' } }, 'Quantità', h('input', { type: 'number', min: 1, max: 100, value: 1, oninput: (e) => { state.quantity = Number(e.target.value); } })),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!state.pokemonId) return;
        const r = await act(() => post(`/api/admin/users/${userId}/pokemon`, state), 'Pokémon aggiunto');
        if (r) { m.close(); done(); }
      } }, 'Aggiungi'))));
  search();
}
