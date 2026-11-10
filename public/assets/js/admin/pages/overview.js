// Panoramica: stato del gioco, diretta corrente e attività in tempo reale.
import { h, mount, get, fmt, RARITY, TYPE_IT, TYPE_COLOR, lineChart, debounce } from '../../lib.js';
import { icon } from '../../icons.js';
import { onLive } from '../main.js';
import { twitchAuthNotices } from './common.js';

const STATE = {
  LIVE: ['LIVE', 'var(--ok)'], OFFLINE: ['OFFLINE', 'var(--muted)'], CONNECTING: ['CONNESSIONE…', 'var(--warn)'],
  PAUSED: ['IN PAUSA', 'var(--warn)'], ERROR: ['ERRORE', 'var(--err)'],
};
const SERIES = [
  { key: 'attempts', label: 'Tentativi', color: '#a855f7' },
  { key: 'captures', label: 'Catture', color: '#22c55e' },
  { key: 'participants', label: 'Partecipanti', color: '#38bdf8' },
];
const FEED = {
  spawn: ['check', 'var(--ok)'], capture: ['orb', 'var(--ok)'], shiny: ['star', 'var(--gold)'], command: ['chat', '#a78bfa'],
  live: ['logo', '#a78bfa'], offline: ['pause', 'var(--muted)'], paused: ['pause', 'var(--warn)'],
};

const pad = (n) => String(n).padStart(2, '0');
const hms = (s) => { s = Math.max(0, Math.floor(s)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };
const dayTime = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? 'Oggi' : d.toLocaleDateString('it-IT')}, ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
};

function kpi(ic, label, value, { color, live = false, delta = null, valueCls = '' } = {}) {
  return h('div', { class: `kpi ${live ? 'live' : ''}`, style: color ? { '--kc': color } : null },
    icon(ic, { size: 34 }),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'k-label' }, label),
      h('div', { class: 'k-value' }, h('span', { class: valueCls }, value), delta ? h('span', { class: 'k-delta' }, '▲ ', delta) : null)));
}

