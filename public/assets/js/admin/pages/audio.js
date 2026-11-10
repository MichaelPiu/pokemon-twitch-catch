// Audio OBS: effetti sonori di spawn e cattura per una Browser Source dedicata.
// La dashboard NON riproduce mai l'audio: "Prova" invia l'evento solo alla
// sorgente /overlay/audio aperta in OBS.
import { h, mount, get, post, put, fmt } from '../../lib.js';
import { card, table, act, field, toast } from '../ui.js';

export async function audio({ el }) {
  const load = async () => {
    const d = await get('/api/admin/audio');
    const s = { ...d.settings };
    // Lista spawn modificabile: parte dalla selezione effettiva (automatica o manuale).
    let pool = new Set(d.resolved.pool.map((f) => f.path));
    const obsUrl = `${location.origin}/overlay/audio`;
    const copy = (u) => { navigator.clipboard?.writeText(u); toast('URL copiato', 'ok'); };
    const testBtn = (label, body) => h('button', { class: 'btn', onclick: async () => {
      const r = await act(() => post('/api/admin/audio/test', body));
      if (r) toast(r.listeners ? `Inviato a ${r.listeners} sorgente/i audio di OBS: ${r.event.name}` : 'Nessuna sorgente audio di OBS collegata: il suono non è stato riprodotto', r.listeners ? 'ok' : 'warn');
    } }, label);

    const save = async (extra = {}) => {
      const body = {
        enabled: s.enabled, spawnEnabled: s.spawnEnabled, captureEnabled: s.captureEnabled, includeDemo: s.includeDemo,
        volume: Number(s.volume), maxDurationS: Number(s.maxDurationS), spawnMode: s.spawnMode,
        spawnFixed: s.spawnFixed || null, captureFile: s.captureFile || null, ...extra,
      };
      if (await act(() => put('/api/admin/audio', body), 'Impostazioni audio salvate')) load();
    };
    const fileOptions = (auto) => [['', auto], ...d.files.map((f) => [f.path, `${f.folder ? `${f.folder}/` : ''}${f.name}`])];

    const sourceCard = card('Sorgente audio per OBS',
      h('ol', { class: 'steps' },
        h('li', {}, 'In OBS aggiungi una sorgente ', h('b', {}, 'Browser'), ' (una sola, in una scena sempre attiva o come sorgente globale).'),
        h('li', {}, 'URL: ', h('code', {}, obsUrl), ' ', h('button', { class: 'btn sm', onclick: () => copy(obsUrl) }, 'Copia')),
        h('li', {}, 'Larghezza e altezza: 10 × 10 (non mostra nulla). Attiva ', h('b', {}, 'Controlla l\'audio tramite OBS'), ' per regolare il volume dal mixer. Lascia disattivato "Chiudi la sorgente quando non è visibile".'),
        h('li', {}, 'Diagnostica: apri ', h('code', {}, `${obsUrl}?debug=1`), ' ', h('button', { class: 'btn sm', onclick: () => copy(`${obsUrl}?debug=1`) }, 'Copia'), ' in OBS o nel browser del PC di OBS.')),
      h('div', { class: d.listeners ? 'notice ok' : 'notice warn', style: { marginTop: '8px' } },
        d.listeners ? `🔊 ${d.listeners} sorgente/i audio collegata/e in questo momento.` : '🔇 Nessuna sorgente audio collegata: i suoni non vengono riprodotti (il gioco continua normalmente).'),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        testBtn('▶ Prova suono spawn', { kind: 'spawn' }),
        testBtn('▶ Prova musica cattura', { kind: 'capture' }),
        h('button', { class: 'btn', onclick: load }, '↻ Aggiorna')),
      h('p', { class: 'muted small' }, 'La prova suona solo in OBS, mai in questa pagina. ',
        `Inviati finora: ${d.stats.sent}${d.stats.last ? ` · ultimo: ${d.stats.last.kind} "${d.stats.last.name}" ${fmt.dt(d.stats.last.at)}` : ''}`,
        d.stats.errors ? ` · errori: ${d.stats.errors} (${d.stats.lastError?.message || ''})` : ''));

    const settingsCard = card('Impostazioni',
      h('div', { class: 'grid c2' },
        h('div', {},
          field('Audio attivo', s, 'enabled', { type: 'checkbox' }),
          field('Suono a ogni nuovo Pokémon (spawn)', s, 'spawnEnabled', { type: 'checkbox' }),
          field('Musica alla cattura confermata', s, 'captureEnabled', { type: 'checkbox' }),
          field('Suoni anche in modalità DEMO', s, 'includeDemo', { type: 'checkbox' })),
        h('div', { class: 'form' },
          field('Volume (0–100)', s, 'volume', { min: 0, max: 100, step: 1 }),
          field('Durata massima in secondi (0 = brano intero)', s, 'maxDurationS', { min: 0, max: 300, step: 1, help: 'oltre questa durata il suono sfuma: utile se scegli un brano lungo' }))),
      h('div', { class: 'grid c2', style: { marginTop: '12px' } },
        h('div', { class: 'form' },
          field('Suono di spawn', s, 'spawnMode', { type: 'select', options: [['random', 'Casuale dalla lista (senza ripetere l\'ultimo)'], ['fixed', 'Sempre lo stesso file']] }),
          field('File fisso (modalità "sempre lo stesso")', s, 'spawnFixed', { type: 'select', options: fileOptions('— scegli —') })),
        h('div', { class: 'form' },
          field('Musica di cattura', s, 'captureFile', { type: 'select', options: fileOptions(`Automatica${d.resolved.auto.capture && d.resolved.capture ? ` (${d.resolved.capture.name})` : ' (nessun file riconosciuto)'}`) }))),
      d.resolved.missing.length ? h('div', { class: 'notice warn', style: { marginTop: '10px' } }, `File configurati ma non più presenti nella cartella: ${d.resolved.missing.join(', ')}`) : null,
      h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => save() }, 'Salva impostazioni')));

    const rows = d.files.map((f) => ({ ...f, key: f.path }));
    const filesCard = card(`File audio disponibili (${d.files.length})`,
      h('p', { class: 'muted small' }, 'Cartella: ', h('code', {}, d.dir), ' — su Umbrel: ', h('code', {}, '~/umbrel/app-data/piu-live-catch/data/audio'),
        `. Formati: ${d.formats.join(', ')}. Copia lì i tuoi file (anche in sottocartelle): compaiono qui senza riavviare. I file non vengono mai modificati.`),
      d.files.length ? null : h('div', { class: 'notice warn' }, 'Nessun file audio nella cartella: copia i tuoi file e premi Aggiorna.'),
      h('p', { class: 'muted small' }, d.resolved.auto.spawn
        ? 'Lista spawn: selezione automatica per nome (jingle brevi). Spunta o togli i file e salva la lista per sceglierli tu.'
        : 'Lista spawn: scelta manuale.'),
      table([
        { label: 'Spawn', render: (f) => h('input', { type: 'checkbox', checked: pool.has(f.path), onchange: (e) => { if (e.target.checked) pool.add(f.path); else pool.delete(f.path); } }) },
        { label: 'File', render: (f) => h('span', {}, f.folder ? h('span', { class: 'muted' }, `${f.folder}/`) : '', f.name) },
        { label: 'Formato', render: (f) => f.ext.toUpperCase() },
        { label: 'Dimensione', render: (f) => fmt.bytes(f.size) },
        { label: 'Uso', render: (f) => [f.spawn ? 'spawn' : null, f.capture ? 'cattura' : null].filter(Boolean).join(' · ') || '—' },
        { label: '', render: (f) => testBtn('▶ Prova in OBS', { kind: 'file', fileId: f.id }) },
      ], rows, { empty: 'Nessun file' }),
      h('div', { class: 'row end', style: { marginTop: '10px' } },
        h('button', { class: 'btn', onclick: () => save({ spawnFiles: null }) }, 'Torna alla selezione automatica'),
        h('button', { class: 'btn primary', onclick: () => save({ spawnFiles: [...pool] }) }, 'Salva lista spawn')));

    mount(el, sourceCard, settingsCard, filesCard);
  };
  await load();
}
