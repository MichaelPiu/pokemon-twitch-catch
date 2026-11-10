// Browser Source audio di OBS (/overlay/audio): nessun elemento visibile.
// Ascolta il canale WebSocket "audio" (solo eventi sonori, mai quelli grafici) e
// riproduce i suoni con HTML5 Audio. Si riconnette da sola e non riproduce mai
// eventi passati. Con ?debug=1 mostra una pagina diagnostica con un pulsante per
// sbloccare l'audio se il browser blocca la riproduzione automatica.
import { AudioPlayer } from './audio-core.js';

const debug = new URLSearchParams(location.search).has('debug');
const panel = document.getElementById('diag');
const conn = { connected: false, attempts: 0, since: null };

const player = new AudioPlayer({ onChange: () => render() });

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/audio`);
  ws.onopen = () => { conn.connected = true; conn.attempts = 0; conn.since = Date.now(); render(); };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === 'snapshot') player.snapshot(msg.data, msg.ts);
    else if (msg.type === 'settings') player.setSettings(msg.data);
    else if (msg.type === 'play') player.handle(msg.data);
  };
  ws.onclose = () => {
    conn.connected = false;
    conn.attempts++;
    render();
    setTimeout(connect, Math.min(10000, 1000 * conn.attempts)); // 1 s, 2 s, ... fino a 10 s
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignora */ } };
}

// Sblocco manuale dell'autoplay: un clic (in OBS: Interagisci) riproduce un
// suono silenzioso e autorizza i successivi.
function unlock() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      ctx.resume?.();
    }
    player.lastError = null;
    render('Audio sbloccato: prova un suono dalla dashboard (Audio OBS → Prova).');
  } catch (e) {
    render(`Sblocco non riuscito: ${e.message}`);
  }
}

const OUTCOME = { played: 'riprodotto', duplicate: 'duplicato', stale: 'troppo vecchio', invalid: 'non valido', error: 'errore', blocked: 'bloccato' };

function render(message = null) {
  if (!debug || !panel) return;
  const s = player.state();
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const rows = [
    el('h1', 'Live Catch · Audio OBS (diagnostica)'),
    el('p', conn.connected ? '● Collegato al server' : `○ Non collegato (tentativo ${conn.attempts})`, conn.connected ? 'ok' : 'err'),
    el('p', s.settings ? `Audio ${s.settings.enabled ? 'attivo' : 'disattivato'} · spawn ${s.settings.spawnEnabled ? 'sì' : 'no'} · cattura ${s.settings.captureEnabled ? 'sì' : 'no'} · volume ${s.settings.volume}%` : 'Impostazioni non ancora ricevute'),
    el('p', `Ricevuti ${s.stats.received} · riprodotti ${s.stats.played} · duplicati ${s.stats.duplicates} · scartati perché vecchi ${s.stats.stale} · bloccati ${s.stats.blocked} · errori ${s.stats.errors}`),
  ];
  if (s.lastError) rows.push(el('p', `Ultimo problema: ${s.lastError.name || ''} — ${s.lastError.message}`, 'err'));
  if (s.lastError?.blocked) rows.push(el('p', 'Il browser blocca la riproduzione automatica: premi "Sblocca audio" (in OBS: clic destro sulla sorgente → Interagisci).', 'err'));
  if (message) rows.push(el('p', message, 'ok'));
  const btn = el('button', '🔊 Sblocca audio');
  btn.onclick = unlock;
  rows.push(btn);
  const list = el('ol');
  for (const l of s.log) list.appendChild(el('li', `${new Date(l.at).toLocaleTimeString('it-IT')} · ${l.kind || '?'} · ${l.name || ''} · ${OUTCOME[l.outcome] || l.outcome}${l.detail ? ` (${l.detail})` : ''}`));
  rows.push(list);
  panel.replaceChildren(...rows);
}

if (debug && panel) panel.hidden = false;
window.__liveCatchAudio = { state: () => ({ ...player.state(), connected: conn.connected }) };
render();
connect();
