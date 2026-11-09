import { h, mount, get, post, put, patch, del, fmt } from '../../lib.js';
import { card, table, act, confirmDialog, modal } from '../ui.js';
import { stateRow } from './common.js';
import { onLive } from '../main.js';

export async function twitch({ el }) {
  let pollTimer = null;
  const load = async () => {
    const d = await get('/api/admin/twitch');
    const balls = await get('/api/admin/balls');
    const c = d.credentials;
    const app = { clientId: c.clientId, clientSecret: '' };
    const st = d.status;

    const accountBox = (role, title, scopes) => {
      const t = c[role];
      const pending = d.pending[role];
      return card(title,
        t.connected
          ? h('div', {},
            h('div', { class: 'notice ok' }, `✅ Collegato come `, h('b', {}, t.login), ` (ID ${t.userId}) · aggiornato ${fmt.dt(t.updatedAt)}`),
            h('div', { class: 'muted small', style: { marginTop: '6px' } }, `Scope concessi: ${(t.scopes || []).join(', ') || '—'}`),
            h('div', { class: 'row', style: { marginTop: '10px' } },
              h('button', { class: 'btn', onclick: () => startAuth(role) }, 'Ricollega'),
              h('button', { class: 'btn danger', onclick: async () => {
                if (!await confirmDialog(`Scollegare l'account ${t.login}? Il gioco smetterà di funzionare finché non lo ricolleghi.`, { danger: true })) return;
                await act(() => del(`/api/admin/twitch/auth/${role}`), 'Account scollegato'); load();
              } }, 'Scollega')))
          : h('div', {},
            h('p', { class: 'muted' }, role === 'bot'
              ? 'Facoltativo: un secondo account Twitch che scrive le risposte in chat. Se non lo colleghi, risponde l\'account del canale.'
              : 'Collega l\'account Twitch del TUO canale (quello che trasmette). Serve per rilevare le dirette, ricevere le riscossioni dei punti canale e leggere la chat.'),
            h('p', { class: 'muted small' }, 'Permessi richiesti: ', scopes.map((s) => h('code', {}, s)), '.'),
            pending && pending.status === 'pending' ? pendingBox(role, pending) : h('button', { class: 'btn primary', disabled: !c.clientId, onclick: () => startAuth(role) }, `Collega account ${role === 'bot' ? 'bot' : 'del canale'}`),
            !c.clientId ? h('div', { class: 'muted small' }, 'Inserisci prima il Client ID qui sopra.') : null));
    };

    const pendingBox = (role, p) => {
      const box = h('div', { class: 'notice' },
        h('ol', { class: 'steps' },
          h('li', {}, 'Apri ', h('a', { href: p.verificationUri, target: '_blank', rel: 'noopener' }, p.verificationUri), ' (da qualsiasi dispositivo, accedendo con l\'account giusto).'),
          h('li', {}, 'Inserisci questo codice: ', h('div', { class: 'code-box', style: { marginTop: '6px' } }, p.userCode)),
          h('li', {}, 'Autorizza l\'applicazione. Questa pagina si aggiornerà da sola.')),
        h('div', { class: 'muted small' }, `Il codice scade alle ${fmt.time(new Date(p.expiresAt).toISOString())}.`));
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        try {
          const r = await post(`/api/admin/twitch/auth/${role}/poll`);
          if (r.status === 'authorized') { clearInterval(pollTimer); load(); }
          else if (r.status !== 'pending') { clearInterval(pollTimer); mount(box, h('div', { class: 'notice err' }, `Autorizzazione non riuscita: ${r.error || r.status}`)); }
        } catch { /* riprova */ }
      }, 5000);
      return box;
    };

    const startAuth = async (role) => {
      const r = await act(() => post(`/api/admin/twitch/auth/${role}/start`));
      if (r) load();
    };

    const testOut = h('div');
    mount(el,
      card('Stato connessione',
        h('div', { class: 'row' }, stateRow(d.lifecycle), h('span', { class: 'muted' }, `motivo: ${d.lifecycle.reason || '—'}`),
          h('span', { class: 'pill' }, h('span', { class: `dot ${st.eventsubConnected ? 'ok' : 'warn'}` }), st.eventsubConnected ? 'EventSub connesso' : 'EventSub non connesso'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: async () => { await act(() => post('/api/admin/twitch/reconnect'), 'Riconnessione avviata'); setTimeout(load, 1500); } }, '🔄 Riconnetti'),
          h('button', { class: 'btn accent', onclick: async () => {
            mount(testOut, h('div', { class: 'muted' }, 'Test in corso…'));
            const r = await act(() => post('/api/admin/twitch/test'));
            if (r) mount(testOut, table([{ label: 'Verifica', key: 'name' }, { label: 'Esito', render: (x) => (x.ok ? '✅' : '❌') }, { label: 'Dettaglio', key: 'detail' }], r.results));
          } }, '🧪 Testa connessione')),
        h('div', { class: 'muted small', style: { marginTop: '8px' } },
          `Ultimo controllo API: ${st.lastPoll ? `${fmt.dt(st.lastPoll.at)} (${st.lastPoll.ok ? (st.lastPoll.live ? 'LIVE' : 'offline') : 'errore'})` : '—'} · Eventi ricevuti: ${st.eventsReceived} · Messaggi bot inviati: ${st.chat?.sent ?? 0}`),
        st.lastError ? h('div', { class: 'notice err', style: { marginTop: '10px' } }, st.lastError) : null,
        st.subscriptions?.length ? h('div', { class: 'row', style: { marginTop: '10px' } }, st.subscriptions.map((s) => h('span', { class: 'pill', title: s.error || '' },
          h('span', { class: `dot ${s.status === 'enabled' ? 'ok' : 'warn'}` }), s.type.replace('channel.channel_points_custom_reward_redemption', 'redemption')))) : null,
        testOut),
      card('1 · Applicazione Twitch (Client ID e Secret)',
        h('ol', { class: 'steps' },
          h('li', {}, 'Vai su ', h('a', { href: 'https://dev.twitch.tv/console/apps', target: '_blank', rel: 'noopener' }, 'dev.twitch.tv/console/apps'), ' e accedi.'),
          h('li', {}, 'Clicca ', h('b', {}, 'Registra la tua applicazione'), '. Nome: a piacere (es. "LiveCatch Mario"). URL di reindirizzamento OAuth: ', h('code', {}, 'http://localhost'), '. Categoria: Chat Bot. Tipo client: ', h('b', {}, 'Riservato'), '.'),
          h('li', {}, 'Apri l\'app creata, copia il ', h('b', {}, 'Client ID'), ', poi clicca ', h('b', {}, 'Nuovo segreto'), ' e copia il ', h('b', {}, 'Client Secret'), '.')),
        h('div', { class: 'form', style: { marginTop: '10px' } },
          h('label', { class: 'field' }, 'Client ID', h('input', { value: app.clientId, autocomplete: 'off', oninput: (e) => { app.clientId = e.target.value.trim(); } })),
          h('label', { class: 'field' }, `Client Secret ${c.clientSecretSet ? '(già salvato — lascia vuoto per non cambiarlo)' : ''}`,
            h('input', { type: 'password', autocomplete: 'new-password', placeholder: c.clientSecretSet ? '••••••••' : '', oninput: (e) => { app.clientSecret = e.target.value.trim(); } }))),
        h('div', { class: 'row end', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: async () => {
          if (c.clientId && app.clientId !== c.clientId && !await confirmDialog('Cambiando Client ID gli account collegati verranno scollegati. Continuare?')) return;
          await act(() => put('/api/admin/twitch/app', app), 'Credenziali salvate (cifrate sul server)'); load();
        } }, 'Salva'))),
      accountBox('broadcaster', '2 · Account del canale', d.scopes.broadcaster),
      accountBox('bot', '3 · Account bot (facoltativo)', d.scopes.bot),
      rewardsCard(d.rewards, balls, c.broadcaster.connected, load),
      card('Eventi Twitch recenti', h('div', { id: 'tw-events' }, h('div', { class: 'muted' }, 'Caricamento…'))));
    get('/api/admin/twitch/events?limit=50').then((ev) => {
      const box = document.getElementById('tw-events');
      if (box) mount(box, table([
        { label: 'Ricevuto', render: (r) => fmt.dt(r.received_at) },
        { label: 'Tipo', render: (r) => h('code', {}, r.event_type) },
        { label: 'Stato', key: 'status' },
        { label: 'Dettaglio', render: (r) => r.detail || '—' },
      ], ev, { empty: 'Nessun evento ricevuto' }));
    }).catch(() => {});
  };
  await load();
  // Ricarica la pagina quando cambia lo stato (connessione, LIVE/OFFLINE), salvo durante un'autorizzazione in corso.
  let t = null;
  const off = onLive((type) => {
    if (type !== 'state' || document.querySelector('.code-box')) return;
    clearTimeout(t);
    t = setTimeout(() => load().catch(() => {}), 300);
  });
  return () => { clearInterval(pollTimer); clearTimeout(t); off(); };
}

