import { h, mount, get, post, patch, fmt, rarityBadge, RARITY, RARITY_KEYS, TYPE_IT, debounce } from '../../lib.js';
import { card, act, modal, pager, confirmDialog } from '../ui.js';
import { onLive } from '../main.js';

export async function pokemon({ el }) {
  const f = { q: '', rarity: '', enabled: '', generation: '', offset: 0 };
  const grid = h('div');
  const importBox = h('div');
  const counts = h('div', { class: 'row' });

  const load = async () => {
    const qs = new URLSearchParams({ q: f.q, rarity: f.rarity, enabled: f.enabled, generation: f.generation, offset: f.offset, limit: 60 });
    const d = await get(`/api/admin/pokemon?${qs}`);
    mount(counts, d.counts.map((c) => h('span', { class: 'pill' }, rarityBadge(c.rarity), `${c.enabled}/${c.n}`)));
    renderImport(d.import);
    if (!d.total) {
      mount(grid, h('div', { class: 'empty' }, f.q || f.rarity ? 'Nessun Pokémon corrisponde ai filtri' : 'Nessun Pokémon importato: usa il pannello qui sopra per scaricare i dati da PokéAPI.'));
      return;
    }
    mount(grid, h('div', { class: 'mon-grid' }, d.items.map((p) => h('div', { class: `mon-card ${p.enabled ? '' : 'off'}`, style: { cursor: 'pointer' }, onclick: () => edit(p, load) },
      h('img', { src: p.image, alt: '', loading: 'lazy' }),
      h('div', { class: 'muted small' }, fmt.dex(p.dex_number), p.generation ? ` · Gen ${p.generation}` : ''),
      h('div', { class: 'nm' }, p.name_it || p.name),
      h('div', {}, rarityBadge(p.rarity)),
      h('div', { class: 'muted small' }, p.types.map((t) => TYPE_IT[t] || t).join(' / '))))),
    pager(d.total, 60, f.offset, (o) => { f.offset = o; load(); }));
  };

  const imp = { generations: '', includeForms: false, images: true, shinyImages: true };
  const renderImport = (p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    mount(importBox,
      p.running ? h('div', {},
        h('div', { class: 'row' }, h('b', {}, `Importazione in corso: ${p.phase}`), h('span', { class: 'muted' }, `${p.done}/${p.total} (${pct}%) · errori: ${p.errors}`),
          h('span', { class: 'spacer' }), h('button', { class: 'btn sm danger', onclick: () => act(() => post('/api/admin/pokemon-import/cancel'), 'Annullamento richiesto') }, 'Annulla')),
        h('div', { style: { height: '10px', background: '#0f1330', borderRadius: '6px', marginTop: '8px', overflow: 'hidden' } },
          h('div', { style: { width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, var(--primary), var(--accent))', transition: 'width 0.3s' } })))
        : h('div', {},
          p.message ? h('div', { class: `notice ${p.phase === 'errore' ? 'err' : 'ok'}`, style: { marginBottom: '10px' } }, p.message, p.finishedAt ? ` (${fmt.dt(p.finishedAt)})` : '') : null,
          h('p', { class: 'muted small' }, 'I dati vengono scaricati da PokéAPI e salvati sul server, insieme alle immagini. Dopo l\'importazione il gioco funziona senza Internet verso PokéAPI. Le impostazioni personalizzate (rarità, difficoltà, abilitazione) non vengono sovrascritte da una nuova importazione.'),
          h('div', { class: 'form' },
            h('label', { class: 'field' }, 'Generazioni (vuoto = tutte)', h('input', { placeholder: 'es. 1,2', value: imp.generations, oninput: (e) => { imp.generations = e.target.value; } })),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: imp.includeForms, onchange: (e) => { imp.includeForms = e.target.checked; } }), 'Includi forme alternative (disattivate di default)'),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: imp.images, onchange: (e) => { imp.images = e.target.checked; } }), 'Scarica immagini'),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: imp.shinyImages, onchange: (e) => { imp.shinyImages = e.target.checked; } }), 'Scarica immagini shiny')),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn primary', onclick: async () => {
              const generations = imp.generations.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
              await act(() => post('/api/admin/pokemon-import', { ...imp, generations }), 'Importazione avviata');
            } }, '⬇️ Importa da PokéAPI'),
            h('button', { class: 'btn', onclick: () => act(() => post('/api/admin/pokemon-import/images'), 'Download immagini mancanti avviato') }, 'Scarica immagini mancanti'))));
  };

  const bulk = async (patchBody, filter, label) => {
    if (!await confirmDialog(`Applicare "${label}" a tutti i Pokémon ${filter.rarity ? `di rarità ${RARITY[filter.rarity].label}` : filter.generation ? `della generazione ${filter.generation}` : ''}?`)) return;
    const r = await act(() => post('/api/admin/pokemon/bulk', { ...filter, patch: patchBody }));
    if (r) { load(); }
  };

  mount(el,
    card('Importazione dati (PokéAPI)', importBox),
    card('Elenco Pokémon',
      h('div', { class: 'row', style: { marginBottom: '8px' } }, counts),
      h('div', { class: 'form', style: { marginBottom: '14px' } },
        h('label', { class: 'field' }, 'Cerca', h('input', { placeholder: 'nome o numero', oninput: debounce((e) => { f.q = e.target.value; f.offset = 0; load(); }) })),
        h('label', { class: 'field' }, 'Rarità', h('select', { onchange: (e) => { f.rarity = e.target.value; f.offset = 0; load(); } },
          h('option', { value: '' }, 'Tutte'), RARITY_KEYS.map((r) => h('option', { value: r }, RARITY[r].label)))),
        h('label', { class: 'field' }, 'Stato', h('select', { onchange: (e) => { f.enabled = e.target.value; f.offset = 0; load(); } },
          h('option', { value: '' }, 'Tutti'), h('option', { value: '1' }, 'Abilitati'), h('option', { value: '0' }, 'Disabilitati'))),
        h('label', { class: 'field' }, 'Generazione', h('input', { type: 'number', min: 1, max: 20, oninput: debounce((e) => { f.generation = e.target.value; f.offset = 0; load(); }) }))),
      h('div', { class: 'row', style: { marginBottom: '14px' } },
        h('span', { class: 'muted small' }, 'Azioni rapide sul filtro corrente (rarità/generazione):'),
        h('button', { class: 'btn sm', onclick: () => bulk({ enabled: true }, { rarity: f.rarity || undefined, generation: f.generation || undefined, all: !f.rarity && !f.generation }, 'abilita') }, 'Abilita tutti'),
        h('button', { class: 'btn sm', onclick: () => bulk({ enabled: false }, { rarity: f.rarity || undefined, generation: f.generation || undefined, all: !f.rarity && !f.generation }, 'disabilita') }, 'Disabilita tutti')),
      grid));
  await load();
  const off = onLive((type, data) => { if (type === 'import') { renderImport(data); if (!data.running) load(); } });
  return off;
}

