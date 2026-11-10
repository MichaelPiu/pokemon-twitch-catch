// Backup e ripristino su cartella di rete (volume montato nel container).
import { h, mount, get, post, put, del, fmt } from '../../lib.js';
import { card, table, act, confirmDialog, modal, field, toast } from '../ui.js';

const FREQ = [['hourly', 'Ogni ora'], ['every6h', 'Ogni 6 ore'], ['every12h', 'Ogni 12 ore'], ['daily', 'Ogni giorno'], ['weekly', 'Ogni settimana']];
const KIND = { auto: 'Automatico', manual: 'Manuale', 'pre-update': 'Prima di un aggiornamento', 'pre-restore': 'Prima di un ripristino' };
const STATUS = { ok: ['Valido', 'var(--ok)'], incomplete: ['Incompleto', 'var(--warn)'], corrupt: ['Danneggiato', 'var(--err)'] };
const CONTENT = { trainers: 'Allenatori', pokedexEntries: 'Esemplari nei Pokédex', pokemon: 'Pokémon', sessionsTwitch: 'Dirette Twitch', sessionsManual: 'Sessioni manuali', captureAttempts: 'Lanci', themes: 'Temi overlay', settings: 'Impostazioni' };

const checkList = (checks) => h('ul', { class: 'check-list' }, checks.map((c) => h('li', {}, h('span', { class: c.ok ? 'ok' : 'ko' }, c.ok ? '✔' : '✖'), h('span', {}, h('strong', {}, c.name), c.detail ? h('span', { class: 'muted small' }, ` — ${c.detail}`) : null))));
const contentList = (c) => (c ? h('div', { class: 'grid c4', style: { gap: '6px' } }, Object.entries(CONTENT).map(([k, l]) => h('div', { class: 'small' }, h('span', { class: 'muted' }, `${l}: `), c[k] ?? '—'))) : null);