function rewardsCard(rewards, balls, connected, reload) {
  const createState = { ballTypeId: balls[0]?.id, cost: 500, title: '' };
  const linkState = { rewardId: '', ballTypeId: balls[0]?.id, title: '' };
  const ballSelect = (obj) => h('select', { onchange: (e) => { obj.ballTypeId = Number(e.target.value); } }, balls.filter((b) => b.enabled).map((b) => h('option', { value: b.id }, b.name)));
  return card('4 · Ricompense punti canale (Poké Ball)',
    h('p', { class: 'muted small' }, 'Le riscossioni reali dei punti canale generano i lanci. Le ricompense create da qui possono essere gestite automaticamente (rimborso se non c\'è nessun Pokémon, attivazione, costo). Le ricompense create a mano su Twitch possono essere solo collegate tramite ID. Richiede canale Affiliate o Partner.'),
    table([
      { label: 'Ricompensa', render: (r) => h('div', {}, h('b', {}, r.title), h('div', { class: 'muted small mono' }, r.reward_id)) },
      { label: 'Poké Ball', render: (r) => h('select', { onchange: async (e) => { await act(() => patch(`/api/admin/twitch/rewards/${r.id}`, { ballTypeId: Number(e.target.value) }), 'Associazione aggiornata'); } },
        balls.map((b) => h('option', { value: b.id, selected: b.id === r.ball_type_id }, b.name))) },
      { label: 'Costo', render: (r) => (r.managed_by_app
        ? h('input', { type: 'number', min: 1, value: r.cost ?? '', style: { width: '100px' }, onchange: async (e) => { await act(() => patch(`/api/admin/twitch/rewards/${r.id}`, { cost: Number(e.target.value) }), 'Costo aggiornato su Twitch'); } })
        : (r.cost ?? '—')) },
      { label: 'Gestione', render: (r) => (r.managed_by_app ? 'app' : 'manuale') },
      { label: 'Verifica', render: (r) => (r.verify_status === 'ok' ? '✅' : r.verify_status === 'missing' ? '❌ non trovata' : '—') },
      { label: 'Attiva', render: (r) => h('input', { type: 'checkbox', checked: !!r.is_enabled, onchange: async (e) => { await act(() => patch(`/api/admin/twitch/rewards/${r.id}`, { isEnabled: e.target.checked }), 'Aggiornato'); } }) },
      { label: '', render: (r) => h('button', { class: 'btn sm danger', onclick: async () => {
        if (!await confirmDialog('Scollegare questa ricompensa dal gioco? Su Twitch la ricompensa NON viene eliminata.')) return;
        await act(() => del(`/api/admin/twitch/rewards/${r.id}`), 'Scollegata'); reload();
      } }, 'Scollega') },
    ], rewards, { empty: 'Nessuna ricompensa collegata' }),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'btn', disabled: !connected, onclick: async () => { const r = await act(() => post('/api/admin/twitch/rewards/verify'), 'Verifica completata'); if (r) reload(); } }, '✔️ Verifica ID ricompense'),
      h('button', { class: 'btn', disabled: !connected, onclick: () => showRemote(balls, reload) }, '📋 Ricompense esistenti sul canale')),
    h('div', { class: 'grid c2', style: { marginTop: '14px' } },
      h('div', { class: 'card' }, h('h3', {}, 'Crea nuova ricompensa su Twitch'),
        h('div', { class: 'form' },
          h('label', { class: 'field' }, 'Poké Ball', ballSelect(createState)),
          h('label', { class: 'field' }, 'Costo in punti', h('input', { type: 'number', min: 1, value: 500, oninput: (e) => { createState.cost = Number(e.target.value); } })),
          h('label', { class: 'field' }, 'Titolo (facoltativo)', h('input', { placeholder: 'Lancia una …', maxlength: 45, oninput: (e) => { createState.title = e.target.value; } }))),
        h('div', { class: 'row end', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', disabled: !connected, onclick: async () => {
          const r = await act(() => post('/api/admin/twitch/rewards', { ...createState, title: createState.title || undefined }), 'Ricompensa creata su Twitch');
          if (r) reload();
        } }, 'Crea'))),
      h('div', { class: 'card' }, h('h3', {}, 'Collega ricompensa esistente (ID)'),
        h('div', { class: 'form' },
          h('label', { class: 'field' }, 'ID ricompensa', h('input', { placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', oninput: (e) => { linkState.rewardId = e.target.value.trim(); } })),
          h('label', { class: 'field' }, 'Poké Ball', ballSelect(linkState)),
          h('label', { class: 'field' }, 'Nome (promemoria)', h('input', { oninput: (e) => { linkState.title = e.target.value; } }))),
        h('div', { class: 'row end', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: async () => {
          const r = await act(() => post('/api/admin/twitch/rewards/link', linkState), 'Ricompensa collegata');
          if (r) reload();
        } }, 'Collega')))));
}

async function showRemote(balls, reload) {
  let list;
  try { list = await get('/api/admin/twitch/rewards/remote'); } catch { return; }
  const m = modal('Ricompense presenti sul canale', table([
    { label: 'Titolo', key: 'title' },
    { label: 'Costo', key: 'cost' },
    { label: 'Gestibile dall\'app', render: (r) => (r.manageable ? 'sì' : 'no (creata a mano)') },
    { label: '', render: (r) => (r.linked ? '✅ collegata' : h('div', { class: 'row' },
      h('select', { id: `sel-${r.id}` }, balls.map((b) => h('option', { value: b.id }, b.name))),
      h('button', { class: 'btn sm primary', onclick: async () => {
        const ballTypeId = Number(document.getElementById(`sel-${r.id}`).value);
        const x = await act(() => post('/api/admin/twitch/rewards/link', { rewardId: r.id, ballTypeId, title: r.title, cost: r.cost }), 'Collegata');
        if (x) { m.close(); reload(); }
      } }, 'Collega'))) },
  ], list, { empty: 'Nessuna ricompensa personalizzata sul canale' }));
}
