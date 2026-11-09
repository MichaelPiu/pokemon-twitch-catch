import { h, mount, get, put } from '../../lib.js';
import { card, act, field } from '../ui.js';

const POS = [['top-left', 'In alto a sinistra'], ['top-center', 'In alto al centro'], ['top-right', 'In alto a destra'], ['center', 'Centro'],
  ['bottom-left', 'In basso a sinistra'], ['bottom-center', 'In basso al centro'], ['bottom-right', 'In basso a destra']];

export async function overlay({ el }) {
  const s = await get('/api/admin/overlay');
  const url = `${location.origin}/overlay`;
  const frame = h('iframe', { class: 'preview-frame', src: '/overlay?preview=1', title: 'Anteprima overlay' });
  const send = (type, data) => frame.contentWindow?.postMessage({ source: 'livecatch-preview', type, data }, location.origin);
  const sample = () => ({
    id: -1, dex: 25, name: 'Pokémon di prova', types: ['electric'], rarity: 'rare', shiny: false, image: '/assets/img/unknown.svg',
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), attempts: 0, demo: true,
  });
  const colorField = (label, key) => h('label', { class: 'field' }, label, h('input', { value: s.colors[key], oninput: (e) => { s.colors[key] = e.target.value; } }));
  const save = async () => { const r = await act(() => put('/api/admin/overlay', s), 'Overlay aggiornato'); if (r) frame.contentWindow?.location.reload(); };

  mount(el,
    card('Collegamento a OBS',
      h('ol', { class: 'steps' },
        h('li', {}, 'In OBS: ', h('b', {}, 'Sorgenti → + → Browser'), '.'),
        h('li', {}, 'URL: ', h('code', {}, url), ' ', h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(url) }, 'Copia')),
        h('li', {}, `Larghezza ${s.layout.width}, altezza ${s.layout.height}. Lascia vuoto il CSS personalizzato.`),
        h('li', {}, 'Spunta “Aggiorna il browser quando la scena diventa attiva”. Lo sfondo è già trasparente.'))),
    card('Anteprima (solo locale, non inviata alla diretta)', frame,
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn', onclick: () => send('spawn', sample()) }, 'Mostra Pokémon'),
        h('button', { class: 'btn', onclick: () => send('throw', { user: 'Spettatore', ball: { name: 'Ultra Ball', color: '#f2c200' }, caught: false, pokemon: { name: 'Pokémon di prova' }, attempts: 1 }) }, 'Lancio fallito'),
        h('button', { class: 'btn', onclick: () => send('throw', { user: 'Spettatore', ball: { name: 'Poké Ball', color: '#e3350d' }, caught: true, pokemon: { name: 'Pokémon di prova', shiny: false }, attempts: 2 }) }, 'Cattura riuscita'),
        h('button', { class: 'btn', onclick: () => send('despawn', { id: -1, reason: 'expired' }) }, 'Fuga'),
        h('button', { class: 'btn', onclick: () => send('clear', {}) }, 'Pulisci'))),
    card('Layout', h('div', { class: 'form' },
      field('Posizione', s.layout, 'position', { type: 'select', options: POS }),
      field('Scala', s.layout, 'scale', { step: 0.05, min: 0.3, max: 3 }),
      field('Larghezza sorgente', s.layout, 'width', { min: 320 }),
      field('Altezza sorgente', s.layout, 'height', { min: 240 }),
      field('Margine orizzontale (px)', s.layout, 'offsetX', { min: 0 }),
      field('Margine verticale (px)', s.layout, 'offsetY', { min: 0 }))),
    card('Colori', h('p', { class: 'muted small' }, 'Formati: #rrggbb oppure rgba(r, g, b, a).'), h('div', { class: 'form' },
      colorField('Primario', 'primary'), colorField('Accento', 'accent'), colorField('Sfondo pannelli', 'background'),
      colorField('Testo', 'text'), colorField('Successo', 'success'), colorField('Fallimento', 'failure'))),
    card('Animazioni e notifiche', h('div', { class: 'form' },
      field('Animazioni attive', s.animations, 'enabled', { type: 'checkbox' }),
      field('Velocità animazioni', s.animations, 'speed', { step: 0.25, min: 0.25, max: 4 }),
      field('Durata notifiche (ms)', s.notifications, 'durationMs', { min: 1000, step: 500 }),
      field('Massimo notifiche in coda', s.notifications, 'maxQueue', { min: 1 }),
      field('Mostra i lanci', s.notifications, 'showThrows', { type: 'checkbox' }),
      field('Mostra i tentativi falliti', s.notifications, 'showFailures', { type: 'checkbox' }))),
    card('Elementi visibili', h('div', { class: 'form' },
      field('Immagine', s.elements, 'image', { type: 'checkbox' }), field('Nome', s.elements, 'name', { type: 'checkbox' }),
      field('Numero Pokédex', s.elements, 'dexNumber', { type: 'checkbox' }), field('Rarità', s.elements, 'rarity', { type: 'checkbox' }),
      field('Tipi', s.elements, 'types', { type: 'checkbox' }), field('Timer', s.elements, 'timer', { type: 'checkbox' }),
      field('Tentativi', s.elements, 'attempts', { type: 'checkbox' }))),
    h('div', { class: 'row end', style: { marginTop: '16px' } }, h('button', { class: 'btn primary', onclick: save }, 'Salva overlay')));
}
