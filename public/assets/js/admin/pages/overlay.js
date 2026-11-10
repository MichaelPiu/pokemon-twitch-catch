// Overlay Designer: temi dell'overlay, editor visuale con anteprima in tempo reale
// e simulatore di eventi isolato dai dati reali.
import { h, mount, get, post, put, del } from '../../lib.js';
import { card, act, confirmDialog, promptDialog, modal, toast } from '../ui.js';
import { effectiveSettings, exportTheme, parseImport, validColor } from '../../overlay/theme-core.js';

const POS_LABEL = {
  'top-left': '↖', 'top-center': '↑', 'top-right': '↗', 'center-left': '←', center: '•', 'center-right': '→',
  'bottom-left': '↙', 'bottom-center': '↓', 'bottom-right': '↘',
};
const ENTRANCE_LABEL = { pop: 'Pop elastico', fade: 'Dissolvenza', slide: 'Scorrimento', rise: 'Risalita', zoom: 'Zoom', flip: 'Rotazione 3D', glitch: 'Glitch', wipe: 'Tendina' };
const EXIT_LABEL = { fade: 'Dissolvenza', shrink: 'Rimpicciolimento', slide: 'Scorrimento', glitch: 'Glitch', wipe: 'Tendina' };
const TIMER_LABEL = { bar: 'Barra', ring: 'Anello attorno al Pokémon', digits: 'Conto alla rovescia numerico' };
const BACKDROPS = { checker: 'Scacchiera (trasparente)', game: 'Scena di gioco simulata', dark: 'Scuro', light: 'Chiaro' };
const SIM_BUTTONS = [
  ['spawn', '✨ Spawn'], ['shiny', '🌟 Shiny'], ['legendary', '👑 Leggendario'], ['fail', '💨 Lancio fallito'], ['catch', '🎉 Cattura'],
  ['flee', '🏃 Fuga'], ['expire', '⌛ Scadenza'], ['notify', '💬 Notifica'], ['sequence', '▶ Sequenza completa'], ['clear', '🧹 Pulisci'],
];

