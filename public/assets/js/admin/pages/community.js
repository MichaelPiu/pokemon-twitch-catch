// Statistiche Community: curiosità calcolate dalle catture valide (stessa fonte
// delle classifiche). Periodo e metrica dello "spettatore più fortunato" scelti qui.
import { h, mount, get, put, fmt, TYPE_IT, rarityBadge } from '../../lib.js';
import { card, act, stat, table } from '../ui.js';

const dur = (s) => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const catt = (x) => `${fmt.n(x)} ${Number(x) === 1 ? 'cattura' : 'catture'}`;
const kind = (k) => (k === 'manual' ? 'sessione manuale' : k === 'twitch' ? 'diretta Twitch' : k);

export async function community({ el }) {
  let period = 'session';
  let d;

  const mon = (p) => h('span', { class: 'row', style: { gap: '8px' } },
    h('img', { src: p.image, alt: '', style: { width: '40px', height: '40px', objectFit: 'contain' } }), h('b', {}, `${p.name}${p.shiny ? ' ✨' : ''}`));
  const tie = (w) => (w?.tie ? h('div', { class: 'muted small' }, `Pari merito con: ${w.tiedWith.join(', ')}`) : null);
  const none = (text = 'Nessun dato nel periodo') => h('div', { class: 'muted' }, text);

  const sessionBox = (r, unit) => (!r ? none() : h('div', {},
    h('div', {}, h('b', {}, `${fmt.n(r.value)} ${unit}`), ` · ${kind(r.kind)} #${r.sessionId}${r.open ? ' (in corso)' : ''}`),
    h('div', { class: 'muted small' }, `${fmt.dt(r.startedAt)} · durata ${dur(r.durationS)}`),
    h('div', { class: 'small' }, `Allenatori: ${r.participants.join(', ') || '—'}`),
    r.tie ? h('div', { class: 'muted small' }, `Pari merito con le sessioni ${r.tiedSessions.map((x) => `#${x}`).join(', ')}: vale la prima in ordine di tempo.`) : null));

  const draw = () => {
    const s = d.stats;
    const periods = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      Object.entries(d.periods).map(([k, label]) => h('button', { class: `btn sm ${k === period ? 'primary' : ''}`, onclick: () => { period = k; load(); } }, label)));
    const metric = h('select', {
      onchange: async (e) => { const r = await act(() => put('/api/admin/community-stats/settings', { luckMetric: e.target.value }), 'Metrica salvata'); if (r) load(); },
    }, Object.entries(d.metrics).map(([k, m]) => h('option', { value: k, selected: k === d.settings.luckMetric }, m.label)));

    const head = card('Statistiche Community',
      h('p', { class: 'muted' }, 'Calcolate dalle catture valide (le stesse delle classifiche): catture annullate e modalità DEMO escluse. ',
        'Niente viene cancellato a fine diretta: lo storico resta finché restano le catture.'),
      periods,
      s.empty ? h('div', { class: 'notice warn', style: { marginTop: '10px' } }, s.emptyReason) : null,
      s.since ? h('p', { class: 'muted small' }, `Dal ${fmt.dt(s.since)} a oggi`) : null,
      s.session ? h('p', { class: 'muted small' }, `${kind(s.session.kind)} #${s.session.id} · iniziata ${fmt.dt(s.session.startedAt)}`) : null);

    const totals = h('div', { class: 'grid c4' },
      stat('Catture della community', fmt.n(s.totals.captures), `${fmt.n(s.totals.species)} specie diverse`),
      stat('Allenatori', fmt.n(s.totals.trainers), `${fmt.n(s.totals.sessions)} sessioni`),
      stat('Shiny', fmt.n(s.totals.shiny)),
      stat('Leggendari e Mitici', fmt.n(s.totals.legendary)));

    const most = card('Pokémon più catturato', !s.mostCaught ? none() : h('div', {},
      mon(s.mostCaught), h('p', {}, `${catt(s.mostCaught.count)} da ${fmt.n(s.mostCaught.trainers)} ${s.mostCaught.trainers === 1 ? 'allenatore' : 'allenatori'}`),
      s.mostCaught.ties.length ? h('div', { class: 'muted small' }, `Pari merito con: ${s.mostCaught.ties.join(', ')}`) : null,
      h('div', { class: 'small' }, 'Allenatori: ', s.mostCaught.trainerNames.map((t) => `${t.name} (${t.count})`).join(', '))),
    s.topPokemon.length ? h('details', { style: { marginTop: '10px' } }, h('summary', {}, 'Top 10 dei Pokémon più catturati'),
      table([
        { label: '#', render: (r) => s.topPokemon.indexOf(r) + 1 },
        { label: 'Pokémon', render: (r) => mon(r) },
        { label: 'Rarità', render: (r) => (r.rarity ? rarityBadge(r.rarity) : '—') },
        { label: 'Catture', render: (r) => fmt.n(r.count) },
        { label: 'Allenatori', render: (r) => fmt.n(r.trainers) },
      ], s.topPokemon)) : null);

    const L = s.luckiest;
    const lucky = card('Spettatore più fortunato',
      h('label', { class: 'field' }, 'Metrica', metric),
      h('p', { class: 'muted small' }, L.explain, ' A parità vince chi ci è arrivato prima; le parità vengono sempre indicate.'),
      L.winner ? h('div', {}, h('div', { style: { fontSize: '22px', fontWeight: 800 } }, `🍀 ${L.winner.name}`), h('p', {}, L.reason),
        L.winner.top.length > 1 ? h('div', { class: 'small muted' }, 'Seguono: ', L.winner.top.slice(1).map((r) => `${r.name} (${r.value})`).join(', ')) : null) : none());

    const trainers = card('Allenatori',
      h('div', { class: 'grid c2' },
        h('div', {}, h('h3', {}, 'Più catture'), s.topTrainer ? h('div', {}, h('b', {}, s.topTrainer.name), ` — ${catt(s.topTrainer.value)}`, tie(s.topTrainer)) : none()),
        h('div', {}, h('h3', {}, 'Più shiny'), s.topShinyTrainer ? h('div', {}, h('b', {}, s.topShinyTrainer.name), ` — ${fmt.n(s.topShinyTrainer.value)} shiny`, tie(s.topShinyTrainer)) : none('Nessuno shiny nel periodo'))));

    const rare = card('Pokémon più raro catturato', s.rarest ? h('div', {}, mon(s.rarest), ' ', s.rarest.rarity ? rarityBadge(s.rarest.rarity) : null,
      h('p', { class: 'small' }, `Catturato da ${s.rarest.player} il ${fmt.dt(s.rarest.caughtAt)}`),
      h('p', { class: 'muted small' }, 'Ordine: rarità più alta, poi shiny, poi la cattura più vecchia.')) : none());

    const types = card('Tipo più catturato', s.topType ? h('div', {},
      h('b', {}, TYPE_IT[s.topType.type] || s.topType.type), ` — ${catt(s.topType.count)}`,
      s.topType.tie ? h('div', { class: 'muted small' }, `Pari merito con: ${s.topType.tiedWith.map((t) => TYPE_IT[t] || t).join(', ')}`) : null,
      h('p', { class: 'muted small' }, 'Un Pokémon con due tipi conta per entrambi.'),
      h('div', { class: 'small' }, s.types.slice(0, 8).map((t) => `${TYPE_IT[t.type] || t.type} ${t.count}`).join(' · '))) : none());

    const records = card('Record delle sessioni',
      h('div', { class: 'grid c2' },
        h('div', {}, h('h3', {}, 'Più catture in una sessione'), sessionBox(s.recordSession, 'catture')),
        h('div', {}, h('h3', {}, 'Sessione con più Leggendari'), sessionBox(s.legendarySession, 'Leggendari e Mitici'))));

    mount(el, head, totals, h('div', { class: 'grid c2' }, most, lucky), h('div', { class: 'grid c2' }, trainers, rare), h('div', { class: 'grid c2' }, types, records),
      h('p', { class: 'muted small' }, `Aggiornate il ${fmt.dt(s.generatedAt)}. Le statistiche più interessanti compaiono anche nell'Overlay rotante (schermata "Statistiche Community").`));
  };

  const load = async () => {
    d = await get(`/api/admin/community-stats?period=${encodeURIComponent(period)}`);
    draw();
  };
  await load();
}
