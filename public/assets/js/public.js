// Pagine pubbliche: introduzione, Pokédex pubblico, classifica.
import { h, mount, fmt, rarityBadge, TYPE_IT } from './lib.js';

const page = document.body.dataset.page;
const json = async (url) => {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Errore');
  return d;
};

async function landing() {
  const info = await json('/api/public/info').catch(() => null);
  if (!info) return;
  mount(document.getElementById('live'), info.live
    ? h('span', { class: 'pill state-pill state-LIVE' }, h('span', { class: 'dot live' }), 'IN DIRETTA ORA', info.channel ? h('a', { href: `https://twitch.tv/${info.channel}`, target: '_blank', rel: 'noopener', style: { marginLeft: '8px' } }, `twitch.tv/${info.channel}`) : null)
    : h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'Offline — il gioco si attiva quando inizia la diretta'));
  mount(document.getElementById('stats'),
    h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Allenatori'), h('div', { class: 'value' }, fmt.n(info.trainers))),
    h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Pokémon catturati'), h('div', { class: 'value' }, fmt.n(info.caught))),
    h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Specie in gioco'), h('div', { class: 'value' }, fmt.n(info.pokemon))));
  if (!info.pages.leaderboard) document.getElementById('lb-link')?.remove();
  document.getElementById('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const u = new FormData(e.target).get('u');
    location.href = `/pokedex/${encodeURIComponent(String(u).trim().replace(/^@/, ''))}`;
  });
}

async function pokedex() {
  const login = decodeURIComponent(location.pathname.split('/')[2] || '');
  const box = document.getElementById('content');
  let d;
  try { d = await json(`/api/public/pokedex/${encodeURIComponent(login)}`); } catch (e) {
    mount(box, h('div', { class: 'card center' }, h('h1', {}, 'Pokédex non trovato'), h('p', { class: 'muted' }, e.message), h('a', { class: 'btn', href: '/' }, '← Home')));
    return;
  }
  document.title = `Pokédex di ${d.trainer.displayName} · Live Catch`;
  const s = d.summary;
  const pct = d.totalSpecies ? Math.min(100, (s.species / d.totalSpecies) * 100) : 0;
  mount(box,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '/' }, '← Home'), h('h1', { style: { margin: 0 } }, `Pokédex di ${d.trainer.displayName}`)),
      h('div', { class: 'grid c4', style: { marginTop: '14px' } },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Pokémon'), h('div', { class: 'value' }, fmt.n(s.total))),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Specie'), h('div', { class: 'value' }, `${s.species}`), h('div', { class: 'sub' }, `su ${d.totalSpecies}`)),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Shiny'), h('div', { class: 'value' }, fmt.n(s.shiny))),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Allenatore dal'), h('div', { class: 'value', style: { fontSize: '1.2rem' } }, fmt.date(d.trainer.firstSeen)))),
      h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })),
      h('div', { class: 'muted small' }, `Completamento: ${pct.toFixed(1)}%`),
      s.rarest.length ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('span', { class: 'muted' }, 'I più rari:'),
        s.rarest.map((r) => h('span', { class: 'pill' }, rarityBadge(r.rarity), r.name, r.shiny ? ' ✨' : ''))) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Collezione'),
      d.collection.length ? h('div', { class: 'mon-grid' }, d.collection.map((m) => h('div', { class: 'mon-card' },
        m.count > 1 ? h('span', { class: 'cnt' }, `×${m.count}`) : null,
        m.shinyCount ? h('span', { class: 'sh' }, '✨') : null,
        h('img', { src: m.shinyCount ? m.shinyImage : m.image, alt: '', loading: 'lazy' }),
        h('div', { class: 'muted small' }, fmt.dex(m.dex)), h('div', { style: { fontWeight: 700 } }, m.name),
        rarityBadge(m.rarity), h('div', { class: 'muted small' }, (m.types || []).map((t) => TYPE_IT[t] || t).join(' / ')))))
        : h('div', { class: 'empty' }, 'Nessun Pokémon ancora catturato.')));
}

async function leaderboard() {
  const box = document.getElementById('content');
  let d;
  try { d = await json('/api/public/leaderboard?limit=50'); } catch (e) {
    mount(box, h('div', { class: 'card center' }, h('h1', {}, 'Classifica non disponibile'), h('a', { class: 'btn', href: '/' }, '← Home')));
    return;
  }
  mount(box, h('div', { class: 'card' },
    h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '/' }, '← Home'), h('h1', { style: { margin: 0 } }, '🏆 Classifica Allenatori')),
    d.items.length ? h('div', { class: 'table-wrap', style: { marginTop: '12px' } }, h('table', { class: 'podium' },
      h('thead', {}, h('tr', {}, ['#', 'Allenatore', 'Pokémon', 'Specie', 'Shiny'].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.items.map((r) => h('tr', {},
        h('td', {}, r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank),
        h('td', {}, h('a', { href: `/pokedex/${encodeURIComponent(r.login)}` }, r.displayName)),
        h('td', {}, fmt.n(r.total)), h('td', {}, fmt.n(r.species)), h('td', {}, fmt.n(r.shiny)))))))
      : h('div', { class: 'empty', style: { marginTop: '12px' } }, 'Ancora nessun allenatore in classifica.')));
}

({ landing, pokedex, leaderboard })[page]?.();
