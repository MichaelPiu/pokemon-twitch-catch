import { h, fmt, rarityBadge } from '../../lib.js';

export const STATE_LABEL = {
  OFFLINE: 'OFFLINE', CONNECTING: 'CONNESSIONE…', LIVE: 'LIVE', PAUSED: 'IN PAUSA', ERROR: 'ERRORE',
};

export const REJECT_LABEL = {
  offline: 'canale offline', paused: 'gioco in pausa', no_spawn: 'nessun Pokémon presente', expired: 'spawn scaduto', late: 'evento in ritardo',
  user_limit: 'limite tentativi utente', already_caught: 'già catturato', banned: 'utente escluso', ball_disabled: 'ball disattivata',
  demo_mode: 'modalità demo attiva', live_mode: 'modalità live attiva', reward_unmapped: 'ricompensa senza Poké Ball',
  canceled: 'riscatto annullato (cattura revocata)', manual_mode: 'sessione manuale attiva (riscatti Twitch non elaborati)',
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

// Avvisi su token revocati e ricompense che potrebbero restare riscattabili su
// Twitch mentre il gioco non accetta lanci.
export function twitchAuthNotices(st) {
  if (!st) return [];
  const out = [];
  const b = st.authErrors?.broadcaster;
  const bot = st.authErrors?.bot;
  const u = st.credentialsUnreadable;
  if (u) out.push(h('div', { class: 'notice warn', style: { marginBottom: '10px' } },
    h('b', {}, '🔑 Twitch scollegato: credenziali non leggibili con la chiave di questa installazione. '),
    'Succede dopo il ripristino di un backup su un altro server (la chiave secret.key non è nei backup). Il gioco in modalità manuale funziona; per le dirette vai su ',
    h('a', { href: '#/twitch' }, 'Twitch'), u.clientSecret ? ', inserisci di nuovo il Client Secret' : '', ' e collega di nuovo l\'account', u.bot && !u.broadcaster ? ' bot' : '', '.'));
  if (b) out.push(h('div', { class: 'notice err', style: { marginBottom: '10px' } },
    h('b', {}, '🔑 Autorizzazione dell\'account del canale non più valida. '),
    'Twitch ha rifiutato il token (revocato, password cambiata o app scollegata). Vai su ', h('a', { href: '#/twitch' }, 'Twitch'),
    ' → Account del canale → ', h('b', {}, 'Ricollega'), '. Al ricollegamento l\'app mette in pausa le ricompense e rimborsa i riscatti rimasti in coda.'));
  if (bot) out.push(h('div', { class: 'notice warn', style: { marginBottom: '10px' } },
    h('b', {}, '🤖 Token del bot non più valido. '), 'Il gioco continua: nel frattempo le risposte in chat partono dall\'account del canale. Ricollega il bot dalla pagina Twitch.'));
  const risk = st.rewardsPause?.atRisk || [];
  if (risk.length) out.push(h('div', { class: 'notice err', style: { marginBottom: '10px' } },
    h('b', {}, `⚠️ ${risk.length === 1 ? '1 ricompensa potrebbe essere ancora riscattabile' : `${risk.length} ricompense potrebbero essere ancora riscattabili`} su Twitch mentre il gioco è fermo: `),
    risk.map((r) => r.title).join(', '), '. ',
    b ? 'L\'app non può metterle in pausa finché non ricolleghi l\'account del canale. Per sicurezza mettile in pausa a mano da Twitch (Creator Dashboard → Ricompense). '
      : 'L\'app ritenta la pausa a ogni controllo. ',
    'I riscatti fatti nel frattempo restano in coda e vengono rimborsati automaticamente.'));
  return out;
}
