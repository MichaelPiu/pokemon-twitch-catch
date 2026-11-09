// Impostazioni: account amministratore, pagine pubbliche, modalità DEMO.
import { h, mount, get, post, put } from '../../lib.js';
import { icon } from '../../icons.js';
import { act, field, toast } from '../ui.js';
import { demo } from './demo.js';

function panel(title, ic, ...children) {
  return h('section', { class: 'panel', style: { marginBottom: '20px' } }, h('div', { class: 'panel-head' }, h('h2', {}, icon(ic, { size: 22 }), title)), ...children);
}

export async function settings({ el, store }) {
  const pages = await get('/api/admin/public-pages');
  const pw = { current: '', next: '', repeat: '' };
  const pwInputs = [];
  const pwField = (label, key, auto) => {
    const i = h('input', { type: 'password', autocomplete: auto, oninput: (e) => { pw[key] = e.target.value; } });
    pwInputs.push(i);
    return h('label', { class: 'field' }, label, i);
  };
  const demoBox = h('div');
  mount(el,
    h('div', { class: 'row2' },
      panel('Account amministratore', 'key',
        h('p', { class: 'muted' }, `Utente: `, h('b', {}, store.me?.username || 'admin'), '. Cambiando la password vengono chiuse tutte le altre sessioni aperte.'),
        h('div', { class: 'form' },
          pwField('Password attuale', 'current', 'current-password'),
          pwField('Nuova password (min. 10, lettere e numeri)', 'next', 'new-password'),
          pwField('Ripeti nuova password', 'repeat', 'new-password')),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: async () => {
          if (pw.next !== pw.repeat) { toast('Le password non coincidono', 'err'); return; }
          const r = await act(() => post('/api/auth/change-password', { currentPassword: pw.current, newPassword: pw.next }), 'Password aggiornata');
          if (r) pwInputs.forEach((i) => { i.value = ''; });
        } }, 'Salva password'))),
      panel('Pagine pubbliche', 'monitor',
        h('p', { class: 'muted' }, 'Pagine visibili senza login nella rete locale. L\'overlay /overlay e /health sono sempre attivi.'),
        h('div', { style: { display: 'grid', gap: '12px' } },
          field('Pagina introduttiva (/)', pages, 'landing', { type: 'checkbox' }),
          field('Pokédex pubblici (/pokedex/utente)', pages, 'pokedex', { type: 'checkbox' }),
          field('Classifica (/leaderboard)', pages, 'leaderboard', { type: 'checkbox' })),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => act(() => put('/api/admin/public-pages', pages), 'Pagine aggiornate') }, 'Salva')))),
    panel('Modalità DEMO', 'flask', demoBox));
  return demo({ el: demoBox });
}
