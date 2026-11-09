import { h, mount, get, post } from '../../lib.js';
import { card, act, confirmDialog } from '../ui.js';
import { onLive } from '../main.js';
import { spawnBox, REJECT_LABEL } from './common.js';

export async function demo({ el }) {
  const log = h('div', { class: 'log-box', style: { minHeight: '120px' } });
  const addLog = (t, cls = '') => { log.prepend(h('div', { class: `log-line ${cls}` }, `${new Date().toLocaleTimeString('it-IT')} ${t}`)); };
  const state = { username: 'Spettatore_Demo', ballTypeId: null, text: '!pokedex' };
  const body = h('div');
  const render = async () => {
    const [sp, balls] = await Promise.all([get('/api/admin/spawn'), get('/api/admin/balls')]);
    const e = sp.engine;
    const isDemo = e.mode === 'demo';
    state.ballTypeId ??= balls[0]?.id;
    mount(body,
      h('div', { class: 'notice', style: { marginBottom: '16px' } },
        '🧪 La modalità DEMO serve a provare il gioco e l\'overlay SENZA Twitch. Usa utenti e sessioni separati (marcati DEMO), non usa i punti canale e NON entra nelle statistiche reali. Non è disponibile durante una diretta.'),
      card('Controllo DEMO', h('div', { class: 'row' },
        h('span', { class: 'pill' }, isDemo ? '🟢 DEMO attiva' : (e.mode === 'live' ? '🔴 Diretta in corso' : '⏹ DEMO ferma')),
        h('button', { class: 'btn primary', disabled: isDemo || e.mode === 'live', onclick: async () => { await act(() => post('/api/admin/demo/start'), 'DEMO avviata'); render(); } }, 'Avvia DEMO'),
        h('button', { class: 'btn', disabled: !isDemo, onclick: async () => { await act(() => post('/api/admin/demo/stop'), 'DEMO fermata'); render(); } }, 'Ferma DEMO'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn danger', disabled: isDemo, onclick: async () => {
          if (!await confirmDialog('Eliminare tutti i dati DEMO (utenti, catture e sessioni di prova)? I dati reali non vengono toccati.', { danger: true })) return;
          await act(() => post('/api/admin/demo/clear'), 'Dati DEMO eliminati');
        } }, 'Cancella dati DEMO'))),
      isDemo ? h('div', { class: 'grid c2', style: { marginTop: '16px' } },
        card('Pokémon in campo', spawnBox(sp.active),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn', disabled: !!sp.active, onclick: async () => { await act(() => post('/api/admin/spawn/manual', {}), 'Pokémon generato'); render(); } }, '✨ Genera Pokémon'),
            h('button', { class: 'btn danger', disabled: !sp.active, onclick: async () => { await act(() => post('/api/admin/spawn/cancel')); render(); } }, 'Termina'))),
        card('Simula spettatore',
          h('div', { class: 'form' },
            h('label', { class: 'field' }, 'Nome spettatore', h('input', { value: state.username, oninput: (ev) => { state.username = ev.target.value; } })),
            h('label', { class: 'field' }, 'Poké Ball', h('select', { onchange: (ev) => { state.ballTypeId = Number(ev.target.value); } },
              balls.filter((b) => b.enabled).map((b) => h('option', { value: b.id, selected: b.id === state.ballTypeId }, b.name))))),
          h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: async () => {
            const r = await act(() => post('/api/admin/demo/throw', state));
            if (!r) return;
            if (r.rejected) addLog(`⛔ ${state.username}: rifiutato (${REJECT_LABEL[r.reason] || r.reason})`, 'warn');
            else addLog(`${r.caught ? '✅' : '❌'} ${state.username} → ${r.caught ? 'CATTURATO' : 'fallito'} (probabilità ${(r.probability * 100).toFixed(1)}%)${r.fled ? ' — il Pokémon è fuggito' : ''}`);
            render();
          } }, '🎯 Lancia')),
          h('div', { class: 'form', style: { marginTop: '14px' } },
            h('label', { class: 'field' }, 'Comando chat', h('input', { value: state.text, oninput: (ev) => { state.text = ev.target.value; } }))),
          h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: async () => {
            const r = await act(() => post('/api/admin/demo/command', { username: state.username, text: state.text }));
            if (r) addLog(r.reply ? `💬 ${r.reply}` : `(nessuna risposta: ${r.ignored})`);
          } }, '💬 Invia comando (risposta solo qui)')))) : null,
      card('Registro DEMO', log));
  };
  mount(el, body);
  await render();
  const off = onLive((type) => { if (['spawn', 'despawn'].includes(type)) render().catch(() => {}); });
  return off;
}