const clone = (o) => structuredClone(o);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Colore → { hex, alpha } per il selettore (accetta #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), transparent).
function splitColor(c) {
  const s = String(c || '').trim();
  if (s === 'transparent') return { hex: '#000000', alpha: 0 };
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let x = m[1];
    if (x.length <= 4) x = x.split('').map((ch) => ch + ch).join('');
    return { hex: `#${x.slice(0, 6)}`, alpha: x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return { hex: `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`, alpha: m[4] === undefined ? 1 : Number(m[4]) };
  return { hex: '#000000', alpha: 1 };
}
function joinColor(hex, alpha) {
  if (alpha >= 0.999) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(alpha * 100) / 100})`;
}

export async function overlay({ el }) {
  let data = await get('/api/admin/overlay/themes');
  const opts = data.options;
  let selectedId = data.activeId;
  let saved = null; // tema come salvato sul server
  let draft = null; // { name, base, config } in modifica
  let simSpawn = null;
  let resolution = '1920x1080';
  let backdrop = 'checker';
  let toObs = false;
  let previewReady = false;

  const themeById = (id) => data.themes.find((t) => t.id === id);
  const dirty = () => saved && draft && (!same(saved.config, draft.config) || (!saved.builtin && saved.name !== draft.name));

  // --- Anteprima --------------------------------------------------------------
  const frame = h('iframe', { class: 'od-frame', src: '/overlay?preview=1', title: 'Anteprima overlay', tabindex: '-1' });
  const frameBox = h('div', { class: 'od-stage bd-checker' }, frame);
  const send = (type, d) => frame.contentWindow?.postMessage({ source: 'livecatch-preview', type, data: d }, location.origin);
  let rafPending = false;
  const pushPreview = () => {
    if (!previewReady || rafPending || !draft) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      send('settings', effectiveSettings({ ...draft, id: saved?.id, slug: saved?.slug }));
    });
  };
  const onMsg = (e) => {
    if (e.source !== frame.contentWindow || e.data?.source !== 'livecatch-overlay') return;
    if (e.data.type === 'ready') { previewReady = true; pushPreview(); if (simSpawn) send('spawn', simSpawn); }
  };
  window.addEventListener('message', onMsg);
  const fitFrame = () => {
    const [w, hgt] = resolution.split('x').map(Number);
    const box = frameBox.clientWidth || 640;
    frame.style.width = `${w}px`;
    frame.style.height = `${hgt}px`;
    frame.style.transform = `scale(${box / w})`;
    frameBox.style.height = `${(box / w) * hgt}px`;
  };
  const ro = new ResizeObserver(fitFrame);
  ro.observe(frameBox);

  const simulate = async (kind) => {
    let text;
    if (kind === 'notify') {
      text = await promptDialog('Testo della notifica di prova', { placeholder: 'Notifica di prova: il simulatore funziona!', okLabel: 'Mostra' });
      if (text === null || text === undefined) return;
    }
    const target = toObs && !data.obs.busy ? 'obs' : 'preview';
    let r;
    try {
      r = await post('/api/admin/overlay/simulate', { kind, target, text, spawn: target === 'preview' ? simSpawn : undefined });
    } catch (e) {
      toast(e.message, 'err');
      // Il gioco è partito nel frattempo: l'invio all'overlay pubblico si disattiva.
      if (e.status === 409) await refreshObs();
      return;
    }
    simSpawn = r.spawn;
    // L'anteprima mostra sempre la simulazione, con gli stessi tempi.
    let at = 0;
    for (const e of r.events) { at += e.delayMs; setTimeout(() => send(e.type, e.data), at); }
    if (target === 'obs') toast(`Simulazione inviata all'overlay pubblico (${r.overlays} sorgenti OBS collegate)`, 'ok');
  };

  // --- Editor -------------------------------------------------------------------
  const editor = h('div', { class: 'od-editor' });
  const header = h('div', { class: 'od-head' });
  const list = h('div', { class: 'od-themes' });

  const change = () => { renderHeader(); pushPreview(); };
  const ctl = (label, input, hint) => h('label', { class: 'od-ctl' }, h('span', { class: 'od-lbl' }, label), input, hint ? h('span', { class: 'od-hint' }, hint) : null);

  const slider = (group, key, label, { min, max, step = 1, unit = '' }) => {
    const out = h('output', {}, `${draft.config[group][key]}${unit}`);
    const input = h('input', {
      type: 'range', min, max, step, value: draft.config[group][key],
      oninput: (e) => { draft.config[group][key] = Number(e.target.value); out.textContent = `${e.target.value}${unit}`; change(); },
    });
    return ctl(label, h('div', { class: 'od-range' }, input, out));
  };
  const number = (group, key, label, { min, max, step = 1, unit }) => ctl(label, h('div', { class: 'od-num' },
    h('input', { type: 'number', min, max, step, value: draft.config[group][key], oninput: (e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n) && e.target.value !== '') { draft.config[group][key] = Math.min(max, Math.max(min, n)); change(); }
    } }), unit ? h('span', { class: 'od-unit' }, unit) : null));
  const toggle = (group, key, label) => h('label', { class: 'od-toggle' },
    h('input', { type: 'checkbox', checked: !!draft.config[group][key], onchange: (e) => { draft.config[group][key] = e.target.checked; change(); } }), h('span', {}, label));
  const select = (group, key, label, map, after) => ctl(label, h('select', {
    onchange: (e) => { draft.config[group][key] = e.target.value; change(); after?.(); },
  }, Object.entries(map).map(([v, l]) => h('option', { value: v, selected: draft.config[group][key] === v }, l))));
  const color = (key, label) => {
    const cur = splitColor(draft.config.colors[key]);
    const text = h('input', { class: 'od-ctext', value: draft.config.colors[key], spellcheck: 'false' });
    const pick = h('input', { type: 'color', value: cur.hex });
    const alpha = h('input', { type: 'range', min: 0, max: 100, value: Math.round(cur.alpha * 100), title: 'Opacità' });
    const sw = h('span', { class: 'od-swatch', style: { '--c': draft.config.colors[key] } });
    const setVal = (v, from) => {
      if (!validColor(v)) { text.classList.add('bad'); return; }
      text.classList.remove('bad');
      draft.config.colors[key] = v;
      sw.style.setProperty('--c', v);
      if (from !== 'text') text.value = v;
      if (from === 'text') { const p = splitColor(v); pick.value = p.hex; alpha.value = Math.round(p.alpha * 100); }
      change();
    };
    pick.addEventListener('input', () => setVal(joinColor(pick.value, Number(alpha.value) / 100), 'pick'));
    alpha.addEventListener('input', () => setVal(Number(alpha.value) === 0 ? 'transparent' : joinColor(pick.value, Number(alpha.value) / 100), 'pick'));
    text.addEventListener('input', () => setVal(text.value.trim(), 'text'));
    return ctl(label, h('div', { class: 'od-color' }, sw, pick, text, alpha));
  };
  const section = (title, open, ...body) => h('details', { class: 'od-sec', open }, h('summary', {}, title), h('div', { class: 'od-grid' }, ...body));

  function renderEditor() {
    const c = draft.config;
    const posGrid = h('div', { class: 'od-pos' }, opts.positions.map((p) => h('button', {
      type: 'button', class: `od-posbtn ${c.layout.position === p ? 'on' : ''}`, title: p,
      onclick: (e) => { c.layout.position = p; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget); change(); },
    }, POS_LABEL[p])));
    const customFont = h('input', {
      value: c.typography.customFont || '', placeholder: 'es. Poppins', disabled: c.typography.font !== 'custom',
      oninput: (e) => { const v = e.target.value; if (v === '' || /^[A-Za-z0-9 '-]{1,60}$/.test(v)) { c.typography.customFont = v; e.target.classList.remove('bad'); change(); } else e.target.classList.add('bad'); },
    });
    mount(editor,
      section('🎨 Colori', true,
        color('primary', 'Principale'), color('secondary', 'Secondario / accento'), color('panel', 'Sfondo dei pannelli'),
        color('background', 'Sfondo dell\'overlay'), color('text', 'Testo'), color('muted', 'Testo secondario'),
        color('success', 'Cattura riuscita'), color('failure', 'Fallimento / fuga'),
        h('p', { class: 'od-note' }, 'Lo sfondo dell\'overlay normalmente resta trasparente (opacità 0): OBS mostra la scena sottostante.')),
      section('🔤 Caratteri', false,
        select('typography', 'font', 'Font', opts.fonts, () => { customFont.disabled = c.typography.font !== 'custom'; }),
        ctl('Font personalizzato', customFont, 'Deve essere installato sul PC che esegue OBS.'),
        slider('typography', 'baseSize', 'Dimensione testo', { min: 10, max: 32, unit: 'px' }),
        slider('typography', 'titleSize', 'Dimensione nome Pokémon', { min: 12, max: 72, unit: 'px' }),
        slider('typography', 'weight', 'Spessore', { min: 300, max: 900, step: 100 }),
        slider('typography', 'letterSpacing', 'Spaziatura lettere', { min: 0, max: 0.5, step: 0.01, unit: 'em' }),
        toggle('typography', 'uppercase', 'Nome in maiuscolo')),
      section('▢ Bordi, angoli e ombre', false,
        slider('shape', 'radius', 'Raggio degli angoli', { min: 0, max: 48, unit: 'px' }),
        slider('shape', 'borderWidth', 'Spessore del bordo', { min: 0, max: 12, unit: 'px' }),
        slider('shape', 'shadow', 'Ombra', { min: 0, max: 100, unit: '%' }),
        slider('shape', 'glow', 'Bagliore', { min: 0, max: 100, unit: '%' })),
      section('📐 Posizione e dimensioni', true,
        ctl('Posizione sullo schermo', posGrid),
        number('layout', 'offsetX', 'Margine orizzontale', { min: 0, max: 1800, unit: 'px' }),
        number('layout', 'offsetY', 'Margine verticale', { min: 0, max: 1000, unit: 'px' }),
        slider('layout', 'panelWidth', 'Larghezza del pannello', { min: 200, max: 1700, step: 10, unit: 'px' }),
        slider('layout', 'imageSize', 'Dimensione immagine', { min: 48, max: 320, unit: 'px' }),
        slider('layout', 'scale', 'Scala complessiva', { min: 0.3, max: 3, step: 0.05, unit: '×' }),
        h('p', { class: 'od-note' }, 'Misure riferite a una scena 1920×1080: a 1280×720 tutto viene ridotto in proporzione.')),
      section('🎬 Animazioni e transizioni', false,
        toggle('animation', 'enabled', 'Animazioni attive'),
        select('animation', 'entrance', 'Entrata del Pokémon', Object.fromEntries(opts.entrances.map((k) => [k, ENTRANCE_LABEL[k] || k]))),
        select('animation', 'exit', 'Uscita', Object.fromEntries(opts.exits.map((k) => [k, EXIT_LABEL[k] || k]))),
        slider('animation', 'speed', 'Velocità', { min: 0.25, max: 4, step: 0.05, unit: '×' }),
        toggle('animation', 'idle', 'Animazioni continue (fluttuazione, riflessi)'),
        slider('animation', 'queueLimit', 'Eventi in coda prima di saltare le animazioni', { min: 2, max: 50 }),
        h('p', { class: 'od-note' }, 'Con molti riscatti ravvicinati le animazioni si accorciano (coda a metà) e poi vengono saltate (coda piena): esiti, tentativi e catture restano sempre esatti.')),
      section('🔔 Notifiche', false,
        slider('notifications', 'durationMs', 'Durata', { min: 1000, max: 30000, step: 250, unit: ' ms' }),
        slider('notifications', 'maxVisible', 'Visibili insieme', { min: 1, max: 6 }),
        number('notifications', 'maxQueue', 'Massimo in coda', { min: 1, max: 100 }),
        toggle('notifications', 'showThrows', 'Mostra i lanci'), toggle('notifications', 'showFailures', 'Mostra i tentativi falliti'),
        toggle('notifications', 'showCatches', 'Mostra le catture'), toggle('notifications', 'showFlee', 'Mostra fughe e scadenze')),
      section('⏱ Timer e informazioni', false,
        toggle('elements', 'header', 'Intestazione "È apparso…"'), toggle('elements', 'image', 'Immagine'), toggle('elements', 'name', 'Nome'),
        toggle('elements', 'dexNumber', 'Numero Pokédex'), toggle('elements', 'rarity', 'Rarità'), toggle('elements', 'types', 'Tipi'),
        toggle('elements', 'attempts', 'Tentativi'), toggle('elements', 'rarityColors', 'Colori della rarità sul pannello'),
        toggle('elements', 'timer', 'Timer'), select('elements', 'timerStyle', 'Stile del timer', TIMER_LABEL)),
      section('✨ Effetti visivi', false,
        slider('effects', 'intensity', 'Intensità', { min: 0, max: 100, unit: '%' }),
        toggle('effects', 'particles', 'Particelle e coriandoli'), toggle('effects', 'shimmer', 'Riflessi e luccichii'),
        toggle('effects', 'scanlines', 'Linee di scansione'),
        h('p', { class: 'od-note' }, 'Intensità 0: nessuna animazione continua, il carico su OBS è minimo.')));
  }

  function renderHeader() {
    if (!saved) return;
    const isActive = data.activeId === saved.id;
    const nameInput = saved.builtin
      ? h('h2', { class: 'od-title' }, draft.name)
      : h('input', { class: 'od-name', value: draft.name, maxlength: 60, oninput: (e) => { draft.name = e.target.value; renderHeaderFlags(); } });
    mount(header,
      h('div', { class: 'od-head-main' }, nameInput,
        h('div', { class: 'od-flags' },
          h('span', { class: 'tag' }, opts.layouts[draft.base] || draft.base),
          saved.builtin ? h('span', { class: 'tag' }, 'Preset') : h('span', { class: 'tag' }, 'Personalizzato'),
          isActive ? h('span', { class: 'tag od-live' }, '● In uso su OBS') : null,
          flags)),
      h('div', { class: 'od-actions' },
        h('button', { class: 'btn primary', disabled: !dirty(), onclick: save }, '💾 Salva'),
        h('button', { class: 'btn', disabled: isActive && !dirty(), onclick: activate, title: 'Usa questo tema nell\'overlay di OBS' }, isActive ? '✓ Attivo' : '▶ Usa su OBS'),
        h('button', { class: 'btn', onclick: duplicate }, '⧉ Duplica'),
        h('button', { class: 'btn', onclick: reset, disabled: !saved.modified && !dirty(), title: saved.builtin ? 'Torna ai valori del preset' : 'Torna ai valori con cui il tema è stato creato' }, '↺ Ripristina'),
        h('button', { class: 'btn', onclick: exportJson }, '⤓ Esporta'),
        saved.builtin ? null : h('button', { class: 'btn danger', onclick: remove }, '🗑 Elimina')));
    renderHeaderFlags();
  }
  const flags = h('span', { class: 'od-dirty' });
  function renderHeaderFlags() {
    flags.textContent = dirty() ? '● Modifiche non salvate' : (saved?.modified ? 'Modificato rispetto all\'originale' : '');
    const btn = header.querySelector('.od-actions .btn.primary');
    if (btn) btn.disabled = !dirty();
  }

  function renderList() {
    mount(list, data.themes.map((t) => h('button', {
      type: 'button', class: `od-theme ${t.id === selectedId ? 'sel' : ''}`, onclick: () => select_(t.id),
      style: { '--p': t.config.colors.primary, '--s': t.config.colors.secondary, '--pn': t.config.colors.panel },
    },
    h('span', { class: `od-thumb th-${t.base}` }, h('i'), h('i'), h('i')),
    h('span', { class: 'od-tname' }, t.name),
    h('span', { class: 'od-tmeta' }, data.activeId === t.id ? '● attivo' : t.builtin ? (t.modified ? 'preset · modificato' : 'preset') : 'personalizzato'))),
    h('button', { type: 'button', class: 'od-theme od-new', onclick: createNew }, h('span', { class: 'od-plus' }, '+'), h('span', { class: 'od-tname' }, 'Nuovo tema')),
    h('button', { type: 'button', class: 'od-theme od-new', onclick: importJson }, h('span', { class: 'od-plus' }, '⤒'), h('span', { class: 'od-tname' }, 'Importa JSON')));
  }

  async function select_(id, { force = false } = {}) {
    if (!force && dirty() && id !== selectedId && !await confirmDialog('Ci sono modifiche non salvate. Passare a un altro tema e perderle?', { okLabel: 'Perdi le modifiche', danger: true })) return;
    selectedId = id;
    saved = themeById(id);
    draft = { name: saved.name, base: saved.base, config: clone(saved.config) };
    renderList(); renderHeader(); renderEditor(); pushPreview();
  }

  async function reload(id = selectedId) {
    data = await get('/api/admin/overlay/themes');
    await select_(themeById(id) ? id : data.activeId, { force: true });
  }

  // Salvataggio con la revisione su cui si sta lavorando: se il tema è stato
  // salvato altrove nel frattempo (altra scheda, altra persona) il server risponde
  // 409 e si sceglie esplicitamente se ricaricare o sovrascrivere.
  async function persist() {
    const body = { config: draft.config, rev: saved.rev };
    if (!saved.builtin) body.name = draft.name;
    try {
      return await put(`/api/admin/overlay/themes/${saved.id}`, body);
    } catch (e) {
      if (e.status !== 409 || !e.details?.current) { toast(e.message, 'err'); return undefined; }
      const overwrite = await confirmDialog(`"${saved.name}" è stato modificato altrove dopo che lo hai aperto. Sovrascrivere quelle modifiche con le tue? Scegli Annulla per ricaricare la versione salvata (le tue modifiche andranno perse).`, { okLabel: 'Sovrascrivi', danger: true });
      if (!overwrite) { await reload(saved.id); toast('Caricata la versione salvata più recente', 'ok'); return undefined; }
      return act(() => put(`/api/admin/overlay/themes/${saved.id}`, { ...body, rev: undefined, force: true }));
    }
  }

  async function save() {
    const r = await persist();
    if (!r) return;
    toast(data.activeId === saved.id ? 'Tema salvato e applicato a OBS' : 'Tema salvato', 'ok');
    if (r.warnings?.length) toast(`Alcuni valori sono stati corretti: ${r.warnings.slice(0, 3).join('; ')}`, 'err');
    await reload(saved.id);
  }

  async function activate() {
    if (dirty() && !await confirmDialog('Il tema ha modifiche non salvate. Salvarle e usarlo su OBS?', { okLabel: 'Salva e usa' })) return;
    if (dirty()) { const ok = await persist(); if (!ok) return; }
    const r = await act(() => post(`/api/admin/overlay/themes/${saved.id}/activate`), 'Tema applicato all\'overlay');
    if (r) await reload(saved.id);
  }

  async function duplicate() {
    const name = await promptDialog('Nome del nuovo tema', { placeholder: `${draft.name} (copia)`, okLabel: 'Duplica' });
    if (name === null || name === undefined) return;
    // La copia parte dalla bozza attuale (anche se non salvata).
    const r = await act(() => post('/api/admin/overlay/themes', { name: name || `${draft.name} (copia)`, base: draft.base, config: draft.config }), 'Tema duplicato');
    if (r) await reload(r.theme.id);
  }

  async function reset() {
    if (!await confirmDialog(saved.builtin ? `Riportare "${saved.name}" ai valori originali del preset?` : `Riportare "${saved.name}" ai valori con cui è stato creato?`, { okLabel: 'Ripristina' })) return;
    const r = await guarded(() => post(`/api/admin/overlay/themes/${saved.id}/reset`, { rev: saved.rev }), 'Valori originali ripristinati');
    if (r) await reload(saved.id);
  }

  // Ripristino ed eliminazione con la revisione aperta: se il tema è stato
  // salvato altrove nel frattempo il server risponde 409 e si ricarica la
  // versione attuale invece di agire su modifiche che non si sono viste.
  async function guarded(fn, okMsg) {
    try {
      const r = await fn();
      toast(okMsg, 'ok');
      return r;
    } catch (e) {
      if (e.status === 409 && e.details?.current) {
        await reload(saved.id);
        toast(`"${saved.name}" è stato modificato altrove: è stata caricata la versione più recente, controlla e riprova`, 'err');
      } else toast(e.message, 'err');
      return undefined;
    }
  }

  async function remove() {
    if (!await confirmDialog(`Eliminare il tema "${saved.name}"? L'operazione non si può annullare.`, { danger: true, okLabel: 'Elimina' })) return;
    const r = await guarded(() => del(`/api/admin/overlay/themes/${saved.id}?rev=${saved.rev}`), 'Tema eliminato');
    if (r) await reload(r.activeId);
  }

  function exportJson() {
    const payload = dirty() ? exportTheme({ name: draft.name, base: draft.base, config: draft.config }) : exportTheme(saved);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `livecatch-tema-${(draft.name || 'tema').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function importJson() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 64 * 1024) { toast('File troppo grande (massimo 64 KB)', 'err'); return; }
      const text = await f.text();
      try { parseImport(text); } catch (e) { toast(e.message, 'err'); return; } // controllo immediato; il server rivalida
      const r = await act(() => post('/api/admin/overlay/themes/import', { json: text }), 'Tema importato');
      if (!r) return;
      if (r.warnings?.length) {
        modal('Importazione completata con correzioni', h('div', {}, h('p', {}, 'Questi valori non erano validi e sono stati sostituiti con quelli predefiniti:'),
          h('ul', { class: 'od-warn' }, r.warnings.slice(0, 30).map((w) => h('li', {}, w)))));
      }
      await reload(r.theme.id);
    });
    input.click();
  }

  async function createNew() {
    const sel = h('select', {}, Object.entries(opts.layouts).map(([k, l]) => h('option', { value: k }, l)));
    const name = h('input', { value: 'Il mio tema', maxlength: 60 });
    const m = modal('Nuovo tema', h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Nome', name),
      h('label', { class: 'field' }, 'Stile grafico di partenza', sel),
      h('p', { class: 'muted small' }, 'Lo stile grafico definisce la disposizione degli elementi; colori, caratteri ed effetti si modificano poi liberamente.'),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: async () => {
        const r = await act(() => post('/api/admin/overlay/themes', { name: name.value, base: sel.value }), 'Tema creato');
        if (r) { m.close(); await reload(r.theme.id); }
      } }, 'Crea'))));
  }

  // --- Pannello anteprima e simulatore ---------------------------------------------------
  const obsUrl = `${location.origin}/overlay`;
  // Destinazione della simulazione: l'anteprima privata (sempre) e, solo se
  // scelto e a gioco fermo, anche l'overlay pubblico visto in OBS.
  const obsCheck = h('input', { type: 'checkbox', onchange: (e) => { toObs = e.target.checked; renderObsState(); } });
  const obsState = h('span', { class: 'od-obs-state small' });
  const obsToggle = h('label', { class: 'od-toggle' }, obsCheck,
    h('span', {}, 'Invia anche all\'overlay pubblico (OBS)'));
  function renderObsState() {
    const busy = data.obs.busy;
    obsCheck.disabled = !!busy;
    if (busy) { obsCheck.checked = false; toObs = false; }
    obsState.className = `od-obs-state small ${busy ? 'warn' : toObs ? 'on' : ''}`;
    obsState.textContent = busy
      ? `Overlay pubblico in uso (${busy}): le simulazioni restano solo nell'anteprima privata.`
      : toObs ? '⚠ Le simulazioni compariranno anche nella sorgente OBS.' : 'Le simulazioni compaiono solo in questa anteprima privata.';
  }
  async function refreshObs() {
    const fresh = await get('/api/admin/overlay/themes').catch(() => null);
    if (fresh) data.obs = fresh.obs;
    renderObsState();
  }
  const previewCard = h('section', { class: 'card od-preview' },
    h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Anteprima'), h('span', { class: 'spacer' }),
      h('select', { class: 'select-sm', title: 'Risoluzione della sorgente OBS', onchange: (e) => { resolution = e.target.value; fitFrame(); } },
        h('option', { value: '1920x1080' }, '1920×1080'), h('option', { value: '1280x720' }, '1280×720')),
      h('select', { class: 'select-sm', title: 'Sfondo dell\'anteprima', onchange: (e) => { backdrop = e.target.value; frameBox.className = `od-stage bd-${backdrop}`; } },
        Object.entries(BACKDROPS).map(([k, l]) => h('option', { value: k }, l)))),
    frameBox,
    h('div', { class: 'od-sim' }, SIM_BUTTONS.map(([k, l]) => h('button', { class: 'btn sm', onclick: () => simulate(k) }, l))),
    h('div', { class: 'od-simfoot' }, obsToggle, obsState,
      h('span', { class: 'muted small' }, 'Le simulazioni non toccano Pokédex, statistiche, classifiche né lo storico. Sull\'overlay pubblico sono consentite solo a gioco fermo (OFFLINE, senza DEMO), mostrano il badge "SIMULAZIONE" e vengono tolte appena parte la diretta.')));

  const obsCard = card('Collegamento a OBS',
    h('ol', { class: 'steps' },
      h('li', {}, 'In OBS: ', h('b', {}, 'Sorgenti → + → Browser'), '.'),
      h('li', {}, 'URL: ', h('code', {}, obsUrl), ' ', h('button', { class: 'btn sm', onclick: () => { navigator.clipboard?.writeText(obsUrl); toast('URL copiato', 'ok'); } }, 'Copia')),
      h('li', {}, 'Larghezza e altezza uguali alla tela (1920×1080 oppure 1280×720): l\'overlay si adatta da solo.'),
      h('li', {}, 'Il cambio di tema arriva subito via WebSocket, senza ricaricare la sorgente.'),
      h('li', {}, 'Dopo un aggiornamento dell\'app: nelle proprietà della sorgente Browser premi "Aggiorna la cache della pagina corrente" per caricare i nuovi file.')),
    h('p', { class: 'muted small' }, `Overlay collegati in questo momento: ${data.obs.overlays}.`));

  mount(el, h('div', { class: 'od' },
    h('section', { class: 'card od-top' }, list),
    h('div', { class: 'od-cols' },
      h('div', { class: 'od-left' }, h('section', { class: 'card' }, header, editor)),
      h('div', { class: 'od-right' }, previewCard, obsCard))));

  await select_(selectedId, { force: true });
  fitFrame();
  renderObsState();
  // Stato dell'overlay pubblico aggiornato periodicamente (diretta avviata da un'altra scheda).
  const obsTimer = setInterval(() => { if (!document.hidden) refreshObs(); }, 15000);

  const beforeUnload = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return () => { clearInterval(obsTimer); window.removeEventListener('message', onMsg); window.removeEventListener('beforeunload', beforeUnload); ro.disconnect(); };
}
