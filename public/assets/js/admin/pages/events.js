// Eventi automatici: Evento Leggendario, Bonus Shiny, Pokémon del giorno ed
// Evento Community. Tutto spento finché l'amministratore non lo attiva; i bonus
// sono temporanei e valgono solo per la scelta dei Pokémon che appaiono (mai per
// la probabilità di cattura). Gli annunci passano dai Messaggi Twitch.
import { h, mount, get, post, put, fmt } from '../../lib.js';
import { card, act, toast, confirmDialog, table } from '../ui.js';
import { onLive } from '../main.js';

const DAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Gio'], [5, 'Ven'], [6, 'Sab'], [0, 'Dom']];
const REASON = {
  completed: 'durata terminata', admin: 'fermato dall\'amministratore', twitch_offline: 'Twitch offline / diretta finita', disabled: 'eventi disattivati',
  session_end: 'fine della sessione', manual_not_allowed: 'sessione manuale non abilitata', demo: 'modalità DEMO',
};
const GAME = { live: 'diretta Twitch', manual: 'sessione manuale', demo: 'DEMO' };

export async function events({ el }) {
  let d;
  let s;
  let dirty = false;
  const markDirty = () => { dirty = true; saveBar.classList.remove('hidden'); };
  const save = async () => {
    const r = await act(() => put('/api/admin/events', s), 'Eventi salvati');
    if (r) { dirty = false; load(); }
  };
  const saveBar = h('div', { class: 'notice warn hidden row', style: { position: 'fixed', bottom: '16px', right: '24px', zIndex: 50, gap: '10px', background: 'var(--panel)', boxShadow: '0 8px 24px rgba(0,0,0,.45)' } },
    h('span', {}, 'Modifiche non salvate.'), h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost', onclick: () => { dirty = false; load(); } }, 'Annulla modifiche'),
    h('button', { class: 'btn primary', onclick: save }, 'Salva'));

  const check = (obj, key, label, help) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; markDirty(); draw(); } }), label,
    help ? h('span', { class: 'muted small' }, ` — ${help}`) : null);
  const num = (obj, key, label, [min, max], { step = 1, help } = {}) => h('label', { class: 'field' }, label,
    h('input', { type: 'number', min, max, step, value: obj[key], oninput: (e) => { obj[key] = Number(e.target.value); markDirty(); } }),
    help ? h('span', { class: 'small' }, help) : null);
  const select = (obj, key, label, options) => h('label', { class: 'field' }, label,
    h('select', { onchange: (e) => { obj[key] = e.target.value; markDirty(); draw(); } }, options.map(([v, l]) => h('option', { value: v, selected: String(obj[key]) === String(v) }, l))));
  const schedule = (sc) => h('div', {},
    h('div', { class: 'small', style: { marginBottom: '4px' } }, 'Giorni e orari in cui può partire da solo'),
    h('div', { class: 'row', style: { gap: '4px', flexWrap: 'wrap' } }, DAYS.map(([v, l]) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: sc.days.includes(v), onchange: (e) => { sc.days = e.target.checked ? [...sc.days, v] : sc.days.filter((x) => x !== v); markDirty(); } }), l))),
    h('div', { class: 'grid c2' },
      h('label', { class: 'field' }, 'Dalle', h('input', { type: 'time', value: sc.from, oninput: (e) => { sc.from = e.target.value; markDirty(); } })),
      h('label', { class: 'field' }, 'Alle', h('input', { type: 'time', value: sc.to, oninput: (e) => { sc.to = e.target.value; markDirty(); } }))));
  const L = () => d.limits;

  const startBtn = (type, label) => {
    const dur = h('input', { type: 'number', min: L().durationMin[0], max: L().durationMin[1], value: s[type].durationMin, style: { width: '80px' } });
    return h('div', { class: 'row', style: { gap: '6px' } },
      h('button', { class: 'btn primary', disabled: !!d.active || !d.game.allowed || !d.settings.enabled || !d.settings[type].enabled, onclick: async () => {
        if (!(await confirmDialog(`Avviare ${label} per ${dur.value} minuti? Il bonus vale solo per i Pokémon che appaiono e termina da solo.`, { okLabel: 'Avvia' }))) return;
        const r = await act(() => post('/api/admin/events/start', { type, durationMin: Number(dur.value) }), `${label} avviato`);
        if (r) load();
      } }, `▶ Avvia ${label}`), dur, h('span', { class: 'muted small' }, 'minuti'));
  };

  const pokemonPicker = () => {
    const out = h('div', { class: 'small' });
    const input = h('input', { placeholder: 'Cerca un Pokémon per nome o numero', oninput: async (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) { mount(out); return; }
      const r = await get(`/api/admin/pokemon?q=${encodeURIComponent(q)}&limit=8&enabled=1`).catch(() => ({ items: [] }));
      mount(out, r.items.map((p) => h('button', { class: 'btn sm', style: { margin: '2px' }, onclick: () => { s.pokemonOfDay.pokemonId = p.id; s.pokemonOfDay.pokemonName = p.name_it || p.name; markDirty(); draw(); } }, `${fmt.dex(p.dex_number)} ${p.name_it || p.name}`)));
    } });
    return h('div', {}, input, out);
  };

  const draw = () => {
    const a = d.active;
    const head = card('Eventi automatici',
      h('p', { class: 'muted' }, 'Eventi durante le dirette (e, se vuoi, nelle sessioni manuali). Tutto è spento finché non lo attivi. ',
        'I bonus sono temporanei: cambiano solo la scelta dei Pokémon che appaiono (rarità e shiny), mai la probabilità di cattura, e smettono di valere appena l\'evento finisce. ',
        'Un solo evento con bonus alla volta.'),
      h('div', { class: d.game.allowed ? 'notice ok' : 'notice warn', style: { margin: '8px 0' } },
        d.game.allowed ? `● Gioco attivo (${GAME[d.game.mode] || d.game.mode}): gli eventi possono partire.`
          : `○ Gli eventi non partono adesso: ${d.game.mode ? `${GAME[d.game.mode]}${d.game.mode === 'manual' ? ' (abilita "sessioni manuali")' : ''}` : 'nessuna diretta o sessione in corso'}.`),
      h('div', { class: 'grid c2' },
        h('div', {},
          h('label', { class: 'check', style: { fontWeight: 700 } }, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => { s.enabled = e.target.checked; markDirty(); draw(); } }), 'Eventi automatici attivi'),
          check(s, 'manualMode', 'Anche nelle sessioni manuali', 'senza Twitch, avviate dalla dashboard')),
        select(s, 'offlineRule', 'Se Twitch va offline o il gioco si ferma', [['end', 'Termina l\'evento'], ['pause', 'Sospendi e riprendi dopo (tempo rimanente conservato)']])),
      h('p', { class: 'muted small' }, 'In entrambi i casi nessun bonus resta attivo mentre il gioco è fermo, e al ritorno non vengono inviati annunci arretrati.'));

    const status = card('Stato',
      a ? h('div', { class: a.paused ? 'notice warn' : 'notice ok' },
        h('b', {}, `${a.type === 'legendary' ? '🌟' : '✨'} ${a.label}`), ` · ${a.bonusText} · `,
        a.paused ? `sospeso (restano ${fmt.dur(a.remainingS)})` : `termina alle ${fmt.time(a.endsAt)} (tra ${fmt.dur(a.remainingS)})`,
        ` · avviato da ${a.by === 'auto' ? 'programmazione' : a.by === 'community' ? 'obiettivo community' : a.by.replace('admin:', '')}`,
        h('div', { class: 'row end', style: { marginTop: '6px' } }, h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmDialog('Terminare subito l\'evento? Il bonus smette di valere immediatamente.', { danger: true, okLabel: 'Termina' }))) return;
          const r = await act(() => post('/api/admin/events/stop', {}), 'Evento terminato');
          if (r) load();
        } }, '■ Termina evento')))
        : h('p', { class: 'muted' }, 'Nessun evento con bonus attivo.'),
      h('div', { class: 'row', style: { gap: '16px', flexWrap: 'wrap', marginTop: '8px' } }, startBtn('legendary', 'Evento Leggendario'), startBtn('shiny', 'Bonus Shiny')),
      dirty ? h('p', { class: 'muted small' }, 'Salva le modifiche prima di avviare un evento.') : null);

    const g = s.legendary;
    const legendary = card('🌟 Evento Leggendario',
      check(g, 'enabled', 'Attivo', 'parte da solo secondo la regola qui sotto (o a mano)'),
      h('div', { class: 'grid c3' },
        select(g, 'trigger', 'Parte', [['time', 'dopo un intervallo di tempo'], ['captures', 'dopo un numero di catture']]),
        g.trigger === 'time' ? num(g, 'everyMinutes', 'Ogni quanti minuti di gioco', L().everyMinutes) : num(g, 'everyCaptures', 'Ogni quante catture', L().everyCaptures),
        num(g, 'durationMin', 'Durata (minuti)', L().durationMin)),
      num(g, 'legendaryBoost', 'Leggendari e Mitici più frequenti: moltiplicatore', L().legendaryBoost, { step: 0.5, help: 'es. 3 = peso della rarità Leggendario e Mitico ×3 durante l\'evento' }),
      schedule(g.schedule));

    const sh = s.shiny;
    const shiny = card('✨ Bonus Shiny',
      check(sh, 'enabled', 'Attivo'),
      check(sh, 'auto', 'Avvio programmato', 'altrimenti solo con il pulsante "Avvia"'),
      h('div', { class: 'grid c3' },
        num(sh, 'everyMinutes', 'Ogni quanti minuti di gioco', L().everyMinutes),
        num(sh, 'durationMin', 'Durata (minuti)', L().durationMin),
        num(sh, 'shinyMultiplier', 'Probabilità shiny: moltiplicatore', L().shinyMultiplier, { step: 0.5 })),
      schedule(sh.schedule));

    const pd = s.pokemonOfDay;
    const potd = card('📅 Pokémon del giorno',
      check(pd, 'enabled', 'Attivo', 'evidenziato nell\'overlay; chi lo cattura viene annunciato'),
      check(pd, 'announce', 'Annuncio in chat a inizio giornata'),
      select(pd, 'mode', 'Scelta', [['auto', 'Automatica (stessa data → stesso Pokémon, tra quelli abilitati)'], ['fixed', 'Scelgo io']]),
      pd.mode === 'fixed' ? h('div', {}, h('p', { class: 'small' }, `Scelto: ${pd.pokemonName || (pd.pokemonId ? `#${pd.pokemonId}` : 'nessuno')}`), pokemonPicker()) : null,
      d.pokemonOfDay ? h('p', {}, h('img', { src: d.pokemonOfDay.image, alt: '', style: { width: '48px', verticalAlign: 'middle' } }), ` Oggi: ${d.pokemonOfDay.name} (${d.pokemonOfDay.rarityLabel}) · catturato da ${d.pokemonOfDay.catchersCount} allenatori`)
        : h('p', { class: 'muted small' }, 'Il Pokémon di oggi viene scelto alla prima sessione con gli eventi attivi.'));

    const cm = s.community;
    const c = d.community;
    const community = card('🤝 Evento Community',
      check(cm, 'enabled', 'Attivo', 'obiettivo condiviso: catture di tutta la community'),
      h('div', { class: 'grid c2' },
        num(cm, 'goal', 'Obiettivo (catture)', L().goal),
        select(cm, 'unlock', 'Al completamento avvia anche', [['none', 'Solo annuncio e premio grafico'], ['legendary', 'un Evento Leggendario'], ['shiny', 'un Bonus Shiny']])),
      h('label', { class: 'field' }, 'Premio (testo per chat e overlay)', h('input', { maxlength: L().rewardMax, value: cm.reward, oninput: (e) => { cm.reward = e.target.value; markDirty(); } })),
      check(cm, 'autoRestart', 'Al completamento parte subito un nuovo obiettivo'),
      c?.active ? h('div', { style: { marginTop: '8px' } },
        h('div', {}, `${c.completedAt ? '✅ Raggiunto' : 'In corso'}: ${fmt.n(c.progress)} / ${fmt.n(c.goal)} catture (${c.pct}%) · dal ${fmt.dt(c.startedAt)}`),
        h('div', { style: { height: '10px', borderRadius: '6px', background: 'var(--panel2)', overflow: 'hidden', margin: '6px 0' } },
          h('div', { style: { width: `${c.pct}%`, height: '100%', background: 'var(--primary)' } })))
        : h('p', { class: 'muted small' }, 'Nessun obiettivo in corso.'),
      h('button', { class: 'btn', disabled: !d.settings.enabled || !d.settings.community.enabled, onclick: async () => {
        if (!(await confirmDialog(`Avviare un nuovo obiettivo di ${cm.goal} catture? Il conteggio riparte da zero.`, { okLabel: 'Nuovo obiettivo' }))) return;
        const r = await act(() => post('/api/admin/events/community/new', { goal: cm.goal }), 'Nuovo obiettivo avviato');
        if (r) load();
      } }, '↻ Nuovo obiettivo'));

    const ann = card('Annunci in chat',
      h('p', { class: 'muted small' }, 'Gli annunci sono messaggi della sezione Messaggi Twitch (testi, intervalli e antispam si modificano lì). ',
        d.chat.enabled ? (d.chat.availability.ok ? 'Messaggi Twitch attivi.' : `Messaggi Twitch attivi ma ora non partono: ${d.chat.availability.message}.`) : 'Messaggi Twitch spenti: gli annunci non partono.'),
      h('ul', { class: 'small' }, d.announcements.map((x) => h('li', {}, h('b', {}, x.label), x.enabled ? '' : ' (spento)', h('div', { class: 'muted' }, x.preview || '—')))),
      h('a', { href: '#/messages', class: 'btn sm' }, 'Modifica gli annunci'));

    const hist = card('Storico degli eventi', table([
      { label: 'Evento', render: (e) => e.label },
      { label: 'Inizio', render: (e) => fmt.dt(e.startedAt) },
      { label: 'Fine', render: (e) => (e.endedAt ? fmt.dt(e.endedAt) : '—') },
      { label: 'Da', render: (e) => (e.by === 'auto' ? 'automatico' : e.by === 'community' ? 'community' : (e.by || '').replace('admin:', '')) },
      { label: 'Esito', render: (e) => (e.type === 'pokemon_of_day' ? e.pokemon : e.type === 'community' ? `${e.goal} catture · ${e.reward || ''}` : REASON[e.reason] || e.reason || '—') },
      { label: 'Risultato', render: (e) => (e.result ? `${e.result.captures} catture${e.result.spawns != null ? ` · ${e.result.legendarySpawns} leggendari e ${e.result.shinySpawns} shiny apparsi` : ''}` : '—') },
    ], d.history, { empty: 'Nessun evento ancora' }));

    mount(el, saveBar, head, status, h('div', { class: 'grid c2' }, legendary, shiny), h('div', { class: 'grid c2' }, potd, community), ann, hist);
    if (dirty) saveBar.classList.remove('hidden');
  };

  const load = async () => {
    d = await get('/api/admin/events');
    s = JSON.parse(JSON.stringify(d.settings));
    saveBar.classList.add('hidden');
    draw();
  };
  await load();
  let t = null;
  const off = onLive((type) => {
    if (type !== 'events' || dirty) return;
    clearTimeout(t);
    t = setTimeout(() => load().catch(() => {}), 400);
  });
  return () => { off(); clearTimeout(t); };
}
