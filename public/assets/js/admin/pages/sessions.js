import { h, mount, get, fmt, rarityBadge } from '../../lib.js';
import { stat, card, table, pager } from '../ui.js';
import { SPAWN_STATUS, REJECT_LABEL, monCell } from './common.js';

export async function sessions({ el, params }) {
  if (params[0]) return detail(el, params[0]);
  let offset = 0;
  let demo = false;
  const load = async () => {
    const d = await get(`/api/admin/sessions?limit=50&offset=${offset}&demo=${demo ? 1 : 0}`);
    mount(el, card(null,
      h('div', { class: 'tabs' },
        h('button', { class: `btn sm ${!demo ? 'on' : ''}`, onclick: () => { demo = false; offset = 0; load(); } }, 'Dirette reali'),
        h('button', { class: `btn sm ${demo ? 'on' : ''}`, onclick: () => { demo = true; offset = 0; load(); } }, 'Sessioni DEMO')),
      table([
        { label: '#', key: 'id' },
        { label: 'Data', render: (r) => fmt.date(r.started_at) },
        { label: 'Inizio', render: (r) => fmt.time(r.started_at) },
        { label: 'Fine', render: (r) => (r.ended_at ? fmt.time(r.ended_at) : h('span', { class: 'pill state-pill state-LIVE' }, 'in corso')) },
        { label: 'Durata', render: (r) => fmt.dur(r.duration_s ?? (Date.now() - Date.parse(r.started_at)) / 1000) },
        { label: 'Spawn', key: 'spawns' },
        { label: 'Catture', key: 'captures' },
        { label: 'Falliti', key: 'failures' },
        { label: 'Partecipanti', key: 'participants' },
        { label: 'Shiny', key: 'shiny_spawns' },
      ], d.items, { onRow: (r) => { location.hash = `#/sessions/${r.id}`; }, empty: 'Nessuna diretta registrata' }),
      pager(d.total, 50, offset, (o) => { offset = o; load(); })));
  };
  await load();
}

async function detail(el, id) {
  const d = await get(`/api/admin/sessions/${id}`);
  const s = d.session;
  const t = d.totals;
  mount(el,
    h('div', { class: 'row', style: { marginBottom: '12px' } }, h('a', { class: 'btn sm', href: '#/sessions' }, '← Storico'),
      h('h2', { style: { margin: 0 } }, `Sessione #${s.id}${s.is_demo ? ' (DEMO)' : ''}`),
      h('span', { class: 'muted' }, `${fmt.dt(s.started_at)} → ${s.ended_at ? fmt.dt(s.ended_at) : 'in corso'} · ${fmt.dur(s.duration_s ?? (Date.now() - Date.parse(s.started_at)) / 1000)}`)),
    h('div', { class: 'grid c4' },
      stat('Pokémon apparsi', fmt.n(t.spawns), `${t.shiny} shiny`), stat('Tentativi', fmt.n(t.attempts)), stat('Catture', fmt.n(t.captures)),
      stat('Falliti', fmt.n(t.failures)), stat('Successo', fmt.pct(t.successRate)), stat('Partecipanti', fmt.n(t.participants))),
    h('div', { class: 'grid c2', style: { marginTop: '16px' } },
      card('Classifica della diretta', table([{ label: 'Utente', key: 'name' }, { label: 'Tentativi', key: 'attempts' }, { label: 'Catture', key: 'captures' }], d.leaderboard)),
      card('Tentativi rifiutati', table([{ label: 'Motivo', render: (r) => REJECT_LABEL[r.reason] || r.reason }, { label: 'Quanti', key: 'n' }], d.rejected, { empty: 'Nessuno' })),
      card('Poké Ball usate', table([{ label: 'Ball', key: 'name' }, { label: 'Usate', key: 'used' }, { label: 'Catture', key: 'captures' }], d.top.balls)),
      card('Più catturati', table([{ label: 'Pokémon', render: (r) => monCell(r.name, r.dex) }, { label: 'Catture', key: 'n' }], d.top.mostCaught))),
    card('Spawn della diretta', table([
      { label: 'Ora', render: (r) => fmt.time(r.started_at) },
      { label: 'Pokémon', render: (r) => monCell(r.name, r.dex, r.is_shiny) },
      { label: 'Rarità', render: (r) => rarityBadge(r.rarity) },
      { label: 'Esito', render: (r) => SPAWN_STATUS[r.status] || r.status },
      { label: 'Tentativi', key: 'attempts' },
      { label: 'Catture', key: 'captures' },
      { label: 'Catturato da', render: (r) => r.caught_by || '—' },
      { label: 'Origine', key: 'source' },
    ], d.spawns)));
}
