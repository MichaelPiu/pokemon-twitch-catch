import { h, mount, get, post, patch, del } from '../../lib.js';
import { card, table, act, modal, confirmDialog, toast } from '../ui.js';

export async function balls({ el }) {
  const load = async () => {
    const [list, rewards] = await Promise.all([get('/api/admin/balls'), get('/api/admin/twitch/rewards')]);
    mount(el,
      card('Tipologie di Poké Ball',
        h('p', { class: 'muted small' }, 'Probabilità finale = probabilità base della rarità × difficoltà del Pokémon × moltiplicatore della ball × modificatori (shiny, evento). Una ball "garantita" cattura sempre (se l\'opzione Master Ball è attiva in Gestione spawn).'),
        table([
          { label: '', render: (b) => h('span', { class: 'ball-icon', style: { '--c': b.color } }) },
          { label: 'Nome', render: (b) => h('b', {}, b.name) },
          { label: 'Codice', render: (b) => h('code', {}, b.code) },
          { label: 'Moltiplicatore', render: (b) => (b.guaranteed ? 'garantita' : `${b.multiplier}×`) },
          { label: 'Ricompense collegate', render: (b) => String(b.rewards) },
          { label: 'Usata', key: 'used' },
          { label: 'Stato', render: (b) => (b.enabled ? '✅ attiva' : '⛔ disattivata') },
          { label: '', render: (b) => h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: () => edit(b, load) }, 'Modifica'),
            h('button', { class: 'btn sm', onclick: async () => { await act(() => patch(`/api/admin/balls/${b.id}`, { enabled: !b.enabled }), b.enabled ? 'Disattivata' : 'Attivata'); load(); } }, b.enabled ? 'Disattiva' : 'Attiva'),
            h('button', { class: 'btn sm danger', onclick: async () => {
              if (!await confirmDialog(`Eliminare ${b.name}? Se è già stata usata verrà solo disattivata.`, { danger: true })) return;
              const r = await act(() => del(`/api/admin/balls/${b.id}`));
              if (r?.message) toast(r.message);
              load();
            } }, 'Elimina')) },
        ], list),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => edit(null, load) }, '➕ Nuova Poké Ball'))),
      card('Collegamento con le Channel Points Rewards',
        h('p', { class: 'muted' }, 'Ogni ricompensa Twitch va associata a una Poké Ball. Crea o collega le ricompense dalla sezione ', h('a', { href: '#/twitch' }, 'Twitch → Ricompense'), '.'),
        table([
          { label: 'Ricompensa', key: 'title' },
          { label: 'Poké Ball', render: (r) => r.ball_name || h('span', { class: 'muted' }, 'non associata') },
          { label: 'Costo', render: (r) => r.cost ?? '—' },
          { label: 'Gestita dall\'app', render: (r) => (r.managed_by_app ? 'sì' : 'no') },
        ], rewards, { empty: 'Nessuna ricompensa collegata' })));
  };
  await load();
}

function edit(b, done) {
  const s = b ? { ...b, guaranteed: !!b.guaranteed, enabled: !!b.enabled } : { code: '', name: '', multiplier: 1, guaranteed: false, enabled: true, color: '#e3350d', sort_order: 10 };
  const m = modal(b ? `Modifica ${b.name}` : 'Nuova Poké Ball', h('div', { style: { display: 'grid', gap: '12px' } },
    h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Nome', h('input', { value: s.name, oninput: (e) => { s.name = e.target.value; } })),
      h('label', { class: 'field' }, 'Codice (minuscolo, senza spazi)', h('input', { value: s.code, oninput: (e) => { s.code = e.target.value; } })),
      h('label', { class: 'field' }, 'Moltiplicatore', h('input', { type: 'number', step: 0.1, min: 0, value: s.multiplier, oninput: (e) => { s.multiplier = Number(e.target.value); } })),
      h('label', { class: 'field' }, 'Colore', h('input', { type: 'color', value: s.color, oninput: (e) => { s.color = e.target.value; } })),
      h('label', { class: 'field' }, 'Ordine', h('input', { type: 'number', min: 0, value: s.sort_order, oninput: (e) => { s.sort_order = Number(e.target.value); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.guaranteed, onchange: (e) => { s.guaranteed = e.target.checked; } }), 'Cattura garantita'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => { s.enabled = e.target.checked; } }), 'Attiva')),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: async () => {
      const r = await act(() => (b ? patch(`/api/admin/balls/${b.id}`, s) : post('/api/admin/balls', s)), 'Salvato');
      if (r) { m.close(); done(); }
    } }, 'Salva'))));
}
