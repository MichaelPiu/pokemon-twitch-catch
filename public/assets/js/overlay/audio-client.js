// Effetti sonori dell'overlay principale (/overlay): la stessa Browser Source di
// OBS mostra la grafica e riproduce i suoni. Nessuna seconda sorgente.
//
// - L'audio è un modulo indipendente dalla grafica: cambi di tema, classifiche a
//   rotazione, coda delle animazioni e snapshot dell'overlay non lo toccano, quindi
//   un suono non viene interrotto né ripetuto da un aggiornamento grafico.
// - Usa un canale WebSocket dedicato (/ws/audio) che trasporta solo eventi sonori
//   con ID univoco; la deduplicazione e lo scarto degli eventi vecchi sono in
//   audio-core.js. Alla (ri)connessione arrivano solo impostazioni e ora del server.
// - Si attiva solo dove deve suonare: nella Browser Source di OBS (window.obsstudio)
//   o se richiesto esplicitamente con ?audio=1. Nell'anteprima della dashboard
//   (?preview=1, iframe) e in un normale browser resta muto e non si collega
//   nemmeno al canale audio (il contatore delle sorgenti resta esatto).
// - ?debug=1 mostra un riquadro diagnostico con il pulsante "Sblocca audio".
import { AudioPlayer } from './audio-core.js';

// Decide se questa pagina deve riprodurre audio. Pura: testabile in Node.
export function audioMode({ search = '', isObs = false, inFrame = false } = {}) {
  const p = new URLSearchParams(search);
  const debug = p.get('debug') === '1';
  const flag = p.get('audio');
  if (p.get('preview') === '1') return { enabled: false, debug: false, reason: 'anteprima della dashboard' };
  if (flag === '0') return { enabled: false, debug, reason: 'disattivato con ?audio=0' };
  if (inFrame) return { enabled: false, debug, reason: 'pagina incorporata in un\'altra (es. dashboard)' };
  if (isObs) return { enabled: true, debug, reason: 'Browser Source di OBS' };
  if (flag === '1') return { enabled: true, debug, reason: 'abilitato con ?audio=1' };
  return { enabled: false, debug, reason: 'pagina aperta fuori da OBS (aggiungi ?audio=1 per provarlo in un browser)' };
}

const OUTCOME = { played: 'riprodotto', duplicate: 'duplicato', stale: 'troppo vecchio', invalid: 'non valido', error: 'errore', blocked: 'bloccato' };

export function startOverlayAudio(win = window) {
  let inFrame = false;
  try { inFrame = win.self !== win.top; } catch { inFrame = true; }
  const mode = audioMode({ search: win.location.search, isObs: !!win.obsstudio, inFrame });
  const conn = { connected: false, attempts: 0 };
  let panel = null;
  let message = null;
  let ws = null;
  let stopped = false;

  const player = mode.enabled ? new AudioPlayer({ AudioCtor: win.Audio, onChange: () => render() }) : null;

  function render() {
    if (!panel) return;
    const el = (tag, text, cls) => { const e = win.document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const rows = [el('b', 'Live Catch · Audio (diagnostica)')];
    if (!player) {
      rows.push(el('p', `Audio non attivo in questa pagina: ${mode.reason}.`, 'err'));
    } else {
      const s = player.state();
      rows.push(el('p', `Attivo: ${mode.reason}`, 'ok'));
      rows.push(el('p', conn.connected ? '● Collegato al canale audio' : `○ Non collegato (tentativo ${conn.attempts})`, conn.connected ? 'ok' : 'err'));
      rows.push(el('p', s.settings ? `Audio ${s.settings.enabled ? 'attivo' : 'disattivato'} · spawn ${s.settings.spawnEnabled ? 'sì' : 'no'} · cattura ${s.settings.captureEnabled ? 'sì' : 'no'} · volume ${s.settings.volume}%` : 'Impostazioni non ancora ricevute'));
      rows.push(el('p', `Ricevuti ${s.stats.received} · riprodotti ${s.stats.played} · duplicati ${s.stats.duplicates} · vecchi ${s.stats.stale} · bloccati ${s.stats.blocked} · errori ${s.stats.errors}`));
      if (s.lastError) rows.push(el('p', `Ultimo problema: ${s.lastError.name || ''} — ${s.lastError.message}`, 'err'));
      if (s.lastError?.blocked) rows.push(el('p', 'Riproduzione automatica bloccata: premi "Sblocca audio" (in OBS: clic destro sulla sorgente → Interagisci).', 'err'));
      if (message) rows.push(el('p', message, 'ok'));
      const btn = el('button', '🔊 Sblocca audio');
      btn.onclick = unlock;
      rows.push(btn);
      const list = el('ol');
      for (const l of s.log) list.appendChild(el('li', `${new Date(l.at).toLocaleTimeString('it-IT')} · ${l.kind || '?'} · ${l.name || ''} · ${OUTCOME[l.outcome] || l.outcome}${l.detail ? ` (${l.detail})` : ''}`));
      rows.push(list);
    }
    panel.replaceChildren(...rows);
  }

  // Sblocco manuale dell'autoplay: un clic riproduce un suono silenzioso e
  // autorizza i successivi.
  function unlock() {
    try {
      const Ctx = win.AudioContext || win.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, 22050);
        src.connect(ctx.destination);
        src.start(0);
        ctx.resume?.();
      }
      player.lastError = null;
      message = 'Audio sbloccato: prova un suono dalla dashboard (Audio OBS → Prova).';
    } catch (e) {
      message = `Sblocco non riuscito: ${e.message}`;
    }
    render();
  }

  function connect() {
    if (stopped) return;
    ws = new win.WebSocket(`${win.location.protocol === 'https:' ? 'wss' : 'ws'}://${win.location.host}/ws/audio`);
    ws.onopen = () => { conn.connected = true; conn.attempts = 0; render(); };
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
      if (!stopped) win.setTimeout(connect, Math.min(10000, 1000 * conn.attempts)); // 1 s, 2 s, ... fino a 10 s
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignora */ } };
  }

  if (mode.debug) {
    panel = win.document.createElement('div');
    panel.id = 'audio-diag';
    win.document.body.appendChild(panel);
  }
  win.__liveCatchAudio = {
    state: () => ({ enabled: mode.enabled, reason: mode.reason, connected: conn.connected, ...(player ? player.state() : {}) }),
  };
  render();
  if (player) connect();
  // close(): solo per i test (la pagina in OBS resta collegata finché è aperta).
  return { mode, player, unlock, close: () => { stopped = true; try { ws?.close(); } catch { /* ignora */ } } };
}
