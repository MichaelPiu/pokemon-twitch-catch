import { h, mount, get, post, put, fmt, rarityBadge, RARITY, RARITY_KEYS, TYPE_IT } from '../../lib.js';
import { card, table, act, field } from '../ui.js';
import { onLive } from '../main.js';
import { spawnBox, SPAWN_STATUS, monCell } from './common.js';

export async function spawn({ el }) {
  const [d, g] = await Promise.all([get('/api/admin/spawn'), get('/api/admin/settings/game')]);
  const s = { ...d.settings, gens: (d.settings.allowedGenerations || []).join(',') };
  const live = h('div');
  const renderLive = (data) => {
    const e = data.engine;
    mount(live,
      spawnBox(data.active),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn primary', disabled: !e.running || !!data.active, onclick: () => manual() }, '✨ Genera Pokémon casuale'),
        h('button', { class: 'btn', disabled: !e.running || !!data.active, onclick: () => manual(true) }, '✨ Genera shiny'),
        h('button', { class: 'btn danger', disabled: !data.active, onclick: async () => { await act(() => post('/api/admin/spawn/cancel'), 'Spawn terminato'); refresh(); } }, '⏹ Termina spawn'),
        h('span', { class: 'muted small' }, e.running
          ? (e.nextSpawnAt ? `Prossimo spawn automatico ~ ${fmt.time(e.nextSpawnAt)}` : '')
          : 'Motore fermo: la generazione manuale è disponibile solo durante la diretta o in modalità DEMO.')));
  };
  const manual = async (shiny) => { await act(() => post('/api/admin/spawn/manual', shiny ? { shiny: true } : {}), 'Pokémon generato'); refresh(); };
  const refresh = async () => { const x = await get('/api/admin/spawn'); renderLive(x); renderHistory(x.history); };

  const hist = h('div');
  const renderHistory = (rows) => mount(hist, table([
    { label: 'Sessione', key: 'session_id' },
    { label: 'Ora', render: (r) => fmt.dt(r.started_at) },
    { label: 'Pokémon', render: (r) => monCell(r.name, r.dex, r.is_shiny) },
    { label: 'Rarità', render: (r) => rarityBadge(r.rarity) },
    { label: 'Esito', render: (r) => SPAWN_STATUS[r.status] || r.status },
    { label: 'Tentativi', key: 'attempts' },
    { label: 'Catturato da', render: (r) => r.caught_by || '—' },
    { label: 'Origine', render: (r) => r.source + (r.is_demo ? ' (demo)' : '') },
  ], rows, { empty: 'Nessuno spawn registrato' }));

  const saveSpawn = async () => {
    const body = { ...s, allowedGenerations: s.gens.split(',').map((x) => x.trim()).filter(Boolean).map(Number) };
    delete body.gens;
    await act(() => put('/api/admin/spawn/settings', body), 'Impostazioni spawn salvate');
  };
  const saveGame = (keys) => act(() => put('/api/admin/settings/game', Object.fromEntries(keys.map((k) => [k, g[k]]))), 'Impostazioni salvate');

  const ev = g.event;
  ev.typesStr = (ev.types || []).join(',');

  mount(el,
    card('Pokémon in campo', live),
    card('Impostazioni spawn', h('div', { class: 'form' },
      field('Spawn automatici attivi', s, 'enabled', { type: 'checkbox' }),
      field('Intervallo minimo (secondi)', s, 'minIntervalS', { min: 10 }),
      field('Intervallo massimo (secondi)', s, 'maxIntervalS', { min: 10 }),
      field('Durata spawn (secondi)', s, 'durationS', { min: 10 }),
      field('Probabilità di spawn (0–1)', s, 'spawnChance', { step: 0.05, min: 0, max: 1, help: 'A ogni intervallo, probabilità che appaia davvero un Pokémon' }),
      field('Ritardo primo spawn (s)', s, 'firstSpawnDelayS', { min: 0 }),
      field('Tentativi massimi per spawn', s, 'maxAttemptsPerSpawn', { min: 0, help: '0 = illimitati; al limite il Pokémon fugge' }),
      field('Tentativi massimi per utente', s, 'maxAttemptsPerUser', { min: 0, help: '0 = illimitati' }),
      field('Tolleranza eventi in ritardo (s)', s, 'lateGraceS', { min: 0 }),
      field('Generazioni consentite', s, 'gens', { type: 'text', help: 'es. 1,2,3 — vuoto = tutte' })),
      h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: saveSpawn }, 'Salva'))),
    h('div', { class: 'grid c2', style: { marginTop: '16px' } },
      card('Probabilità di apparizione per rarità', h('p', { class: 'muted small' }, 'Pesi relativi: più alto = più frequente.'),
        h('div', { class: 'form' }, RARITY_KEYS.map((r) => field(RARITY[r].label, g.rarityWeights, r, { min: 0 }))),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => saveGame(['rarityWeights']) }, 'Salva'))),
      card('Probabilità base di cattura per rarità', h('p', { class: 'muted small' }, 'Valore 0–1, moltiplicato per Poké Ball e difficoltà del Pokémon.'),
        h('div', { class: 'form' }, RARITY_KEYS.map((r) => field(RARITY[r].label, g.rarityCatchBase, r, { step: 0.01, min: 0, max: 1 }))),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => saveGame(['rarityCatchBase']) }, 'Salva')))),
    h('div', { class: 'grid c2', style: { marginTop: '16px' } },
      card('Cattura', h('div', { class: 'form' },
        field('Modalità', g.capture, 'mode', { type: 'select', options: [['single', 'Un solo vincitore'], ['multi', 'Cattura multipla']] }),
        field('Modificatore globale', g.capture, 'globalModifier', { step: 0.05 }),
        field('Probabilità minima', g.capture, 'minChance', { step: 0.01 }),
        field('Probabilità massima', g.capture, 'maxChance', { step: 0.01 }),
        field('Master Ball = cattura garantita', g.capture, 'masterBallEnabled', { type: 'checkbox' }),
        field('Rimborsa riscossioni non valide', g.capture, 'refundRejected', { type: 'checkbox', help: 'solo ricompense create dall\'app' }),
        field('Segna riscossioni come completate', g.capture, 'fulfillProcessed', { type: 'checkbox' }),
        field('Revoca cattura se la riscossione viene annullata', g.capture, 'revokeOnCancel', { type: 'checkbox' })),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => saveGame(['capture']) }, 'Salva'))),
      card('Shiny', h('div', { class: 'form' },
        field('Shiny abilitati', g.shiny, 'enabled', { type: 'checkbox' }),
        field('Probabilità shiny (0–1)', g.shiny, 'chance', { step: 0.001, help: 'es. 0.01 = 1 su 100' }),
        field('Modificatore cattura shiny', g.shiny, 'catchModifier', { step: 0.05 })),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => saveGame(['shiny']) }, 'Salva')))),
    card('Evento speciale', h('div', { class: 'form' },
      field('Evento attivo', ev, 'enabled', { type: 'checkbox' }),
      field('Nome evento', ev, 'name', { type: 'text' }),
      field('Modificatore cattura', ev, 'catchModifier', { step: 0.05 }),
      field('Moltiplicatore shiny', ev, 'shinyMultiplier', { step: 0.5 }),
      field('Solo tipi (in inglese, separati da virgola)', ev, 'typesStr', { type: 'text', help: `es. fire,water — ${Object.keys(TYPE_IT).slice(0, 6).join(', ')}…` })),
      h('h3', { style: { marginTop: '12px' } }, 'Boost di apparizione per rarità'),
      h('div', { class: 'form' }, RARITY_KEYS.map((r) => field(RARITY[r].label, ev.rarityBoost, r, { step: 0.1 }))),
      h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => {
        g.event = { ...ev, types: ev.typesStr.split(',').map((x) => x.trim()).filter(Boolean) };
        saveGame(['event']);
      } }, 'Salva'))),
    card('Ciclo di vita LIVE', h('div', { class: 'form' },
      field('Controllo stato diretta ogni (s)', g.lifecycle, 'pollIntervalS', { min: 15 }),
      field('Conferme offline prima di chiudere', g.lifecycle, 'offlineConfirmations', { min: 1, max: 10 })),
      h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => saveGame(['lifecycle']) }, 'Salva'))),
    card('Storico spawn', hist));
  renderLive(d);
  renderHistory(d.history);
  const off = onLive((type) => { if (['spawn', 'despawn', 'attempt', 'status'].includes(type)) refresh().catch(() => {}); });
  const t = setInterval(() => refresh().catch(() => {}), 5000);
  return () => { off(); clearInterval(t); };
}
