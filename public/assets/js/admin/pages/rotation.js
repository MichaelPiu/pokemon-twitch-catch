// Overlay rotante: schermate che si alternano nella stessa Browser Source /overlay.
// Ordine, durata, transizione, blocco manuale e anteprima. La rotazione la decide
// il server (un solo timer per tutte le sorgenti OBS).
import { h, get, post, put, fmt } from '../../lib.js';
import { card, act, toast } from '../ui.js';
import { onLive } from '../main.js';

const HINT = {
  leaderboard: 'Top 10 della sessione (in corso o ultima), punti e catture; il primo è evidenziato.',
  captures: 'Ultime catture con immagine, allenatore e orario; rare e shiny evidenziate.',
  shiny: 'Ultimi shiny catturati, chi li ha trovati e il contatore della sessione.',
  goals: 'Obiettivo della community con barra di avanzamento e Pokémon del giorno (Eventi automatici).',
  stats: 'Le curiosità più interessanti delle Statistiche Community.',
  event: 'Evento Leggendario o Bonus Shiny in corso (compare solo durante l\'evento).',
};

export async function rotation({ el }) {
  let d;
  let s;
  let dirty = false;
  let frame = null;
  let previewKey = 'leaderboard';
  const markDirty = () => { dirty = true; saveBar.classList.remove('hidden'); };
  const save = async () => {
    const r = await act(() => put('/api/admin/rotation', s), 'Overlay rotante salvato');
    if (r) { dirty = false; load(r); }
  };
  const saveBar = h('div', { class: 'notice warn hidden row', style: { position: 'fixed', bottom: '16px', right: '24px', zIndex: 50, gap: '10px', background: 'var(--panel)', boxShadow: '0 8px 24px rgba(0,0,0,.45)' } },
    h('span', {}, 'Modifiche non salvate.'), h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost', onclick: () => { dirty = false; load(); } }, 'Annulla modifiche'),
    h('button', { class: 'btn primary', onclick: save }, 'Salva'));

  const lock = async (screen) => { const r = await act(() => post('/api/admin/rotation/lock', { screen }), screen ? `Schermata "${d.screens[screen]}" bloccata` : 'Rotazione ripresa'); if (r) load(r); };

  // Anteprima: la vera pagina /overlay in modalità anteprima (nessuna connessione), con i dati attuali.
  const showPreview = async (key = previewKey) => {
    previewKey = key;
    if (!frame?.contentWindow) return;
    const p = await get(`/api/admin/rotation/preview?screen=${encodeURIComponent(key)}`).catch((e) => { toast(e.message, 'err'); return null; });
    if (!p) return;
    const send = (type, data) => frame.contentWindow.postMessage({ source: 'livecatch-preview', type, data }, location.origin);
    send('rotation', { ...p, transition: s.transition, position: s.position });
    previewNote.textContent = p.empty ? `"${d.screens[key]}": nessun dato adesso, in OBS verrebbe saltata.` : `Anteprima di "${d.screens[key]}" con i dati attuali.`;
  };
  const previewNote = h('p', { class: 'muted small' });
  const onReady = (e) => {
    if (e.origin !== location.origin || e.data?.source !== 'livecatch-overlay' || e.data.type !== 'ready') return;
    showPreview();
  };
  window.addEventListener('message', onReady);
  // Creata una sola volta: gli aggiornamenti della pagina non ricaricano l'anteprima.
  frame = h('iframe', { src: '/overlay?preview=1', title: 'Anteprima overlay', style: { width: '100%', aspectRatio: '16 / 9', border: '1px solid var(--line)', borderRadius: '10px', background: 'repeating-conic-gradient(#2a2a3a 0% 25%, #1f1f2c 0% 50%) 50% / 24px 24px' } });
  const previewCard = card('Anteprima', previewNote, frame,
    h('p', { class: 'muted small' }, 'Anteprima locale con i dati attuali: non viene inviata agli overlay in OBS. Le modifiche di transizione e posizione si vedono subito, il resto dopo il salvataggio.'));

  const draw = () => {
    const cur = d.current;
    const head = card('Overlay rotante',
      h('p', { class: 'muted' }, 'Nella stessa sorgente OBS dell\'overlay (/overlay) si alternano automaticamente alcune schermate. Nessuna nuova Browser Source: ',
        'il cambio schermata non interrompe né ripete i suoni. Le schermate senza dati vengono saltate.'),
      h('div', { class: s.enabled ? 'notice ok' : 'notice warn', style: { margin: '8px 0' } },
        !s.enabled ? '○ Overlay rotante spento.'
          : cur ? `● In onda: "${d.screens[cur.screen]}"${cur.locked ? ' (bloccata)' : cur.endsAt ? ` fino alle ${fmt.time(cur.endsAt)}` : ''} · ${d.overlays} sorgenti OBS collegate`
            : '● Attivo, ma nessuna schermata ha dati in questo momento.'),
      h('div', { class: 'grid c2' },
        h('div', {},
          h('label', { class: 'check', style: { fontWeight: 700 } }, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => { s.enabled = e.target.checked; markDirty(); draw(); } }), 'Overlay rotante attivo'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.eventPriority, onchange: (e) => { s.eventPriority = e.target.checked; markDirty(); } }), 'Mostra subito un evento appena iniziato o un obiettivo raggiunto')),
        h('div', { class: 'grid c2' },
          h('label', { class: 'field' }, 'Transizione', h('select', { onchange: (e) => { s.transition = e.target.value; markDirty(); showPreview(); } },
            Object.entries(d.transitions).map(([k, l]) => h('option', { value: k, selected: s.transition === k }, l)))),
          h('label', { class: 'field' }, 'Posizione', h('select', { onchange: (e) => { s.position = e.target.value; markDirty(); showPreview(); } },
            Object.entries(d.positions).map(([k, l]) => h('option', { value: k, selected: s.position === k }, l)))),
          h('label', { class: 'field' }, `Durata minima (s, ${d.limits.minS.join('–')})`, h('input', { type: 'number', min: d.limits.minS[0], max: d.limits.minS[1], value: s.minS, oninput: (e) => { s.minS = Number(e.target.value); markDirty(); } })),
          h('label', { class: 'field' }, `Durata massima (s, ${d.limits.maxS.join('–')})`, h('input', { type: 'number', min: d.limits.maxS[0], max: d.limits.maxS[1], value: s.maxS, oninput: (e) => { s.maxS = Number(e.target.value); markDirty(); } })))),
      h('div', { class: 'row end', style: { marginTop: '8px', gap: '8px' } },
        s.lock ? h('button', { class: 'btn', onclick: () => lock(null) }, '🔓 Sblocca e riprendi la rotazione') : null,
        h('button', { class: 'btn', disabled: !d.settings.enabled, onclick: async () => { const r = await act(() => post('/api/admin/rotation/next', {})); if (r) load(r); } }, '⏭ Schermata successiva'),
        h('button', { class: 'btn primary', onclick: save }, 'Salva')));

    const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= s.screens.length) return; [s.screens[i], s.screens[j]] = [s.screens[j], s.screens[i]]; markDirty(); draw(); };
    const screens = card('Schermate e ordine',
      h('p', { class: 'muted small' }, `Ogni durata viene mantenuta tra ${s.minS} e ${s.maxS} secondi. "Blocca" tiene ferma una schermata finché non la sblocchi (resta bloccata anche dopo un riavvio).`),
      s.screens.map((x, i) => h('div', { class: 'row', style: { gap: '10px', padding: '8px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' } },
        h('span', { class: 'muted', style: { width: '20px' } }, i + 1),
        h('button', { class: 'btn sm ghost', title: 'Sposta su', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn sm ghost', title: 'Sposta giù', disabled: i === s.screens.length - 1, onclick: () => move(i, 1) }, '↓'),
        h('label', { class: 'check', style: { minWidth: '210px' } }, h('input', { type: 'checkbox', checked: x.enabled, onchange: (e) => { x.enabled = e.target.checked; markDirty(); } }), h('b', {}, d.screens[x.key])),
        h('label', { class: 'row', style: { gap: '4px' } }, h('input', { type: 'number', min: d.limits.durationS[0], max: d.limits.durationS[1], value: x.durationS, style: { width: '80px' }, oninput: (e) => { x.durationS = Number(e.target.value); markDirty(); } }), 's'),
        h('span', { class: 'pill' }, d.available[x.key] ? 'dati disponibili' : 'senza dati: saltata'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => showPreview(x.key) }, 'Anteprima'),
        d.settings.lock === x.key ? h('span', { class: 'pill' }, '🔒 bloccata')
          : h('button', { class: 'btn sm', disabled: !d.settings.enabled, onclick: () => lock(x.key) }, '🔒 Blocca'),
        h('div', { class: 'muted small', style: { width: '100%', paddingLeft: '30px' } }, HINT[x.key]))),
      h('div', { class: 'grid c2', style: { marginTop: '10px' } },
        h('label', { class: 'field' }, 'Ultime catture mostrate', h('input', { type: 'number', min: d.limits.capturesCount[0], max: d.limits.capturesCount[1], value: s.capturesCount, oninput: (e) => { s.capturesCount = Number(e.target.value); markDirty(); } })),
        h('label', { class: 'field' }, 'Periodo delle Statistiche Community', h('select', { onchange: (e) => { s.statsPeriod = e.target.value; markDirty(); } },
          Object.entries(d.periods).map(([k, l]) => h('option', { value: k, selected: s.statsPeriod === k }, l))))));

    // L'anteprima resta lo stesso nodo (mount la sposta senza ricaricarla).
    for (const c of [...el.children]) if (c !== previewCard) c.remove();
    el.prepend(saveBar, head, screens);
    if (!previewCard.isConnected) el.appendChild(previewCard);
    if (dirty) saveBar.classList.remove('hidden');
  };

  const load = async (view) => {
    d = view || await get('/api/admin/rotation');
    s = JSON.parse(JSON.stringify(d.settings));
    saveBar.classList.add('hidden');
    draw();
  };
  await load();
  let t = null;
  const off = onLive((type) => {
    if (type !== 'rotation' || dirty) return;
    clearTimeout(t);
    t = setTimeout(() => get('/api/admin/rotation').then((v) => { if (!dirty) { d = v; s = JSON.parse(JSON.stringify(v.settings)); draw(); } }).catch(() => {}), 500);
  });
  return () => { off(); clearTimeout(t); window.removeEventListener('message', onReady); };
}
