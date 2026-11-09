import { h, mount, get, put, patch, post } from '../../lib.js';
import { card, act, field } from '../ui.js';

const DESCR = {
  pokedex: 'Mostra il Pokédex di chi scrive. Segnaposto: {user} {total} {species} {shiny}',
  pokemon: 'Numero totale di Pokémon posseduti. Segnaposto: {user} {total} {species} {shiny}',
  dex: 'Pokédex di un altro spettatore (!dex @utente). Segnaposto: {user} {target} {total} {species} {shiny}',
  ultimocatturato: 'Ultimo Pokémon catturato. Segnaposto: {user} {pokemon} {shinyTag} {ball} {when} {dex}',
  classifica: 'Classifica degli allenatori. Segnaposto: {top}',
  help: 'Elenco comandi. Segnaposto: {commands}',
};

export async function commands({ el }) {
  const d = await get('/api/admin/commands');
  const g = d.globals;
  const tester = { text: '!pokedex', login: '' };
  const out = h('div', { class: 'notice hidden', style: { marginTop: '10px' } });
  mount(el,
    h('div', { class: 'notice', style: { marginBottom: '16px' } }, 'I comandi rispondono in chat solo durante la diretta (stato LIVE). Fuori dalla diretta vengono ignorati.'),
    card('Impostazioni generali', h('div', { class: 'form' },
      field('Prefisso', g, 'prefix', { type: 'text' }),
      field('Anti-spam: comandi max per utente', g, 'userMaxPerWindow', { min: 1 }),
      field('…nella finestra di (s)', g, 'userWindowS', { min: 1 }),
      field('Limite risposte bot', g, 'botMaxPerWindow', { min: 1, help: 'Twitch consente circa 20 messaggi/30s' }),
      field('…nella finestra di (s)', g, 'botWindowS', { min: 1 })),
      h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => act(() => put('/api/admin/commands/globals', g), 'Salvato') }, 'Salva'))),
    d.commands.map((c) => {
      const s = { enabled: c.enabled, response: c.response, response_empty: c.response_empty || '', global_cooldown_s: c.global_cooldown_s, user_cooldown_s: c.user_cooldown_s, aliases: c.aliases.join(','), options: { ...c.options } };
      return card(null,
        h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, h('code', {}, `${g.prefix}${c.command}`)), h('span', { class: 'muted small' }, DESCR[c.command] || ''),
          h('span', { class: 'spacer' }), field('Attivo', s, 'enabled', { type: 'checkbox' })),
        h('div', { class: 'form', style: { marginTop: '10px' } },
          h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, 'Risposta', h('input', { value: s.response, oninput: (e) => { s.response = e.target.value; } })),
          c.command !== 'help' ? h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, 'Risposta quando non ci sono dati', h('input', { value: s.response_empty, oninput: (e) => { s.response_empty = e.target.value; } })) : null,
          field('Cooldown globale (s)', s, 'global_cooldown_s', { min: 0 }),
          field('Cooldown per utente (s)', s, 'user_cooldown_s', { min: 0 }),
          field('Alias (separati da virgola)', s, 'aliases', { type: 'text' }),
          c.command === 'dex' ? field('Consenti di vedere il Pokédex altrui', s.options, 'allowOthers', { type: 'checkbox' }) : null,
          c.command === 'classifica' ? field('Posizioni mostrate', s.options, 'size', { min: 1, max: 10 }) : null),
        h('div', { class: 'row end', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: () => act(() => patch(`/api/admin/commands/${c.command}`, {
          ...s, aliases: s.aliases.split(',').map((x) => x.trim()).filter(Boolean),
        }), 'Comando salvato') }, 'Salva')));
    }),
    card('Prova un comando', h('p', { class: 'muted small' }, 'Calcola la risposta con i dati reali ma NON la invia in chat.'),
      h('div', { class: 'form' }, field('Messaggio', tester, 'text', { type: 'text' }), field('Come utente (username esistente)', tester, 'login', { type: 'text' })),
      h('div', { class: 'row end', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: async () => {
        const r = await act(() => post('/api/admin/commands/test', tester));
        if (r) { out.textContent = r.reply; out.classList.remove('hidden'); }
      } }, 'Prova')), out));
}
