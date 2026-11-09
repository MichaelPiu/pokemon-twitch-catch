import { h, fmt, rarityBadge } from '../../lib.js';

export const STATE_LABEL = {
  OFFLINE: 'OFFLINE', CONNECTING: 'CONNESSIONE…', LIVE: 'LIVE', PAUSED: 'IN PAUSA', ERROR: 'ERRORE',
};

export const REJECT_LABEL = {
  offline: 'canale offline', paused: 'gioco in pausa', no_spawn: 'nessun Pokémon presente', expired: 'spawn scaduto', late: 'evento in ritardo',
  user_limit: 'limite tentativi utente', already_caught: 'già catturato', banned: 'utente escluso', ball_disabled: 'ball disattivata',
  demo_mode: 'modalità demo attiva', live_mode: 'modalità live attiva', reward_unmapped: 'ricompensa senza Poké Ball',
};

export const SPAWN_STATUS = {
  active: 'in campo', caught: 'catturato', fled: 'fuggito', expired: 'scaduto', cancelled: 'annullato', interrupted: 'interrotto', stream_ended: 'fine diretta',
};

export function stateRow(lifecycle) {
  const st = lifecycle.state;
  return h('span', { class: `pill state-pill state-${st}` }, h('span', { class: `dot ${st === 'LIVE' ? 'live' : ''}` }), STATE_LABEL[st] || st);
}

export function spawnBox(sp) {
  if (!sp) return h('div', { class: 'empty' }, 'Nessun Pokémon in campo');
  const left = Math.max(0, (Date.parse(sp.expiresAt) - Date.now()) / 1000);
  return h('div', { class: 'spawn-live' },
    h('img', { src: sp.image, alt: sp.name }),
    h('div', {},
      h('div', { class: 'muted' }, fmt.dex(sp.dex)),
      h('div', { style: { fontSize: '1.5rem', fontWeight: 800 } }, sp.name, sp.shiny ? ' ✨' : ''),
      h('div', { class: 'row' }, rarityBadge(sp.rarity), sp.demo ? h('span', { class: 'badge', style: { '--c': '#7dd3fc' } }, 'DEMO') : null),
      h('div', { class: 'muted small', style: { marginTop: '6px' } }, `Tentativi: ${sp.attempts} · Catture: ${sp.captures} · Tempo: ${Math.round(left)}s · Modalità: ${sp.mode === 'multi' ? 'cattura multipla' : 'un solo vincitore'}`)));
}

export function monCell(name, dex, shiny) {
  return h('span', {}, h('span', { class: 'muted' }, fmt.dex(dex), ' '), name, shiny ? ' ✨' : '');
}
