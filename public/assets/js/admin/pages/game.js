// Controllo del motore di gioco: modalità AUTOMATICA (diretta Twitch) o MANUALE
// (sessione avviata dalla dashboard, senza Twitch, con dati reali).
import { h, mount, get, post, fmt } from '../../lib.js';
import { card, act, confirmDialog, stat, toast } from '../ui.js';
import { onLive } from '../main.js';
import { spawnBox, REJECT_LABEL, STATE_LABEL } from './common.js';
import { icon } from '../../icons.js';

export async function game({ el }) {
  const form = { mode: 'local', name: 'Giocatore_Locale', userId: '', ballTypeId: null };
  let data = null;
  let tick = null;
  const lastThrow = h('div', { class: 'muted small' });

  const load = async () => { data = await get('/api/admin/game'); render(); };

  const elapsed = (s) => {
    const m = Math.floor(s / 60);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  function render() {
    const e = data.engine;
    const manual = e.mode === 'manual';
    const lc = data.lifecycle;
    if (!form.ballTypeId && data.balls[0]) form.ballTypeId = data.balls[0].id;
    const modeLabel = manual ? 'MANUALE' : 'AUTOMATICA';
    const engineLabel = e.running ? (e.mode === 'live' ? 'Attivo (diretta Twitch)' : manual ? 'Attivo (sessione manuale)' : 'Attivo (DEMO)')
      : e.suspended ? 'Sospeso' : 'Fermo';
    const engineColor = e.running ? 'var(--ok)' : e.suspended ? 'var(--warn)' : 'var(--muted)';
    const m = e.manual;
    const elapsedEl = h('div', { class: 'value', 'data-role': 'elapsed' }, m ? elapsed(m.elapsedS) : '—');

    mount(el,
      e.notice ? h('div', { class: `notice ${e.notice.level === 'warn' ? 'warn' : ''}`, style: { marginBottom: '16px' } },
        icon('clock', { size: 16 }), ' ', e.notice.message, ' ',
        h('button', { class: 'btn sm ghost', onclick: async () => { await post('/api/admin/game/notice/dismiss'); load(); } }, 'Ho capito')) : null,
      manual ? h('div', { class: 'manual-banner' },
        h('span', { class: 'manual-dot' }), h('strong', {}, `SESSIONE MANUALE #${m.sessionId} IN CORSO`),
        h('span', { class: 'muted' }, ' — il canale resta OFFLINE su Twitch, i dati sono reali e marcati MANUAL')) : null,
      card('Motore di gioco',
        h('div', { class: 'grid c4' },
          stat('Stato del motore', h('span', { style: { color: engineColor } }, engineLabel), `Twitch: ${STATE_LABEL[lc.state] || lc.state}`),
          stat('Modalità', h('span', { class: `mode-pill ${manual ? 'manual' : ''}` }, modeLabel), manual ? 'avviata dalla dashboard' : 'gestita dalla diretta Twitch'),
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Tempo trascorso'), elapsedEl, h('div', { class: 'sub' }, m ? `dalle ${fmt.dt(m.startedAt)}` : 'nessuna sessione manuale')),
          stat('Incontri / catture', m ? `${m.encounters} / ${m.captures}` : '—', m ? `${m.attempts} lanci${m.errors ? ` · ${m.errors} errori` : ''}` : '')),
        h('div', { class: 'row', style: { marginTop: '16px' } },
          h('button', { class: 'btn primary', disabled: !data.canStartManual, onclick: async () => {
            const r = await act(() => post('/api/admin/game/manual/start'), 'Sessione manuale avviata');
            if (r) { data = r; render(); }
          } }, icon('gamepad', { size: 18 }), ' Avvia gioco manualmente'),
          h('button', { class: 'btn danger', disabled: !manual, onclick: async () => {
            if (!await confirmDialog('Fermare la sessione manuale? Le catture e le statistiche già registrate restano salvate.', { okLabel: 'Ferma gioco' })) return;
            const r = await act(() => post('/api/admin/game/manual/stop'), 'Sessione manuale terminata');
            if (r) { data = r; render(); }
          } }, icon('pause', { size: 18 }), ' Ferma gioco'),
          h('span', { class: 'spacer' }),
          h('a', { class: 'btn', href: '/overlay', target: '_blank' }, icon('external', { size: 16 }), ' Apri overlay (OBS)')),
        data.blockedReason && !manual ? h('p', { class: 'muted small' }, data.blockedReason) : null,
        h('p', { class: 'muted small' }, 'In modalità automatica il gioco parte e si ferma con la diretta Twitch. La sessione manuale usa lo stesso motore (spawn, probabilità, Pokédex, statistiche, overlay) senza andare LIVE; se il canale va in diretta, la sessione manuale viene chiusa e la diretta ha la priorità.')),
      manual ? h('div', { class: 'grid c2' },
        card('Pokémon in campo',
          e.activeSpawn ? spawnBox(e.activeSpawn) : h('div', { class: 'empty' }, e.nextSpawnAt ? `Prossimo incontro previsto alle ${fmt.time(e.nextSpawnAt)}` : 'Nessun Pokémon in campo'),
          h('div', { class: 'row', style: { marginTop: '12px' } },
            h('button', { class: 'btn', disabled: !!e.activeSpawn, onclick: async () => { await act(() => post('/api/admin/spawn/manual', {}), 'Pokémon generato'); } }, icon('sparkle', { size: 16 }), ' Genera incontro ora'),
            h('button', { class: 'btn ghost', disabled: !e.activeSpawn, onclick: async () => { await act(() => post('/api/admin/spawn/cancel', {}), 'Incontro terminato'); } }, 'Termina incontro'))),
        card('Lancia una Poké Ball',
          h('div', { class: 'form' },
            h('label', { class: 'field' }, 'Giocatore',
              h('select', { onchange: (ev) => { form.mode = ev.target.value; render(); } },
                h('option', { value: 'local', selected: form.mode === 'local' }, 'Giocatore locale (non Twitch)'),
                h('option', { value: 'known', selected: form.mode === 'known' }, 'Spettatore già registrato'))),
            form.mode === 'local'
              ? h('label', { class: 'field' }, 'Nome del giocatore locale', h('input', { value: form.name, maxlength: 25, oninput: (ev) => { form.name = ev.target.value; } }),
                h('span', { class: 'small' }, 'Lettere, numeri e _ . Resta separato dagli account Twitch.'))
              : h('label', { class: 'field' }, 'Spettatore',
                h('select', { onchange: (ev) => { form.userId = ev.target.value; } },
                  h('option', { value: '' }, '— scegli —'),
                  data.recentPlayers.map((u) => h('option', { value: u.id, selected: String(form.userId) === String(u.id) }, `${u.display_name}${u.origin === 'local' ? ' (locale)' : ''}`)))),
            h('label', { class: 'field' }, 'Poké Ball',
              h('select', { onchange: (ev) => { form.ballTypeId = Number(ev.target.value); } },
                data.balls.map((b) => h('option', { value: b.id, selected: form.ballTypeId === b.id }, `${b.name} (×${b.multiplier}${b.guaranteed ? ', garantita' : ''})`))))),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn accent', disabled: !e.activeSpawn, onclick: async () => {
              const body = form.mode === 'local' ? { name: form.name, ballTypeId: form.ballTypeId } : { userId: Number(form.userId), ballTypeId: form.ballTypeId };
              const r = await act(() => post('/api/admin/game/manual/throw', body));
              if (!r) return;
              const msg = r.rejected ? `Lancio rifiutato: ${REJECT_LABEL[r.reason] || r.reason}`
                : r.caught ? `${r.user.displayName} ha catturato ${r.pokemon?.name}! (p=${Math.round(r.probability * 100)}%)`
                  : `${r.user.displayName}: lancio fallito (p=${Math.round(r.probability * 100)}%)${r.fled ? ', il Pokémon è fuggito' : ''}`;
              lastThrow.textContent = msg;
              toast(msg, r.caught ? 'ok' : '');
            } }, icon('orb', { size: 16 }), ' Lancia'),
            lastThrow))) : null,
      card('Non disponibile senza Twitch',
        h('ul', { class: 'muted small', style: { margin: 0, paddingLeft: '18px' } }, data.twitchOnly.map((t) => h('li', {}, t))),
        h('p', { class: 'muted small' }, 'I comandi della chat (es. !pokedex) si provano in Comandi Chat → Prova: la risposta viene mostrata qui e non inviata su Twitch.')));

    clearInterval(tick);
    if (m) {
      const startMs = Date.parse(m.startedAt);
      tick = setInterval(() => { elapsedEl.textContent = elapsed(Math.max(0, Math.round((Date.now() - startMs) / 1000))); }, 1000);
    }
  }

  await load();
  let pending = null;
  const off = onLive((type) => {
    if (!['status', 'spawn', 'despawn', 'attempt', 'notice', 'state'].includes(type)) return;
    clearTimeout(pending);
    pending = setTimeout(() => load().catch(() => {}), 150);
  });
  return () => { off(); clearInterval(tick); clearTimeout(pending); };
}
