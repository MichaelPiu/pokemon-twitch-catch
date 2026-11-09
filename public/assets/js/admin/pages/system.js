import { h, mount, get, post, put, del, api, fmt } from '../../lib.js';
import { card, table, act, confirmDialog, stat, field } from '../ui.js';

export async function system({ el }) {
  const load = async () => {
    const [b, sys] = await Promise.all([get('/api/admin/backups'), get('/api/admin/system')]);
    const bs = b.settings;
    const logBox = h('div', { class: 'log-box' });
    let level = 'info';
    const loadLogs = async () => {
      const logs = await get(`/api/admin/logs?level=${level}&limit=400`);
      mount(logBox, logs.map((e) => h('div', { class: `log-line ${e.level}` }, `${fmt.dt(e.ts)} ${e.level.toUpperCase()} [${e.scope}] ${e.message}${e.data ? ' ' + JSON.stringify(e.data) : ''}`)));
    };
    const fileInput = h('input', { type: 'file', accept: '.gz,.sqlite', style: { maxWidth: '320px' } });
    const jsonInput = h('input', { type: 'file', accept: '.json', style: { maxWidth: '320px' } });
    const s = sys.storage;
    mount(el,
      card('Stato del sistema', h('div', { class: 'grid c4' },
        stat('Versione', sys.version, `schema DB v${sys.schemaVersion}`),
        stat('Attivo da', fmt.dur(sys.uptimeS), `avvio ${fmt.dt(sys.startedAt)}`),
        stat('Memoria', fmt.bytes(sys.memory.rss), `Node ${sys.node} · ${sys.platform}`),
        stat('Spazio disco', s.disk ? fmt.bytes(s.disk.free) : '—', s.disk ? `liberi su ${fmt.bytes(s.disk.total)}` : '')),
        h('div', { class: 'grid c4', style: { marginTop: '12px' } },
          stat('Database', fmt.bytes(s.database)), stat('Immagini', fmt.bytes(s.images.bytes), `${s.images.files} file`),
          stat('Backup', fmt.bytes(s.backups)), stat('Log', fmt.bytes(s.logs))),
        h('div', { class: 'row', style: { marginTop: '12px' } }, Object.entries(sys.components).map(([k, v]) =>
          h('span', { class: 'pill' }, `${k}: ${typeof v === 'object' ? `overlay ${v.overlay} · admin ${v.admin}` : v}`))),
        h('p', { class: 'muted small' }, `Cartella dati nel container: ${sys.dataDir}. Lo stato del container è visibile anche nell'app Umbrel; l'endpoint /health viene usato da Docker per il controllo automatico.`)),
      card('Backup',
        h('div', { class: 'form' },
          field('Backup automatico giornaliero', bs, 'autoEnabled', { type: 'checkbox' }),
          field('Ora del backup (0–23)', bs, 'hour', { min: 0, max: 23 }),
          field('Backup automatici da conservare', bs, 'keep', { min: 1, max: 365 })),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn', onclick: () => act(() => put('/api/admin/backups/settings', bs), 'Impostazioni backup salvate') }, 'Salva impostazioni'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn primary', onclick: async () => { await act(() => post('/api/admin/backups'), 'Backup creato'); load(); } }, '💾 Crea backup ora')),
        h('div', { style: { marginTop: '14px' } }, table([
          { label: 'File', render: (r) => h('span', { class: 'mono small' }, r.filename) },
          { label: 'Tipo', key: 'kind' },
          { label: 'Data', render: (r) => fmt.dt(r.created_at) },
          { label: 'Dimensione', render: (r) => fmt.bytes(r.size_bytes) },
          { label: '', render: (r) => (r.exists ? h('div', { class: 'row' },
            h('a', { class: 'btn sm', href: `/api/admin/backups/${encodeURIComponent(r.filename)}/download` }, 'Scarica'),
            h('button', { class: 'btn sm accent', onclick: async () => {
              if (!await confirmDialog(`Ripristinare ${r.filename}? Il database attuale verrà sostituito (prima viene creato automaticamente un backup di sicurezza). Non è possibile durante una diretta.`, { danger: true, okLabel: 'Ripristina' })) return;
              const x = await act(() => post(`/api/admin/backups/${encodeURIComponent(r.filename)}/restore`), 'Backup ripristinato');
              if (x) setTimeout(() => location.reload(), 800);
            } }, 'Ripristina'),
            h('button', { class: 'btn sm danger', onclick: async () => {
              if (!await confirmDialog(`Eliminare definitivamente ${r.filename}?`, { danger: true })) return;
              await act(() => del(`/api/admin/backups/${encodeURIComponent(r.filename)}`), 'Backup eliminato'); load();
            } }, 'Elimina')) : h('span', { class: 'muted' }, 'file mancante')) },
        ], b.items, { empty: 'Nessun backup' })),
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('span', { class: 'muted small' }, 'Carica un backup (.sqlite.gz):'), fileInput,
          h('button', { class: 'btn', onclick: async () => {
            const f = fileInput.files[0];
            if (!f) return;
            const r = await act(() => api('POST', '/api/admin/backups-upload', f), 'Backup caricato: ora puoi ripristinarlo dalla lista');
            if (r) load();
          } }, 'Carica'))),
      card('Esportazione e importazione dati',
        h('p', { class: 'muted small' }, 'Esporta spettatori, collezioni e impostazioni dei Pokémon in un file JSON leggibile. L\'importazione unisce i dati (o li sostituisce) e crea prima un backup di sicurezza.'),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: '/api/admin/export' }, '⬇️ Esporta JSON'),
          h('span', { class: 'spacer' }), jsonInput,
          h('button', { class: 'btn', onclick: () => importJson('merge') }, 'Importa (unisci)'),
          h('button', { class: 'btn danger', onclick: () => importJson('replace') }, 'Importa (sostituisci collezioni)'))),
      card('Log',
        h('div', { class: 'tabs' }, [['debug', 'Tutto'], ['info', 'Info'], ['warn', 'Avvisi'], ['error', 'Errori']].map(([k, l]) =>
          h('button', { class: `btn sm ${k === level ? 'on' : ''}`, onclick: (e) => { level = k; e.target.parentElement.querySelectorAll('button').forEach((x) => x.classList.remove('on')); e.target.classList.add('on'); loadLogs(); } }, l))),
        logBox));
    loadLogs();

    async function importJson(mode) {
      const f = jsonInput.files[0];
      if (!f) return;
      if (mode === 'replace' && !await confirmDialog('Sostituire tutte le collezioni reali con quelle del file?', { danger: true })) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { alert('File JSON non valido'); return; }
      const r = await act(() => post('/api/admin/import', { data, mode }));
      if (r) alert(`Importati ${r.users} utenti e ${r.pokemon} Pokémon (${r.skipped} saltati).`);
    }
  };
  await load();
}
