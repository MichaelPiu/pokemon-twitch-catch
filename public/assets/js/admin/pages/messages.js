// Messaggi Twitch: messaggi automatici del bot in chat (spawn, catture, sessioni).
// Le variabili vengono sostituite dal server; qui l'anteprima usa gli stessi
// valori d'esempio ed è solo testo (mai HTML). "Prova in chat" invia davvero il
// messaggio, solo se Twitch è collegato.
import { h, mount, get, post, put, fmt } from '../../lib.js';
import { card, act, field, toast, confirmDialog } from '../ui.js';

const GROUPS = [
  ['spawn', 'Spawn'],
  ['capture', 'Catture'],
  ['session', 'Sessioni'],
];
const OUTCOME = { sent: 'inviato', skipped: 'non inviato', failed: 'errore' };

// Stessa sostituzione del server, per l'anteprima immediata.
const render = (text, vars) => String(text || '')
  .replace(/\{([a-z_]+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m))
  .replace(/\s+/g, ' ').trim().replace(/^[\s/.\\]+/, '');

let seq = 0;
const newId = () => `m-${Date.now().toString(36)}${(seq++).toString(36)}`.slice(0, 40);

export async function messages({ el }) {
  let d;
  let s;
  let dirty = false;
  const markDirty = () => { dirty = true; saveBar.classList.remove('hidden'); };

  const save = async () => {
    const body = {
      enabled: s.enabled, allowChannelAccount: s.allowChannelAccount, maxPerMinute: Number(s.maxPerMinute),
      events: s.events, messages: s.messages.map((m) => ({ id: m.id, event: m.event, enabled: m.enabled, text: m.text })),
    };
    const r = await act(() => put('/api/admin/chat-messages', body), 'Messaggi salvati');
    if (r) { dirty = false; load(r); }
  };
  const saveBar = h('div', { class: 'notice warn hidden row', style: { position: 'fixed', bottom: '16px', right: '24px', zIndex: 50, gap: '10px', background: 'var(--panel)', boxShadow: '0 8px 24px rgba(0,0,0,.45)' } },
    h('span', {}, 'Modifiche non salvate.'), h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost', onclick: () => { dirty = false; load(); } }, 'Annulla modifiche'),
    h('button', { class: 'btn primary', onclick: save }, 'Salva'));

  const testSend = async (text, event) => {
    if (dirty && !(await confirmDialog('Il messaggio verrà inviato davvero nella chat del canale (le modifiche non salvate restano solo in questa pagina). Continuare?', { okLabel: 'Invia in chat' }))) return;
    if (!dirty && !(await confirmDialog('Il messaggio verrà inviato davvero nella chat del canale. Continuare?', { okLabel: 'Invia in chat' }))) return;
    const r = await act(() => post('/api/admin/chat-messages/test', { text, event }));
    if (r) toast(`Inviato in chat come ${r.account}: ${r.message}`, 'ok');
    refreshLog();
  };

  const logBox = h('div');
  const refreshLog = async () => {
    try { const v = await get('/api/admin/chat-messages'); d.recent = v.recent; d.stats = v.stats; d.availability = v.availability; drawLog(); } catch { /* ignora */ }
  };
  const drawLog = () => mount(logBox,
    h('p', { class: 'muted small' }, `Inviati: ${d.stats.sent} · non inviati: ${d.stats.skipped} · errori: ${d.stats.failed}`,
      d.stats.lastError ? ` · ultimo errore: ${d.stats.lastError.message}` : ''),
    d.recent.length
      ? h('ol', { class: 'small', style: { margin: 0, paddingLeft: '18px', maxHeight: '220px', overflow: 'auto' } },
        d.recent.map((r) => h('li', {}, `${fmt.dt(r.at)} · ${label(r.event)}${r.test ? ' (prova)' : ''} · ${OUTCOME[r.outcome] || r.outcome}`,
          r.reason ? ` — ${r.reason}` : '', r.text ? h('div', { class: 'muted' }, r.text) : null)))
      : h('div', { class: 'muted small' }, 'Nessun messaggio da quando il servizio è partito.'));
  const label = (key) => d.events.find((e) => e.key === key)?.label || key;

  function messageRow(m, ev) {
    const vars = Object.fromEntries(ev.vars.map((k) => [k, d.sample[k] ?? '']));
    const preview = h('div', { class: 'small', style: { padding: '6px 10px', borderRadius: '8px', background: 'var(--panel2)' } });
    const count = h('span', { class: 'muted small' });
    const area = h('textarea', { rows: 2, maxlength: d.limits.textMax, style: { width: '100%', resize: 'vertical' }, oninput: (e) => { m.text = e.target.value; upd(); markDirty(); } }, m.text);
    const upd = () => {
      const out = render(m.text, vars);
      preview.textContent = out ? `Anteprima: ${out}` : 'Anteprima: (vuoto)';
      count.textContent = `${m.text.length}/${d.limits.textMax}`;
    };
    upd();
    const insert = (k) => {
      const t = `{${k}}`;
      const a = area.selectionStart ?? m.text.length;
      const b = area.selectionEnd ?? a;
      m.text = (m.text.slice(0, a) + t + m.text.slice(b)).slice(0, d.limits.textMax);
      area.value = m.text;
      area.focus();
      area.setSelectionRange(a + t.length, a + t.length);
      upd(); markDirty();
    };
    return h('div', { style: { border: '1px solid var(--line)', borderRadius: '10px', padding: '10px', marginTop: '8px', opacity: m.enabled ? 1 : 0.6 } },
      h('div', { class: 'row' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.enabled, onchange: (e) => { m.enabled = e.target.checked; markDirty(); draw(); } }), 'Attivo'),
        h('span', { class: 'spacer' }),
        count,
        h('button', { class: 'btn sm', title: 'Invia davvero questo messaggio in chat', onclick: () => testSend(m.text, ev.key) }, '▶ Prova in chat'),
        h('button', { class: 'btn sm', onclick: () => { const i = s.messages.indexOf(m); s.messages.splice(i + 1, 0, { ...m, id: newId() }); markDirty(); draw(); } }, 'Duplica'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog('Eliminare questo messaggio?', { danger: true, okLabel: 'Elimina' }))) return;
          s.messages.splice(s.messages.indexOf(m), 1); markDirty(); draw();
        } }, 'Elimina')),
      area,
      h('div', { class: 'row', style: { gap: '4px', flexWrap: 'wrap', margin: '4px 0' } },
        h('span', { class: 'muted small' }, 'Inserisci:'),
        ev.vars.map((k) => h('button', { class: 'btn sm ghost', title: d.variables[k], onclick: () => insert(k) }, `{${k}}`))),
      preview);
  }

  function eventCard(ev) {
    const cfg = s.events[ev.key];
    const list = s.messages.filter((m) => m.event === ev.key);
    const active = list.filter((m) => m.enabled);
    const fallback = ev.fallback ? label(ev.fallback) : null;
    const status = !cfg.enabled ? 'spento' : !active.length ? 'nessun messaggio attivo' : null;
    const set = (k, v) => { cfg[k] = v; markDirty(); draw(); };
    return h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '12px', marginTop: '12px' } },
      h('div', { class: 'row' },
        h('h3', { style: { margin: 0 } }, ev.label),
        status ? h('span', { class: 'pill' }, status + (fallback && cfg.enabled === false ? ` · si usa "${fallback}"` : '')) : h('span', { class: 'pill' }, '● attivo'),
        h('span', { class: 'spacer' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cfg.enabled, onchange: (e) => set('enabled', e.target.checked) }), 'Invia questo messaggio')),
      ev.hint ? h('p', { class: 'muted small', style: { margin: '4px 0' } }, ev.hint, fallback ? ` Se è spento o senza messaggi attivi si usa "${fallback}".` : '') : null,
      h('div', { class: 'grid c3', style: { marginTop: '6px' } },
        h('label', { class: 'field' }, 'Quale messaggio',
          h('select', { onchange: (e) => set('mode', e.target.value) },
            h('option', { value: 'fixed', selected: cfg.mode === 'fixed' }, 'Sempre lo stesso (fisso)'),
            h('option', { value: 'random', selected: cfg.mode === 'random' }, 'Casuale tra quelli attivi'))),
        cfg.mode === 'fixed'
          ? h('label', { class: 'field' }, 'Messaggio fisso',
            h('select', { onchange: (e) => set('fixedId', e.target.value || null) },
              h('option', { value: '' }, '— il primo attivo —'),
              active.map((m, i) => h('option', { value: m.id, selected: cfg.fixedId === m.id }, `${i + 1}. ${m.text.slice(0, 50)}`))))
          : h('div', { class: 'muted small', style: { alignSelf: 'center' } }, `Scelto a caso tra ${active.length} messaggi attivi, senza ripetere l'ultimo.`),
        h('label', { class: 'field' }, 'Intervallo minimo (secondi)',
          h('input', { type: 'number', min: 0, max: d.limits.cooldownMax, step: 1, value: cfg.cooldownS, oninput: (e) => { cfg.cooldownS = Number(e.target.value); markDirty(); } }),
          h('span', { class: 'small' }, 'tra due messaggi di questo tipo'))),
      list.map((m) => messageRow(m, ev)),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm', disabled: list.length >= d.limits.perEventMax, onclick: () => {
          s.messages.push({ id: newId(), event: ev.key, enabled: true, text: '' }); markDirty(); draw();
        } }, '+ Aggiungi messaggio')));
  }

  const draw = () => {
    const av = d.availability;
    const head = card('Messaggi automatici in chat',
      h('p', { class: 'muted' }, 'Il bot scrive in chat quando appare un Pokémon, quando qualcuno lo cattura e a inizio o fine sessione. ',
        'Usa il bot già collegato nella sezione Twitch: nessun altro accesso richiesto. Nessun messaggio per tentativi falliti, duplicati, riscatti annullati o modalità DEMO.'),
      h('div', { class: av.ok ? 'notice ok' : 'notice warn', style: { margin: '8px 0' } },
        av.ok ? `● Pronto: i messaggi partono con l'account ${av.role === 'bot' ? 'del bot' : 'del canale'} "${av.account}".`
          : `○ In questo momento i messaggi non partono: ${av.message}. Non vengono conservati per dopo.`),
      h('div', { class: 'grid c2' },
        h('div', {},
          h('label', { class: 'check', style: { fontWeight: 700 } }, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => { s.enabled = e.target.checked; markDirty(); draw(); } }), 'Messaggi automatici attivi'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.events.spawn.enabled, onchange: (e) => { s.events.spawn.enabled = e.target.checked; markDirty(); draw(); } }), 'Messaggio allo spawn'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.events.capture.enabled, onchange: (e) => { s.events.capture.enabled = e.target.checked; markDirty(); draw(); } }), 'Messaggio alla cattura riuscita'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.allowChannelAccount, onchange: (e) => { s.allowChannelAccount = e.target.checked; markDirty(); } }),
            'Senza bot collegato, usa l\'account del canale', h('span', { class: 'muted small' }, ' — con un bot collegato si usa sempre il bot'))),
        h('div', { class: 'form' },
          field(`Massimo messaggi automatici al minuto (1–${d.limits.perMinuteMax})`, s, 'maxPerMinute', { min: 1, max: d.limits.perMinuteMax, step: 1, help: 'oltre il limite i messaggi vengono saltati, non accodati' }))),
      h('div', { class: 'row end', style: { marginTop: '8px' } },
        h('button', { class: 'btn', onclick: () => load() }, '↻ Aggiorna'),
        h('button', { class: 'btn primary', onclick: save }, 'Salva')));
    // field() aggiorna l'oggetto senza segnalare la modifica: la segnaliamo qui.
    head.addEventListener('input', markDirty);

    const groups = GROUPS.map(([g, title]) => card(title, d.events.filter((e) => e.group === g && e.available).map(eventCard)));
    const future = d.events.filter((e) => !e.available);
    const futureCard = card('Altri eventi',
      h('p', { class: 'muted small' }, 'Questi eventi non esistono ancora nel gioco: compariranno qui quando il motore li supporterà.'),
      h('ul', {}, future.map((e) => h('li', {}, h('b', {}, e.label), ' ', h('span', { class: 'pill' }, 'non disponibile'), ' ', h('span', { class: 'muted small' }, e.reason || '')))));
    const vars = card('Variabili',
      h('p', { class: 'muted small' }, 'Scrivile tra graffe, es. {pokemon}. Le sostituisce il server con dati del gioco: il nome di chi cattura viene dal suo account Twitch, non da ciò che scrive in chat. Il testo resta testo semplice (niente HTML o comandi).'),
      h('ul', { class: 'small' }, Object.entries(d.variables).map(([k, v]) => h('li', {}, h('code', {}, `{${k}}`), ` — ${v}`))));
    const logCard = card('Ultimi messaggi', logBox);
    drawLog();
    mount(el, saveBar, head, ...groups, futureCard, vars, logCard);
    if (dirty) saveBar.classList.remove('hidden');
  };

  const load = async (view) => {
    d = view || await get('/api/admin/chat-messages');
    s = JSON.parse(JSON.stringify(d.settings));
    saveBar.classList.add('hidden');
    draw();
  };
  await load();
}
