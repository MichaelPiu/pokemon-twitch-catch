import { h, mount, get, fmt, rarityBadge } from '../../lib.js';
import { stat, card, table } from '../ui.js';
import { onLive } from '../main.js';
import { stateRow, spawnBox, STATE_LABEL } from './common.js';

export async function overview({ el }) {
  let data = await get('/api/admin/overview');
  const render = () => {
    const d = data;
    const st = d.lifecycle.state;
    const live = st === 'LIVE';
    const eng = d.engine;
    const cur = d.current;
    const sess = d.session && !d.session.is_demo ? d.session : null;
    mount(el,
      !d.twitch.configured ? h('div', { class: 'notice', style: { marginBottom: '16px' } },
        '👋 Benvenuto! Per iniziare: 1) collega Twitch nella sezione ', h('a', { href: '#/twitch' }, 'Twitch'),
        ', 2) importa i Pokémon in ', h('a', { href: '#/pokemon' }, 'Pokémon'),
        ', 3) aggiungi l\'overlay in OBS (', h('a', { href: '#/overlay' }, 'Overlay'), ').') : null,
      d.pokemonCount.n === 0 ? h('div', { class: 'notice err', style: { marginBottom: '16px' } },
        'Nessun Pokémon nel database: vai su ', h('a', { href: '#/pokemon' }, 'Pokémon'), ' e avvia l\'importazione da PokéAPI.') : null,
      h('div', { class: 'grid c4' },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Stato Twitch'), h('div', { style: { margin: '8px 0' } }, stateRow(d.lifecycle)),
          h('div', { class: 'sub' }, `dal ${fmt.dt(d.lifecycle.since)} · ${d.lifecycle.reason || ''}`)),
        stat('Connessione Twitch', d.twitch.eventsubConnected ? '🟢 Connesso' : (d.twitch.configured ? '🔴 Non connesso' : '⚪ Da configurare'),
          d.twitch.lastPoll ? `Ultimo controllo: ${fmt.time(d.twitch.lastPoll.at)}` : null),
        stat('Motore di gioco', eng.running ? (eng.mode === 'demo' ? '🧪 DEMO' : '🟢 Attivo') : (eng.suspended ? '⏸ Sospeso' : '⏹ Fermo'),
          eng.running ? (eng.nextSpawnAt ? `Prossimo spawn ~${fmt.time(eng.nextSpawnAt)}` : (eng.activeSpawn ? 'Pokémon in campo' : '')) : (live ? '' : 'Si avvia da solo quando vai in LIVE')),
        stat('Durata diretta', sess ? fmt.dur((Date.now() - Date.parse(sess.started_at)) / 1000) : '—', sess ? `Sessione #${sess.id}` : 'nessuna diretta in corso')),
      !live && eng.mode !== 'demo' ? h('div', { class: 'notice', style: { marginTop: '16px' } },
        `Il canale è ${STATE_LABEL[st]}: il motore di gioco è fermo. Nessun Pokémon verrà generato e nessuna cattura verrà accettata finché non vai in diretta.`) : null,
      h('div', { class: 'grid c2', style: { marginTop: '16px' } },
        card('Pokémon in campo', spawnBox(eng.activeSpawn)),
        card('Diretta attuale',
          cur ? h('div', { class: 'grid c3' },
            stat('Spawn', fmt.n(cur.spawns)), stat('Tentativi', fmt.n(cur.attempts)), stat('Catture', fmt.n(cur.captures)),
            stat('Successo', fmt.pct(cur.successRate)), stat('Partecipanti', fmt.n(cur.participants)), stat('Shiny', fmt.n(cur.shiny)))
            : h('div', { class: 'empty' }, 'Le statistiche compaiono quando sei in diretta'))),
      h('div', { class: 'grid c4', style: { marginTop: '16px' } },
        stat('Allenatori', fmt.n(d.allTime.users)), stat('Pokémon posseduti', fmt.n(d.allTime.owned)),
        stat('Dirette totali', fmt.n(d.allTime.sessions)), stat('Successo globale', fmt.pct(d.allTime.successRate))),
      h('div', { class: 'grid c2', style: { marginTop: '16px' } },
        card('Ultime catture', table([
          { label: 'Quando', render: (r) => fmt.ago(r.caught_at) },
          { label: 'Utente', key: 'user' },
          { label: 'Pokémon', render: (r) => h('span', {}, r.name, r.is_shiny ? ' ✨' : '') },
          { label: 'Rarità', render: (r) => rarityBadge(r.rarity) },
          { label: 'Ball', key: 'ball_name' },
        ], d.recentCaptures, { empty: 'Ancora nessuna cattura' })),
        card('Ultimi eventi Twitch', table([
          { label: 'Ora', render: (r) => fmt.time(r.received_at) },
          { label: 'Evento', render: (r) => h('code', {}, r.event_type.replace('channel.channel_points_custom_reward_redemption', 'redemption')) },
          { label: 'Esito', render: (r) => r.detail || r.status },
        ], d.recentEvents, { empty: 'Nessun evento ricevuto' }))),
      h('div', { class: 'grid c2', style: { marginTop: '16px' } },
        card('Errori e avvisi', d.errors.length
          ? h('div', { class: 'log-box' }, d.errors.map((e) => h('div', { class: `log-line ${e.level}` }, `${fmt.dt(e.ts)} [${e.scope}] ${e.message}`)))
          : h('div', { class: 'empty' }, '✅ Nessun errore recente'),
          d.twitch.lastError ? h('div', { class: 'notice err', style: { marginTop: '10px' } }, d.twitch.lastError) : null),
        card('Transizioni di stato', table([
          { label: 'Quando', render: (r) => fmt.dt(r.created_at) },
          { label: 'Da → A', render: (r) => `${r.from_state} → ${r.to_state}` },
          { label: 'Motivo', key: 'reason' },
        ], d.transitions))));
  };
  render();
  const refresh = async () => { try { data = await get('/api/admin/overview'); render(); } catch { /* ignora */ } };
  const off = onLive((type) => { if (['status', 'state', 'spawn', 'despawn', 'attempt'].includes(type)) refresh(); });
  const t = setInterval(refresh, 15000);
  return () => { off(); clearInterval(t); };
}