export function netBackupCard({ reload }) {
  const box = h('div');
  const load = async () => {
    const d = await get('/api/admin/backups/network');
    const s = { ...d.settings };
    const st = d.state;
    const statusLine = st.lastStatus === 'error'
      ? h('div', { class: 'notice err' }, h('strong', {}, 'Ultimo tentativo non riuscito: '), st.lastError, st.nextRetryAt ? ` Nuovo tentativo automatico dalle ${fmt.dt(st.nextRetryAt)}.` : '')
      : null;
    mount(box,
      !d.mounted ? h('div', { class: 'notice warn' },
        h('strong', {}, 'Cartella di rete non montata. '), d.mountError,
        h('p', { class: 'small' }, 'Il container non collega da solo NAS o condivisioni: su umbrelOS scegli la cartella nelle impostazioni dell\'app Live Catch ("Cartella dei backup"), con Docker monta un volume su ', h('code', {}, d.root), '. Vedi la guida in docs/UMBREL.md.')) : null,
      statusLine,
      h('div', { class: 'grid c4', style: { margin: '12px 0' } },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Destinazione'), h('div', { class: 'value', style: { color: d.mounted ? 'var(--ok)' : 'var(--warn)' } }, d.mounted ? 'Montata' : 'Non montata'),
          h('div', { class: 'sub path-text', title: d.dir || '' }, d.dir || d.root)),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Ultima esecuzione'), h('div', { class: 'value' }, fmt.dt(st.lastRunAt)), h('div', { class: 'sub' }, { ok: 'riuscita', error: 'non riuscita', unchanged: 'nessuna modifica: backup non necessario' }[st.lastStatus] || '—')),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Ultimo backup riuscito'), h('div', { class: 'value' }, fmt.dt(st.lastSuccessAt)), h('div', { class: 'sub path-text' }, st.lastFile || '')),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Backup automatici'), h('div', { class: 'value', style: { color: s.enabled ? 'var(--ok)' : 'var(--muted)' } }, s.enabled ? 'Attivi' : 'Disattivati'), h('div', { class: 'sub' }, FREQ.find((f) => f[0] === s.frequency)?.[1] || ''))),
      h('div', { class: 'form' },
        field('Backup automatici sulla cartella di rete', s, 'enabled', { type: 'checkbox' }),
        h('label', { class: 'field' }, 'Sottocartella', h('input', { value: s.subdir, maxlength: 200, oninput: (e) => { s.subdir = e.target.value; } }),
          h('span', { class: 'small' }, `dentro ${d.root} — lettere, numeri, . _ - (niente "..")`)),
        field('Frequenza', s, 'frequency', { type: 'select', options: FREQ }),
        field('Orario (0–23, per giornaliero e settimanale)', s, 'hour', { min: 0, max: 23 }),
        field('Backup automatici da conservare', s, 'keep', { min: 1, max: 365, help: 'i manuali restano finché non li elimini; l\'ultimo backup valido non viene mai eliminato' }),
        field('Backup prima degli aggiornamenti dell\'app', s, 'beforeUpdate', { type: 'checkbox' })),
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } },
        h('button', { class: 'btn', onclick: async () => { const r = await act(() => put('/api/admin/backups/network/settings', s), 'Impostazioni salvate'); if (r) load(); } }, 'Salva impostazioni'),
        h('button', { class: 'btn', onclick: async () => {
          const r = await act(() => post('/api/admin/backups/network/test'));
          if (r) modal(r.ok ? 'Cartella pronta' : 'Problemi con la cartella', h('div', {}, checkList(r.checks), r.space ? h('p', { class: 'small muted' }, `Spazio libero: ${fmt.bytes(r.space.free)} su ${fmt.bytes(r.space.total)}`) : null,
            h('p', { class: 'small muted' }, 'La verifica crea e cancella solo un proprio file di prova: nessun altro file viene toccato.')));
        } }, 'Verifica connessione'),
        h('button', { class: 'btn', disabled: !d.mounted, onclick: async () => {
          if (!await confirmDialog(`Applicare ora la conservazione? Restano gli ultimi ${s.keep} backup automatici; manuali, file incompleti, file estranei e l'ultimo backup valido non vengono toccati.`)) return;
          const r = await act(() => post('/api/admin/backups/network/retention'));
          if (r) { toast(`Eliminati ${r.removed.length} backup automatici vecchi`, 'ok'); load(); }
        } }, 'Applica conservazione'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', disabled: !d.mounted || d.busy, onclick: async () => { const r = await act(() => post('/api/admin/backups/network', {}), 'Backup salvato sulla cartella di rete'); if (r) load(); } }, '💾 Backup ora')),
      d.listError ? h('div', { class: 'notice err', style: { marginTop: '12px' } }, d.listError) : null,
      h('div', { style: { marginTop: '14px' } }, table([
        { label: 'Data', render: (r) => fmt.dt(r.createdAt) || r.file.slice(10, 25) },
        { label: 'Tipo', render: (r) => KIND[r.kind] || r.kind },
        { label: 'Versione', render: (r) => r.appVersion || r.version },
        { label: 'Schema', render: (r) => (r.schemaVersion ? `v${r.schemaVersion}` : '—') },
        { label: 'Dimensione', render: (r) => (r.size != null ? fmt.bytes(r.size) : '—') },
        { label: 'Integrità', render: (r) => { const [l, c] = STATUS[r.status] || [r.status, 'var(--muted)']; return h('span', { style: { color: c }, title: r.problem || '' }, l); } },
        { label: '', render: (r) => h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => details(r) }, 'Dettagli'),
          h('button', { class: 'btn sm', onclick: () => verify(r) }, 'Verifica'),
          h('button', { class: 'btn sm accent', disabled: r.status !== 'ok', onclick: () => restoreWizard(r) }, 'Ripristina'),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!await confirmDialog(`Eliminare definitivamente ${r.file} dalla cartella di rete?`, { danger: true })) return;
            const x = await act(() => del(`/api/admin/backups/network/${encodeURIComponent(r.file)}`), 'Backup eliminato');
            if (x) load();
          } }, 'Elimina')) },
      ], d.items, { empty: d.mounted ? 'Nessun backup nella cartella' : 'Cartella non disponibile' })));
  };

  const details = (r) => modal(r.file, h('div', {},
    h('p', {}, h('strong', {}, KIND[r.kind] || r.kind), ` · versione ${r.appVersion || r.version} · schema v${r.schemaVersion ?? '?'} · ${fmt.bytes(r.size)}`),
    r.problem ? h('div', { class: 'notice warn' }, r.problem) : null,
    r.note ? h('p', { class: 'small' }, `Nota: ${r.note}`) : null,
    contentList(r.contents)));

  const verify = async (r) => {
    const v = await act(() => post(`/api/admin/backups/network/${encodeURIComponent(r.file)}/verify`));
    if (!v) return;
    modal(v.ok ? 'Backup integro' : 'Backup non valido', h('div', {}, checkList(v.checks), v.warnings?.length ? h('div', { class: 'notice warn' }, v.warnings.join(' ')) : null));
  };

  // Ripristino guidato: verifica, riepilogo, avviso, conferma esplicita.
  const restoreWizard = async (r) => {
    const body = h('div', {}, h('p', { class: 'muted' }, 'Verifica del backup in corso (checksum, integrità, compatibilità)…'));
    const m = modal('Ripristina backup', body);
    const v = await act(() => post(`/api/admin/backups/network/${encodeURIComponent(r.file)}/verify`));
    if (!v) { m.close(); return; }
    if (!v.ok) { mount(body, h('div', { class: 'notice err' }, 'Questo backup non può essere ripristinato.'), checkList(v.checks)); return; }
    const confirmInput = h('input', { placeholder: 'RIPRISTINA', autocomplete: 'off' });
    const result = h('div');
    mount(body,
      h('p', {}, h('strong', {}, r.file)),
      h('p', {}, `Creato il ${fmt.dt(v.manifest.createdAt)} con la versione ${v.manifest.app?.version} (schema v${v.schemaVersion}).`),
      checkList(v.checks),
      v.warnings.length ? h('div', { class: 'notice warn', style: { marginTop: '8px' } }, v.warnings.join(' ')) : null,
      h('h3', {}, 'Contenuto'), contentList(v.contents),
      h('div', { class: 'notice err', style: { marginTop: '12px' } },
        h('strong', {}, 'Il ripristino sostituisce TUTTI i dati attuali'), ' (Pokédex, catture, sessioni, statistiche, impostazioni, temi). ',
        'Prima viene creato automaticamente un backup di sicurezza dello stato attuale. Una sessione manuale o DEMO in corso viene fermata; durante una diretta Twitch il ripristino non è possibile. ',
        'Restano invariate le impostazioni della cartella di rete e il tuo accesso alla dashboard.'),
      h('label', { class: 'field', style: { marginTop: '12px' } }, 'Per confermare scrivi RIPRISTINA', confirmInput),
      h('div', { class: 'row end', style: { marginTop: '10px' } },
        h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Annulla'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (confirmInput.value.trim() !== 'RIPRISTINA') { toast('Scrivi RIPRISTINA per confermare', 'err'); return; }
          mount(result, h('p', { class: 'muted' }, 'Ripristino in corso: il gioco è fermo, non chiudere la pagina…'));
          const x = await act(() => post(`/api/admin/backups/network/${encodeURIComponent(r.file)}/restore`, { confirm: 'RIPRISTINA', sha256: v.manifest.archive.sha256 }));
          if (!x) { mount(result); return; }
          mount(result, h('div', { class: 'notice ok' }, `Ripristino completato. Backup di sicurezza dello stato precedente: ${x.safetyBackup}. Database schema v${x.schemaVersion}, integrità ${x.integrity ? 'ok' : 'NON ok'}.`));
          setTimeout(() => location.reload(), 2500);
        } }, 'Ripristina ora')),
      result);
  };

  load().catch((e) => mount(box, h('div', { class: 'notice err' }, e.message)));
  return card('Backup su cartella di rete (NAS, altro server, disco esterno)',
    h('p', { class: 'muted small' }, 'Copie complete e verificate del database (Pokédex, catture, statistiche, sessioni Twitch e manuali, impostazioni, temi) su una cartella montata nel container. Ogni backup ha un manifest con versione, schema e checksum SHA-256. La chiave di cifratura e le sessioni di accesso non vengono copiate.'),
    box);
}