async function edit(p, done) {
  const st = await get(`/api/admin/pokemon/${p.id}/stats`);
  const s = { rarity: p.rarity, catch_modifier: p.catch_modifier, spawn_weight: p.spawn_weight, shiny_enabled: !!p.shiny_enabled, enabled: !!p.enabled, name_it: p.name_it || '' };
  const m = modal(`${fmt.dex(p.dex_number)} ${p.name_it || p.name}`, h('div', { style: { display: 'grid', gap: '14px' } },
    h('div', { class: 'row' },
      h('img', { src: st.pokemon.image, style: { width: '120px', height: '120px', objectFit: 'contain' } }),
      h('img', { src: st.pokemon.shinyImage, title: 'shiny', style: { width: '90px', height: '90px', objectFit: 'contain' } }),
      h('div', {},
        h('div', {}, `Nome originale: ${p.name}`, p.form_name ? ` · forma: ${p.form_name}` : ''),
        h('div', { class: 'muted small' }, `Tipi: ${p.types.map((t) => TYPE_IT[t] || t).join(' / ')} · Gen ${p.generation ?? '?'} · capture rate PokéAPI: ${p.capture_rate ?? '?'}`),
        h('div', { class: 'muted small' }, `Apparso ${st.spawns.n} volte (${st.spawns.shiny} shiny) · ${st.attempts.n} tentativi, ${st.attempts.caught} catture · posseduto da ${st.owners.n} utenti (${st.owners.owned} esemplari)`))),
    h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Rarità', h('select', { onchange: (e) => { s.rarity = e.target.value; } }, RARITY_KEYS.map((r) => h('option', { value: r, selected: r === s.rarity }, RARITY[r].label)))),
      h('label', { class: 'field' }, 'Difficoltà (moltiplicatore cattura)', h('input', { type: 'number', step: 0.05, min: 0.01, value: s.catch_modifier, oninput: (e) => { s.catch_modifier = Number(e.target.value); } }),
        h('span', { class: 'small' }, '< 1 = più difficile, > 1 = più facile')),
      h('label', { class: 'field' }, 'Probabilità di apparizione (peso)', h('input', { type: 'number', step: 0.1, min: 0, value: s.spawn_weight, oninput: (e) => { s.spawn_weight = Number(e.target.value); } }),
        h('span', { class: 'small' }, 'Peso relativo dentro la sua rarità (0 = mai)')),
      h('label', { class: 'field' }, 'Nome italiano', h('input', { value: s.name_it, oninput: (e) => { s.name_it = e.target.value; } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => { s.enabled = e.target.checked; } }), 'Abilitato negli spawn'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.shiny_enabled, onchange: (e) => { s.shiny_enabled = e.target.checked; } }), 'Può apparire shiny')),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: async () => {
      const r = await act(() => patch(`/api/admin/pokemon/${p.id}`, s), 'Pokémon aggiornato');
      if (r) { m.close(); done(); }
    } }, 'Salva'))));
}
