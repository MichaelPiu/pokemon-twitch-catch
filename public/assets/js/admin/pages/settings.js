// Impostazioni: account amministratore, pagine pubbliche, sicurezza dell'accesso, modalità DEMO.
import { h, mount, get, post, put } from '../../lib.js';
import { icon } from '../../icons.js';
import { act, field, toast } from '../ui.js';
import { demo } from './demo.js';

function panel(title, ic, ...children) {
  return h('section', { class: 'panel', style: { marginBottom: '20px' } }, h('div', { class: 'panel-head' }, h('h2', {}, icon(ic, { size: 22 }), title)), ...children);
}

function securityPanel(sec, reload) {
  const st = { hosts: (sec.adminHosts || []).join(', '), bindSessionIp: !!sec.bindSessionIp, idleTimeoutH: sec.idleTimeoutH };
  const host = sec.request.host.replace(/:\d+$/, '');
  const active = sec.adminHostsEffective.length > 0;
  return panel('Sicurezza dell\'accesso', 'key',
    h('p', { class: 'muted' },
      'Su Umbrel tutte le app condividono lo stesso indirizzo (umbrel.local) e i browser inviano i cookie a ogni porta di quell\'indirizzo. ',
      'Per isolare la sessione della dashboard dalle altre app usa un ', h('b', {}, 'hostname dedicato'),
      ' (es. livecatch.lan) che punti all\'IP del server: vedi la guida "Hostname dedicato" nel README.'),
    h('div', { class: 'grid c2', style: { marginBottom: '12px' } },
      h('div', { class: 'muted small' }, 'Host in uso: ', h('b', {}, sec.request.host || '—'), h('br'), 'Il tuo IP visto dal server: ', h('b', {}, sec.request.clientIp),
        h('br'), 'Connessione: ', h('b', {}, sec.request.https ? 'HTTPS' : 'HTTP')),
      h('div', { class: 'muted small' }, 'Proxy fidati: ', h('b', {}, sec.proxy.configured ? sec.proxy.entries.join(', ') : 'nessuno (accesso diretto)'),
        h('br'), 'Hostname dedicato: ', h('b', { style: { color: active ? 'var(--ok)' : 'var(--warn)' } }, active ? sec.adminHostsEffective.join(', ') : 'non attivo'))),
    h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Hostname dedicati alla dashboard (separati da virgola, senza http:// e senza porta)',
        h('input', { value: st.hosts, placeholder: 'livecatch.lan', disabled: sec.adminHostsFromEnv, oninput: (e) => { st.hosts = e.target.value; } }),
        h('span', { class: 'small' }, sec.adminHostsFromEnv ? 'Impostato dalla variabile ADMIN_HOSTS.' : `Per attivarlo apri prima la dashboard da quell'indirizzo (ora: ${host}). Le altre sessioni verranno chiuse.`)),
      field('Chiudi la sessione dopo ore di inattività', st, 'idleTimeoutH', { min: 1, max: 168, step: 1 })),
    h('div', { style: { marginTop: '12px' } },
      field('Sessione valida solo dall\'indirizzo IP del login', st, 'bindSessionIp', { type: 'checkbox', help: 'impedisce il riuso del cookie da un altro dispositivo o da un\'altra app' })),
    h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: async () => {
      const body = { bindSessionIp: st.bindSessionIp, idleTimeoutH: st.idleTimeoutH };
      if (!sec.adminHostsFromEnv) body.adminHosts = st.hosts.split(',').map((x) => x.trim()).filter(Boolean);
      const r = await act(() => put('/api/admin/security', body), 'Impostazioni di sicurezza salvate');
      if (r?.closedSessions) toast(`Chiuse ${r.closedSessions} altre sessioni`, 'ok');
      if (r) reload();
    } }, 'Salva')));
}

export async function settings({ el, store }) {
  const [pages, sec] = await Promise.all([get('/api/admin/public-pages'), get('/api/admin/security')]);
  const secBox = h('div');
  const reloadSec = async () => mount(secBox, securityPanel(await get('/api/admin/security'), reloadSec));
  mount(secBox, securityPanel(sec, reloadSec));
  const pw = { current: '', next: '', repeat: '' };
  const pwInputs = [];
  const pwField = (label, key, auto) => {
    const i = h('input', { type: 'password', autocomplete: auto, oninput: (e) => { pw[key] = e.target.value; } });
    pwInputs.push(i);
    return h('label', { class: 'field' }, label, i);
  };
  const demoBox = h('div');
  mount(el,
    h('div', { class: 'row2' },
      panel('Account amministratore', 'key',
        h('p', { class: 'muted' }, `Utente: `, h('b', {}, store.me?.username || 'admin'), '. Cambiando la password vengono chiuse tutte le altre sessioni aperte.'),
        h('div', { class: 'form' },
          pwField('Password attuale', 'current', 'current-password'),
          pwField('Nuova password (min. 10, lettere e numeri)', 'next', 'new-password'),
          pwField('Ripeti nuova password', 'repeat', 'new-password')),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: async () => {
          if (pw.next !== pw.repeat) { toast('Le password non coincidono', 'err'); return; }
          const r = await act(() => post('/api/auth/change-password', { currentPassword: pw.current, newPassword: pw.next }), 'Password aggiornata');
          if (r) pwInputs.forEach((i) => { i.value = ''; });
        } }, 'Salva password'))),
      panel('Pagine pubbliche', 'monitor',
        h('p', { class: 'muted' }, 'Pagine visibili senza login nella rete locale. L\'overlay /overlay e /health sono sempre attivi.'),
        h('div', { style: { display: 'grid', gap: '12px' } },
          field('Pagina introduttiva (/)', pages, 'landing', { type: 'checkbox' }),
          field('Pokédex pubblici (/pokedex/utente)', pages, 'pokedex', { type: 'checkbox' }),
          field('Classifica (/leaderboard)', pages, 'leaderboard', { type: 'checkbox' })),
        h('div', { class: 'row end', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => act(() => put('/api/admin/public-pages', pages), 'Pagine aggiornate') }, 'Salva')))),
    secBox,
    panel('Modalità DEMO', 'flask', demoBox));
  return demo({ el: demoBox });
}
