import { h, mount, get, fmt, barChart } from '../../lib.js';
import { stat, card, table } from '../ui.js';
import { monCell } from './common.js';

export async function stats({ el }) {
  let period = 'day';
  const load = async () => {
    const d = await get(`/api/admin/stats?period=${period}`);
    const t = d.totals;
    const tabs = h('div', { class: 'tabs' }, [['day', 'Giornaliere'], ['week', 'Settimanali'], ['month', 'Mensili']].map(([k, l]) =>
      h('button', { class: `btn sm ${k === period ? 'on' : ''}`, onclick: () => { period = k; load(); } }, l)));
    const series = d.series.map((s) => ({ ...s, label: s.bucket }));
    mount(el,
      d.current ? card(`Diretta attuale (sessione #${d.current.session.id})`, h('div', { class: 'grid c4' },
        stat('Spawn', fmt.n(d.current.totals.spawns)), stat('Tentativi', fmt.n(d.current.totals.attempts)),
        stat('Catture', fmt.n(d.current.totals.captures)), stat('Successo', fmt.pct(d.current.totals.successRate)))) : null,
      card('Statistiche complessive', h('div', { class: 'grid c4' },
        stat('Dirette', fmt.n(t.sessions), `${fmt.dur(t.liveSeconds)} di gioco`), stat('Pokémon apparsi', fmt.n(t.spawns), `${fmt.n(t.shiny)} shiny`),
        stat('Tentativi', fmt.n(t.attempts), `${fmt.n(t.failures)} falliti`), stat('Catture', fmt.n(t.captures), `successo ${fmt.pct(t.successRate)}`),
        stat('Partecipanti unici', fmt.n(t.participants)), stat('Allenatori registrati', fmt.n(t.users)))),
      card('Andamento', tabs,
        series.length ? h('div', {},
          h('h3', {}, 'Tentativi (giallo) e catture (rosso)'), barChart(series, { key: 'attempts', secondary: 'captures' }),
          h('h3', { style: { marginTop: '14px' } }, 'Pokémon apparsi'), barChart(series, { key: 'spawns', color: 'var(--blue)' }),
          table([
            { label: 'Periodo', key: 'bucket' }, { label: 'Dirette', key: 'sessions' }, { label: 'Spawn', key: 'spawns' },
            { label: 'Shiny', key: 'shiny' }, { label: 'Tentativi', key: 'attempts' }, { label: 'Catture', key: 'captures' },
            { label: 'Falliti', key: 'failures' }, { label: 'Partecipanti', key: 'participants' },
            { label: 'Successo', render: (r) => fmt.pct(r.attempts ? r.captures / r.attempts : 0) },
          ], [...series].reverse())) : h('div', { class: 'empty' }, 'Nessun dato nel periodo')),
      h('div', { class: 'grid c2', style: { marginTop: '16px' } },
        card('Pokémon più apparsi', table([{ label: 'Pokémon', render: (r) => monCell(r.name, r.dex) }, { label: 'Volte', key: 'n' }], d.top.mostSpawned)),
        card('Pokémon più catturati', table([{ label: 'Pokémon', render: (r) => monCell(r.name, r.dex) }, { label: 'Catture', key: 'n' }], d.top.mostCaught)),
        card('Pokémon più difficili', table([
          { label: 'Pokémon', render: (r) => monCell(r.name, r.dex) }, { label: 'Tentativi', key: 'attempts' },
          { label: 'Successo', render: (r) => fmt.pct(r.rate) }], d.top.hardest, { empty: 'Servono almeno 3 tentativi per Pokémon' })),
        card('Utenti più attivi', table([{ label: 'Utente', key: 'name' }, { label: 'Tentativi', key: 'attempts' }, { label: 'Catture', key: 'captures' },
          { label: 'Successo', render: (r) => fmt.pct(r.attempts ? r.captures / r.attempts : 0) }], d.top.activeUsers)),
        card('Classifica catture', table([{ label: '#', key: 'rank' }, { label: 'Allenatore', key: 'displayName' }, { label: 'Pokémon', key: 'total' },
          { label: 'Specie', key: 'species' }, { label: 'Shiny', key: 'shiny' }], d.leaderboard)),
        card('Poké Ball più usate', table([
          { label: 'Ball', render: (r) => h('span', { class: 'row' }, h('span', { class: 'ball-icon', style: { '--c': r.color } }), r.name) },
          { label: 'Usate', key: 'used' }, { label: 'Catture', key: 'captures' },
          { label: 'Successo', render: (r) => fmt.pct(r.used ? r.captures / r.used : 0) }], d.top.balls)),
        card('Pokémon shiny apparsi', table([{ label: 'Quando', render: (r) => fmt.dt(r.started_at) }, { label: 'Pokémon', render: (r) => monCell(r.name, r.dex, true) },
          { label: 'Catturato da', render: (r) => r.caught_by || '—' }], d.top.shiny, { empty: 'Nessuno shiny ancora ✨' }))));
  };
  await load();
}