export async function overview({ el }) {
  let data = null;
  let minutes = 30;
  const kpis = h('div', { class: 'kpis' });
  const notices = h('div');
  const spawnPanel = h('section', { class: 'panel' });
  const chartPanel = h('section', { class: 'panel' });
  const capsPanel = h('section', { class: 'panel' });
  const livePanel = h('section', { class: 'panel' });
  const feedPanel = h('section', { class: 'panel' });
  const errPanel = h('div');
  const ticking = []; // elementi aggiornati ogni secondo

  mount(el, notices, kpis,
    h('div', { class: 'row2' }, spawnPanel, chartPanel),
    h('div', { class: 'row3' }, capsPanel, livePanel, feedPanel),
    errPanel);

  const render = () => {
    const d = data;
    ticking.length = 0;
    const st = d.lifecycle.state;
    const eng = d.engine;
    const cur = d.current;
    const [stLabel, stColor] = STATE[st] || [st, 'var(--muted)'];

    mount(notices,
      !d.twitch.configured ? h('div', { class: 'notice', style: { marginBottom: '16px' } },
        'Benvenuto! Per iniziare: collega Twitch in ', h('a', { href: '#/twitch' }, 'Gestione Twitch'),
        ', importa i Pokémon in ', h('a', { href: '#/pokemon' }, 'Gestione Pokémon'),
        ' e aggiungi l\'overlay in OBS (', h('a', { href: '#/overlay' }, 'Overlay'), ').') : null,
      d.pokemonCount.n === 0 ? h('div', { class: 'notice err', style: { marginBottom: '16px' } },
        'Nessun Pokémon nel database: vai su ', h('a', { href: '#/pokemon' }, 'Gestione Pokémon'), ' e avvia l\'importazione da PokéAPI.') : null,
      d.isDemo ? h('div', { class: 'notice', style: { marginBottom: '16px' } }, icon('flask', { size: 16 }), ' Modalità DEMO attiva: i dati mostrati sotto sono di prova e non entrano nelle statistiche reali.') : null,
      eng.mode === 'manual' ? h('div', { class: 'manual-banner' }, h('span', { class: 'manual-dot' }), h('strong', {}, 'Sessione manuale in corso'),
        h('span', { class: 'muted' }, ' — gioco senza diretta, dati reali marcati MANUAL. '), h('a', { href: '#/game' }, 'Controllo gioco')) : null);

    const engineVal = eng.running ? (eng.mode === 'demo' ? ['DEMO', '#38bdf8'] : eng.mode === 'manual' ? ['Manuale', 'var(--ok)'] : ['Attivo', 'var(--ok)']) : eng.suspended ? ['Sospeso', 'var(--warn)'] : ['Fermo', 'var(--muted)'];
    mount(kpis,
      kpi('twitch', 'Stato Twitch', h('span', { style: { color: stColor, display: 'inline-flex', alignItems: 'center', gap: '10px' } }, stLabel, st === 'LIVE' ? h('span', { class: 'dot live' }) : null),
        { color: st === 'LIVE' ? 'var(--ok)' : '#c9cbe0', live: st === 'LIVE' }),
      kpi('gamepad', 'Motore di gioco', h('span', { style: { color: engineVal[1] } }, engineVal[0]), { color: '#c9cbe0' }),
      kpi('users', 'Partecipanti', fmt.n(cur?.participants ?? 0), { color: '#c4b5fd', delta: d.newTrainersToday ? `+${d.newTrainersToday} oggi` : null }),
      kpi('orb', 'Catture (diretta)', fmt.n(cur?.captures ?? 0), { color: '#f43f5e', delta: cur?.attempts ? `${Math.round(cur.successRate * 100)}%` : null }),
      kpi('target', 'Tentativi', fmt.n(cur?.attempts ?? 0), { color: '#a78bfa' }),
      kpi('star', 'Shiny (diretta)', fmt.n(cur?.shiny ?? 0), { color: 'var(--gold)' }));

    // Pokémon in gioco
    const sp = eng.activeSpawn;
    if (sp) {
      const timer = h('span', {}, '--:--:--');
      ticking.push(() => { timer.textContent = hms((Date.parse(sp.expiresAt) - Date.now()) / 1000); });
      const rar = RARITY[sp.rarity] || { label: sp.rarity, color: '#999' };
      mount(spawnPanel,
        h('div', { class: 'panel-head' }, h('h2', {}, 'Pokémon attualmente in gioco'), h('span', { class: 'spacer' }),
          h('span', { class: 'tag' }, h('span', { class: 'dot' }), sp.demo ? 'Spawn DEMO' : 'Spawn attivo'),
          h('span', { class: 'tag dark', title: 'Tempo rimanente' }, icon('clock', { size: 18 }), timer)),
        h('div', { class: 'mon-hero' },
          h('div', { class: 'mon-art' }, h('img', { src: sp.image, alt: sp.name, onerror: (e) => { e.target.src = '/assets/img/unknown.svg'; } }),
            sp.shiny ? h('span', { class: 'chip shiny-flag', style: { '--c': 'var(--gold)' } }, icon('star', { size: 14 }), 'Shiny') : null),
          h('div', { class: 'mon-info' },
            h('div', { class: 'dexn' }, `#${String(sp.dex).padStart(3, '0')}`),
            h('div', { class: 'nm' }, sp.name),
            h('div', { class: 'row' },
              ...(sp.types || []).map((t) => h('span', { class: 'chip', style: { '--c': TYPE_COLOR[t] || '#999' } }, TYPE_IT[t] || t)),
              h('span', { class: 'chip', style: { '--c': rar.color } }, icon('sparkle', { size: 14 }), rar.label)),
            h('div', { class: 'kv' },
              h('div', {}, icon('chat', { size: 18 }), 'Tentativi', h('span', { class: 'v' }, String(sp.attempts))),
              h('div', {}, icon('user', { size: 18 }), 'Probabilità base', h('span', { class: 'v' }, d.spawnInfo ? `${Math.round(d.spawnInfo.baseChance * 100)}%` : '—')),
              h('div', {}, icon('target', { size: 18 }), 'Modalità cattura', h('span', { class: 'v' }, sp.mode === 'multi' ? 'Cattura multipla' : 'Un solo vincitore'))))));
    } else {
      const next = h('span');
      if (eng.running && eng.nextSpawnAt) ticking.push(() => { next.textContent = `Prossimo spawn tra circa ${hms((Date.parse(eng.nextSpawnAt) - Date.now()) / 1000)}`; });
      mount(spawnPanel,
        h('div', { class: 'panel-head' }, h('h2', {}, 'Pokémon attualmente in gioco'), h('span', { class: 'spacer' }),
          h('span', { class: 'tag dark' }, eng.running ? 'In attesa' : 'Motore fermo')),
        h('div', { class: 'empty-spawn' }, h('div', {}, icon('orb', { size: 64 }),
          h('div', { style: { marginTop: '8px' } }, eng.running ? 'Nessun Pokémon in campo' : 'Il motore di gioco è fermo: si avvia da solo quando vai in LIVE.'),
          h('div', { class: 'small' }, next))));
    }

    // Diretta corrente
    const s = d.session;
    const dur = h('span', { class: 'v' }, '—');
    if (s) ticking.push(() => { dur.textContent = hms(((s.ended_at ? Date.parse(s.ended_at) : Date.now()) - Date.parse(s.started_at)) / 1000); });
    mount(livePanel,
      h('div', { class: 'panel-head' }, h('h2', {}, icon('logo', { size: 22 }), d.isDemo ? 'Sessione DEMO' : s?.kind === 'manual' ? 'Sessione manuale' : 'Diretta corrente')),
      s ? h('div', { class: 'kv-list' },
        h('div', {}, icon('calendar', { size: 20 }), 'Inizio', h('span', { class: 'v' }, dayTime(s.started_at))),
        h('div', {}, icon('hourglass', { size: 20 }), 'Durata', dur),
        h('div', {}, icon('history', { size: 20 }), 'Pokémon spawnati', h('span', { class: 'v' }, fmt.n(cur.spawns))),
        h('div', { class: 'ok' }, icon('check', { size: 20 }), 'Catture riuscite', h('span', { class: 'v' }, fmt.n(cur.captures))),
        h('div', { class: 'ko' }, icon('x', { size: 20 }), 'Catture fallite', h('span', { class: 'v' }, fmt.n(cur.failures))),
        h('div', {}, icon('users', { size: 20 }), 'Partecipanti unici', h('span', { class: 'v' }, fmt.n(cur.participants))),
        h('div', { class: 'st' }, icon('star', { size: 20 }), 'Shiny apparsi', h('span', { class: 'v' }, fmt.n(cur.shiny))))
        : h('div', { class: 'empty' }, 'Nessuna diretta in corso. Le statistiche compaiono automaticamente quando vai in LIVE.'));

    // Ultime catture
    mount(capsPanel,
      h('div', { class: 'panel-head' }, h('h2', {}, 'Ultime catture'), h('span', { class: 'spacer' }),
        h('a', { class: 'link', href: '#/users' }, 'Vedi tutte ', icon('arrowRight', { size: 16 }))),
      d.recentCaptures.length ? h('div', { class: 'cap-list' }, d.recentCaptures.map((c) => h('div', {},
        h('span', { class: 'bar' }),
        h('img', { src: c.image, alt: '', loading: 'lazy' }),
        h('span', { class: 'u' }, c.user),
        h('span', { class: 'p' }, c.name, c.is_shiny ? ' ✨' : '', h('small', {}, `#${String(c.dex).padStart(3, '0')}`)),
        h('span', { class: 'b' }, h('span', { class: 'ball-icon', style: { '--c': c.ball_color || 'var(--primary)', width: '18px', height: '18px' } }), h('span', { class: 'bn' }, c.ball_name || '—')),
        h('span', { class: 't' }, fmt.ago(c.caught_at)))))
        : h('div', { class: 'empty' }, 'Ancora nessuna cattura'));

    // Attività recente
    mount(feedPanel,
      h('div', { class: 'panel-head' }, h('h2', {}, icon('chat', { size: 22 }), 'Attività recente')),
      d.activity.length ? h('div', { class: 'feed' }, d.activity.map((a) => {
        const [ic, c] = FEED[a.kind] || ['check', 'var(--primary2)'];
        return h('div', { style: { '--fc': c } }, icon(ic, { size: 22 }), h('span', { class: 'tx', title: a.text }, a.text),
          h('span', { class: 'tm' }, new Date(a.at).toLocaleTimeString('it-IT')));
      })) : h('div', { class: 'empty' }, 'Nessuna attività recente'));

    // Errori (solo se presenti)
    const authNotices = twitchAuthNotices(d.twitch);
    mount(errPanel, d.errors.length || d.twitch.lastError || authNotices.length ? h('section', { class: 'panel', style: { marginTop: '20px' } },
      h('div', { class: 'panel-head' }, h('h2', {}, icon('x', { size: 22 }), 'Errori e avvisi')),
      authNotices,
      d.twitch.lastError ? h('div', { class: 'notice err', style: { marginBottom: '10px' } }, d.twitch.lastError) : null,
      d.errors.length ? h('div', { class: 'log-box' }, d.errors.map((e) => h('div', { class: `log-line ${e.level}` }, `${fmt.dt(e.ts)} [${e.scope}] ${e.message}`))) : null) : null);
    tick();
  };

  const renderChart = async () => {
    const select = h('select', { class: 'select-sm', onchange: (e) => { minutes = Number(e.target.value); renderChart(); } },
      [[30, 'Ultimi 30 minuti'], [60, 'Ultima ora'], [0, 'Intera diretta']].map(([v, l]) => h('option', { value: v, selected: v === minutes }, l)));
    const head = h('div', { class: 'panel-head' }, h('h2', {}, icon('calendar', { size: 22 }), 'Statistiche diretta', h('small', {}, '(in tempo reale)')), h('span', { class: 'spacer' }), select);
    let tl;
    try { tl = await get(`/api/admin/overview/timeline?minutes=${minutes}`); } catch { return; }
    if (!tl.points?.length) {
      mount(chartPanel, head, h('div', { class: 'empty', style: { minHeight: '220px', display: 'grid', placeItems: 'center' } }, 'Il grafico si popola durante la diretta.'));
      return;
    }
    mount(chartPanel, head, h('div', { class: 'chart-wrap' }, lineChart(tl.points, SERIES, { height: 240 }),
      h('div', { class: 'legend' }, SERIES.map((s) => h('span', {}, h('i', { style: { '--c': s.color } }), s.label)))));
  };

  const tick = () => ticking.forEach((f) => f());
  const load = async () => { data = await get('/api/admin/overview'); render(); };
  await load();
  await renderChart();

  const refresh = debounce(() => { load().catch(() => {}); renderChart(); }, 400);
  const off = onLive((type) => { if (['status', 'state', 'spawn', 'despawn', 'attempt', 'twitch_event'].includes(type)) refresh(); });
  const t1 = setInterval(tick, 1000);
  const t2 = setInterval(refresh, 30000);
  return () => { off(); clearInterval(t1); clearInterval(t2); };
}
