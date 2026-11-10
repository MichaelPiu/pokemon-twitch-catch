// Modifica manuale del Pokédex: ricerca dell'allenatore, elenco delle specie con
// filtri, correzione dei record con anteprima delle modifiche, registrazione
// manuale, rimozione con conferma e storico delle modifiche.
import { h, mount, get, post, patch, fmt, rarityBadge, debounce } from '../../lib.js';
import { card, table, act, confirmDialog, modal, toast, pager } from '../ui.js';
import { onLive } from '../main.js';

const ORIGIN_LABEL = { twitch: 'Twitch', manual: 'Manuale', admin: 'Admin', import: 'Importato', demo: 'DEMO' };
const FIELD_LABEL = { pokemon_id: 'Forma / variante', is_shiny: 'Shiny', ball_name: 'Poké Ball', caught_at: 'Data di cattura', note: 'Nota' };
const STATUS = [['all', 'Tutti'], ['caught', 'Catturati'], ['seen', 'Visti, non catturati'], ['missing', 'Mai visti'], ['shiny', 'Con shiny'],
  ['twitch', 'Catture Twitch'], ['manual', 'Catture manuali'], ['admin', 'Registrazioni admin'], ['corrected', 'Corretti a mano']];

const originBadge = (o) => h('span', { class: `origin-badge ${o}` }, ORIGIN_LABEL[o] || o);
const toLocalInput = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export async function pokedex({ el, params }) {
  const st = { user: null, q: '', status: 'all', offset: 0, trainerQ: '' };
  const userBox = h('div');
  const listBox = h('div');

  async function pickTrainer() {
    const res = await get(`/api/admin/users?q=${encodeURIComponent(st.trainerQ)}&limit=20`);
    mount(userBox, res.items.length ? h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, res.items.map((u) =>
      h('button', { class: `btn sm ${st.user?.id === u.id ? 'on' : ''}`, onclick: () => { st.user = { id: u.id }; st.offset = 0; location.hash = `#/pokedex/${u.id}`; loadList(); pickTrainer(); } },
        u.display_name, u.origin === 'local' ? ' (locale)' : '', ` · ${u.species} specie`))) : h('div', { class: 'empty' }, 'Nessun allenatore trovato'));
  }

  async function loadList() {
    if (!st.user) { mount(listBox, h('div', { class: 'empty' }, 'Scegli un allenatore per vedere e modificare il suo Pokédex.')); return; }
    const d = await get(`/api/admin/pokedex?user=${st.user.id}&q=${encodeURIComponent(st.q)}&status=${st.status}&limit=100&offset=${st.offset}`);
    st.user = d.user;
    const s = d.summary;
    mount(listBox,
      h('div', { class: 'row', style: { marginBottom: '12px', flexWrap: 'wrap' } },
        h('strong', {}, d.user.displayName), d.user.origin === 'local' ? h('span', { class: 'origin-badge manual' }, 'giocatore locale') : null,
        h('span', { class: 'muted' }, `${s.species} specie · ${s.total} esemplari · ${s.shiny} shiny`),
        h('span', { class: 'spacer' }),
        originBadge('twitch'), h('span', { class: 'small' }, s.twitch), originBadge('manual'), h('span', { class: 'small' }, s.manual), originBadge('admin'), h('span', { class: 'small' }, s.admin)),
      table([
        { label: 'N.', render: (r) => fmt.dex(r.dex) },
        { label: '', render: (r) => h('img', { src: r.image, alt: '', width: 36, height: 36, loading: 'lazy', style: { imageRendering: 'pixelated' } }) },
        { label: 'Pokémon', render: (r) => h('span', {}, r.name, r.form ? h('span', { class: 'muted small' }, ` (${r.form})`) : null) },
        { label: 'Rarità', render: (r) => rarityBadge(r.rarity) },
        { label: 'Stato', render: (r) => (r.caught ? h('span', { style: { color: 'var(--ok)' } }, 'Catturato') : r.seen ? 'Visto' : h('span', { class: 'muted' }, '—')) },
        { label: 'Esemplari', render: (r) => (r.count ? `${r.count}${r.shiny ? ` (✨${r.shiny})` : ''}` : '—') },
        { label: 'Origine', render: (r) => h('span', { class: 'row', style: { gap: '4px' } },
          r.origins.twitch ? originBadge('twitch') : null, r.origins.manual ? originBadge('manual') : null, r.origins.admin ? originBadge('admin') : null,
          r.corrected ? h('span', { class: 'small muted', title: 'Record corretti a mano' }, '✎') : null) },
      ], d.items, { onRow: (r) => openSpecies(r.pokemonId), empty: 'Nessun Pokémon con questi filtri' }),
      pager(d.total, 100, st.offset, (o) => { st.offset = o; loadList(); }));
  }

  async function openSpecies(pokemonId) {
    const d = await get(`/api/admin/pokedex/${st.user.id}/${pokemonId}`);
    const body = h('div');
    const m = modal(`${fmt.dex(d.pokemon.dex)} ${d.pokemon.name}`, body, { onClose: () => loadList() });
    const ballList = h('datalist', { id: 'pdx-balls' }, d.balls.map((b) => h('option', { value: b })));

    const entryForm = (e) => {
      const draft = { pokemonId: e.pokemonId, shiny: e.shiny, ball: e.ball || '', caughtAt: toLocalInput(e.caughtAt), note: e.note || '' };
      const out = h('div');
      const changes = () => {
        const c = {};
        if (draft.pokemonId !== e.pokemonId) c.pokemonId = draft.pokemonId;
        if (draft.shiny !== e.shiny) c.shiny = draft.shiny;
        if ((draft.ball || '') !== (e.ball || '')) c.ball = draft.ball;
        if (draft.caughtAt !== toLocalInput(e.caughtAt)) c.caughtAt = new Date(draft.caughtAt).toISOString();
        if ((draft.note || '') !== (e.note || '')) c.note = draft.note;
        return c;
      };
      const inputs = {
        variant: h('select', { onchange: (ev) => { draft.pokemonId = Number(ev.target.value); } }, d.variants.map((v) => h('option', { value: v.id, selected: v.id === e.pokemonId }, `${v.name}${v.form ? ` (${v.form})` : ''}`))),
        shiny: h('input', { type: 'checkbox', checked: e.shiny, disabled: !d.pokemon.shinyEnabled && !e.shiny, onchange: (ev) => { draft.shiny = ev.target.checked; } }),
        ball: h('input', { value: draft.ball, list: 'pdx-balls', maxlength: 40, oninput: (ev) => { draft.ball = ev.target.value; } }),
        caughtAt: h('input', { type: 'datetime-local', value: draft.caughtAt, oninput: (ev) => { draft.caughtAt = ev.target.value; } }),
        note: h('textarea', { rows: 2, maxlength: 500, oninput: (ev) => { draft.note = ev.target.value; } }, e.note || ''),
      };
      const reset = () => {
        Object.assign(draft, { pokemonId: e.pokemonId, shiny: e.shiny, ball: e.ball || '', caughtAt: toLocalInput(e.caughtAt), note: e.note || '' });
        inputs.variant.value = String(e.pokemonId); inputs.shiny.checked = e.shiny; inputs.ball.value = draft.ball; inputs.caughtAt.value = draft.caughtAt; inputs.note.value = draft.note;
        mount(out);
      };
      return h('div', { class: 'card', style: { background: 'var(--panel2)', marginBottom: '10px' } },
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          h('strong', {}, `Registrazione #${e.id}`), originBadge(e.origin),
          e.sessionKind ? h('span', { class: 'small muted' }, `sessione ${e.sessionKind === 'manual' ? 'manuale' : 'Twitch'} #${e.sessionId}`) : null,
          e.corrected ? h('span', { class: 'small muted' }, `corretto da ${e.updatedBy || 'admin'} il ${fmt.dt(e.updatedAt)}`) : null),
        h('div', { class: 'grid c2', style: { marginTop: '8px' } },
          h('label', { class: 'field' }, 'Forma / variante', inputs.variant),
          h('label', { class: 'field' }, 'Poké Ball', inputs.ball),
          h('label', { class: 'field' }, 'Data di cattura', inputs.caughtAt),
          h('label', { class: 'check' }, inputs.shiny, ' Shiny')),
        h('label', { class: 'field' }, 'Nota personale', inputs.note),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn primary sm', onclick: async () => {
            const c = changes();
            if (!Object.keys(c).length) { toast('Nessuna modifica da salvare'); return; }
            const pv = await act(() => patch(`/api/admin/pokedex/entries/${e.id}`, { rev: e.rev, changes: c, dryRun: true }));
            if (!pv) return;
            const variantName = (id) => { const v = d.variants.find((x) => x.id === id); return v ? `${v.name}${v.form ? ` (${v.form})` : ''}` : id; };
            const show = (f, val) => (f === 'pokemon_id' ? variantName(val) : f === 'is_shiny' ? (val ? 'sì' : 'no') : f === 'caught_at' ? fmt.dt(val) : (val ?? '—'));
            mount(out, h('div', { class: 'notice', style: { marginTop: '8px' } },
              h('strong', {}, 'Stai per modificare:'),
              h('table', { class: 'diff-table', style: { marginTop: '6px' } }, pv.diff.map((x) => h('tr', {}, h('td', {}, FIELD_LABEL[x.field] || x.field), h('td', { class: 'from' }, show(x.field, x.from)), h('td', {}, '→'), h('td', { class: 'to' }, show(x.field, x.to))))),
              h('p', { class: 'small muted' }, 'Lo storico dei lanci e delle sessioni non cambia; la modifica viene registrata con il tuo nome.'),
              h('div', { class: 'row' },
                h('button', { class: 'btn primary sm', onclick: async () => {
                  const r = await act(() => patch(`/api/admin/pokedex/entries/${e.id}`, { rev: e.rev, changes: c }), 'Modifica salvata');
                  if (r) { m.close(); openSpecies(pokemonId); }
                } }, 'Conferma e salva'),
                h('button', { class: 'btn ghost sm', onclick: () => mount(out) }, 'Indietro'))));
          } }, 'Salva modifiche…'),
          h('button', { class: 'btn ghost sm', onclick: reset }, 'Annulla modifiche'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn danger sm', onclick: async () => {
            if (!await confirmDialog(`Rimuovere la registrazione #${e.id} (${originBadge(e.origin).textContent}, ${fmt.dt(e.caughtAt)})? L'esemplare esce dal Pokédex; lo storico dei lanci resta.`, { danger: true, okLabel: 'Rimuovi' })) return;
            const r = await act(() => post(`/api/admin/pokedex/entries/${e.id}/delete`, { rev: e.rev, confirm: true }), 'Registrazione rimossa');
            if (r) { m.close(); openSpecies(pokemonId); }
          } }, 'Rimuovi')),
        out);
    };

    const reg = { pokemonId: d.pokemon.id, shiny: false, ball: '', caughtAt: toLocalInput(new Date().toISOString()), note: '', additional: false };
    const regOut = h('div');
    const hasEntries = d.entries.length > 0;
    mount(body, ballList,
      h('p', { class: 'muted small' }, `${d.entries.length} esemplari · visto in ${d.seen} lanci`),
      d.entries.map(entryForm),
      h('div', { class: 'card', style: { background: 'var(--panel2)' } },
        h('h3', { style: { marginTop: 0 } }, hasEntries ? 'Aggiungi un altro esemplare' : 'Registra manualmente'),
        hasEntries ? h('p', { class: 'small muted' }, 'La specie è già registrata: un nuovo esemplare è un doppione e va confermato esplicitamente.') : null,
        h('div', { class: 'grid c2' },
          h('label', { class: 'field' }, 'Forma / variante', h('select', { onchange: (ev) => { reg.pokemonId = Number(ev.target.value); } }, d.variants.map((v) => h('option', { value: v.id, selected: v.id === d.pokemon.id }, `${v.name}${v.form ? ` (${v.form})` : ''}`)))),
          h('label', { class: 'field' }, 'Poké Ball', h('input', { list: 'pdx-balls', maxlength: 40, placeholder: 'Registrato da admin', oninput: (ev) => { reg.ball = ev.target.value; } })),
          h('label', { class: 'field' }, 'Data di cattura', h('input', { type: 'datetime-local', value: reg.caughtAt, oninput: (ev) => { reg.caughtAt = ev.target.value; } })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', disabled: !d.pokemon.shinyEnabled, onchange: (ev) => { reg.shiny = ev.target.checked; } }), ' Shiny')),
        h('label', { class: 'field' }, 'Nota', h('textarea', { rows: 2, maxlength: 500, oninput: (ev) => { reg.note = ev.target.value; } })),
        hasEntries ? h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (ev) => { reg.additional = ev.target.checked; } }), ' Confermo: aggiungi un doppione') : null,
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn accent sm', onclick: async () => {
            const payload = { pokemonId: reg.pokemonId, shiny: reg.shiny, ball: reg.ball || undefined, caughtAt: new Date(reg.caughtAt).toISOString(), note: reg.note || undefined, additional: reg.additional };
            const pv = await act(() => post(`/api/admin/pokedex/${st.user.id}/entries`, { ...payload, dryRun: true }));
            if (!pv) return;
            const c = pv.create;
            mount(regOut, h('div', { class: 'notice', style: { marginTop: '8px' } },
              h('strong', {}, 'Stai per registrare: '), `${c.pokemon}${c.form ? ` (${c.form})` : ''}${c.shiny ? ' ✨' : ''}, ${c.ball}, ${fmt.dt(c.caughtAt)}${c.note ? `, nota: “${c.note}”` : ''}.`,
              h('p', { class: 'small muted' }, 'La registrazione sarà marcata come inserita dall\'amministratore (origine Admin).'),
              h('div', { class: 'row' },
                h('button', { class: 'btn primary sm', onclick: async () => {
                  const r = await act(() => post(`/api/admin/pokedex/${st.user.id}/entries`, payload), 'Registrazione salvata');
                  if (r) { m.close(); openSpecies(pokemonId); }
                } }, 'Conferma'),
                h('button', { class: 'btn ghost sm', onclick: () => mount(regOut) }, 'Annulla'))));
          } }, hasEntries ? 'Aggiungi doppione…' : 'Registra…')),
        regOut),
      d.history.length ? h('div', { style: { marginTop: '12px' } }, h('h3', {}, 'Storico modifiche'),
        h('ul', { class: 'small muted', style: { paddingLeft: '18px' } }, d.history.map((a) => h('li', {}, `${fmt.dt(a.created_at)} · ${a.admin || '—'} · ${{ pokedex_edit: 'modifica', pokedex_register: 'registrazione', pokedex_remove: 'rimozione' }[a.action] || a.action} #${a.target_id}`)))) : null);
  }

  const trainerInput = h('input', { placeholder: 'Cerca allenatore per nome…', oninput: debounce((ev) => { st.trainerQ = ev.target.value; pickTrainer(); }, 250) });
  const searchInput = h('input', { placeholder: 'Nome o numero (es. pikachu, 25, #150)', oninput: debounce((ev) => { st.q = ev.target.value.trim(); st.offset = 0; loadList(); }, 250) });
  mount(el,
    card('Allenatore', trainerInput, h('div', { style: { marginTop: '10px' } }, userBox)),
    card('Pokédex',
      h('div', { class: 'row', style: { marginBottom: '12px', flexWrap: 'wrap' } }, searchInput,
        h('select', { onchange: (ev) => { st.status = ev.target.value; st.offset = 0; loadList(); } }, STATUS.map(([k, l]) => h('option', { value: k }, l)))),
      listBox,
      h('p', { class: 'small muted' }, 'Le modifiche cambiano la collezione (Pokédex, classifiche, !pokedex) ma non lo storico dei lanci e delle sessioni. Le registrazioni manuali sono marcate Admin; ogni modifica è registrata con data e autore.')));
  if (params?.[0] && /^\d+$/.test(params[0])) st.user = { id: Number(params[0]) };
  await pickTrainer();
  await loadList();
  const off = onLive((type, data) => { if (type === 'pokedex' && st.user && data?.userId === st.user.id) loadList().catch(() => {}); });
  return off;
}
