// Overlay Themes: preset, salvataggio e persistenza, duplicazione e ripristino,
// importazione/esportazione JSON (con input malevoli), aggiornamento via
// WebSocket, cambio tema senza riavvio, isolamento del simulatore e
// compatibilità con l'overlay e le API delle versioni precedenti.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { makeApp, cleanup, seedPokemon, waitFor, tempDir } from './helpers.js';
import { startServer, overlaySocket, dbFingerprint } from './overlay-helpers.js';
import {
  PRESETS, LAYOUTS, sanitizeConfig, parseImport, exportTheme, effectiveSettings, defaultConfig, THEME_FORMAT,
} from '../public/assets/js/overlay/theme-core.js';
import { SIM_KINDS } from '../src/overlay/simulator.js';

const REQUIRED = ['minimal-dark', 'clean-glass', 'neon-hud', 'minimal-light', 'cyber-pulse', 'holographic', 'cinematic', 'gradient-motion'];

describe('Overlay Themes: preset e validazione', () => {
  test('8 preset richiesti + Classico, ognuno con uno stile grafico proprio e configurazione valida', () => {
    const slugs = PRESETS.map((p) => p.slug);
    for (const s of REQUIRED) assert.ok(slugs.includes(s), `manca il preset ${s}`);
    assert.ok(slugs.includes('classic'));
    // Identità grafica propria: stile (markup/CSS) diverso per ogni preset, non solo colori.
    assert.equal(new Set(PRESETS.map((p) => p.base)).size, PRESETS.length);
    for (const p of PRESETS) {
      assert.ok(LAYOUTS[p.base], `stile ${p.base} sconosciuto`);
      const css = join(process.cwd(), 'public/assets/css/themes', `${p.base}.css`);
      assert.ok(existsSync(css), `foglio di stile mancante: ${p.base}.css`);
      assert.ok(readFileSync(css, 'utf8').includes(`.t-${p.base}`), `${p.base}.css non definisce lo stile del tema`);
      const { config, warnings } = sanitizeConfig(p.config, p.config);
      assert.deepEqual(warnings, [], `${p.slug}: ${warnings.join(', ')}`);
      assert.deepEqual(config, p.config);
    }
    // I preset differiscono anche nei parametri (non sono copie con colori diversi).
    const shapes = new Set(PRESETS.map((p) => JSON.stringify([p.config.typography.font, p.config.animation.entrance, p.config.elements.timerStyle, p.config.shape.radius])));
    assert.ok(shapes.size >= 7);
  });

  test('sanificazione: colori e font non validi scartati, numeri limitati, campi sconosciuti ignorati', () => {
    const base = defaultConfig('neon-hud');
    const { config, warnings } = sanitizeConfig({
      colors: { primary: 'red;} body{display:none', secondary: 'url(javascript:alert(1))', panel: 'rgba(300, 0, 0, 0.5)', text: '#abc', success: 'rgba(1, 2, 3, 0.25)' },
      typography: { font: 'custom', customFont: 'Evil"; } *{x', baseSize: 999, weight: 'pesante' },
      layout: { position: 'ovunque', panelWidth: -50, scale: '1.5' },
      animation: { entrance: 'teletrasporto', enabled: 'sì' },
      effects: { intensity: 1e9 },
      __proto__: { polluted: true },
      extra: { a: 1 },
      elements: { nuovo: true },
    }, base);
    assert.equal(config.colors.primary, base.colors.primary);
    assert.equal(config.colors.secondary, base.colors.secondary);
    assert.equal(config.colors.panel, base.colors.panel, 'rgb fuori intervallo rifiutato');
    assert.equal(config.colors.text, '#abc');
    assert.equal(config.colors.success, 'rgba(1, 2, 3, 0.25)');
    assert.notEqual(config.typography.customFont, 'Evil"; } *{x');
    assert.notEqual(config.typography.font, 'custom', 'font personalizzato senza nome valido → font di sistema');
    assert.equal(config.typography.baseSize, 32);
    assert.equal(config.layout.panelWidth, 200);
    assert.equal(config.layout.scale, 1.5);
    assert.equal(config.layout.position, base.layout.position);
    assert.equal(config.animation.entrance, base.animation.entrance);
    assert.equal(config.animation.enabled, base.animation.enabled);
    assert.equal(config.effects.intensity, 100);
    assert.equal(({}).polluted, undefined, 'nessun prototype pollution');
    assert.equal(config.extra, undefined);
    assert.equal(config.elements.nuovo, undefined);
    assert.ok(warnings.some((w) => w.startsWith('extra')));
    assert.ok(warnings.some((w) => w.includes('colors.primary')));
  });

  test('importazione: formato, versione, base e dimensione verificati', () => {
    const t = { name: 'Prova', base: 'cinematic', config: defaultConfig('cinematic') };
    const back = parseImport(JSON.stringify(exportTheme(t)));
    assert.equal(back.base, 'cinematic');
    assert.deepEqual(back.config, t.config);
    assert.throws(() => parseImport('{non json'), /JSON/);
    assert.throws(() => parseImport(JSON.stringify({ format: 'altro', version: 1, theme: t })), /Formato/);
    assert.throws(() => parseImport(JSON.stringify({ format: THEME_FORMAT, version: 99, theme: t })), /Versione/);
    assert.throws(() => parseImport(JSON.stringify({ format: THEME_FORMAT, version: 1, theme: { ...t, base: '../../etc' } })), /sconosciuto/);
    assert.throws(() => parseImport('x'.repeat(70 * 1024)), /troppo grande/);
    const named = parseImport(JSON.stringify({ format: THEME_FORMAT, version: 1, theme: { ...t, name: '<img src=x onerror=alert(1)>Bello' } }));
    assert.ok(!/[<>]/.test(named.name));
  });
});

describe('Overlay Themes: API, persistenza, WebSocket e simulatore', () => {
  let s;
  before(async () => {
    s = await startServer();
    seedPokemon(s.app.db);
    await s.login();
  });
  after(async () => { const dir = s.ctx.dir; await s.app.close(); cleanup(dir); });

  const list = async () => (await s.req('GET', '/api/admin/overlay/themes')).data;
  const bySlug = async (slug) => (await list()).themes.find((t) => t.slug === slug);

  test('elenco: preset creati, Classico attivo di default, API protette', async () => {
    const d = await list();
    assert.equal(d.themes.length, PRESETS.length);
    assert.equal(d.themes.find((t) => t.id === d.activeId).slug, 'classic');
    assert.ok(d.options.layouts && d.options.fonts);
    assert.equal((await s.req('GET', '/api/admin/overlay/themes', undefined, { auth: false })).status, 401);
    assert.equal((await s.req('POST', '/api/admin/overlay/themes/import', { json: '{}' }, { auth: false })).status, 401);
    assert.equal((await s.req('POST', '/api/admin/overlay/simulate', { kind: 'spawn' }, { auth: false })).status, 401);
    // Senza token CSRF le modifiche vengono rifiutate.
    const cookieOnly = await fetch(`${s.base}/api/admin/overlay/themes/1/reset`, { method: 'POST' });
    assert.ok([401, 403].includes(cookieOnly.status));
  });

  test('salvataggio e caricamento; valori non validi corretti dal server', async () => {
    const t = await bySlug('minimal-dark');
    const cfg = structuredClone(t.config);
    cfg.colors.primary = '#123456';
    cfg.layout.panelWidth = 480;
    cfg.notifications.durationMs = 8000;
    cfg.colors.secondary = 'expression(alert(1))';
    const r = await s.req('PUT', `/api/admin/overlay/themes/${t.id}`, { config: cfg, name: 'Rinominato', rev: t.rev });
    assert.equal(r.status, 200);
    assert.ok(r.data.warnings.some((w) => w.includes('colors.secondary')));
    const after = await bySlug('minimal-dark');
    assert.equal(after.config.colors.primary, '#123456');
    assert.equal(after.config.layout.panelWidth, 480);
    assert.equal(after.config.notifications.durationMs, 8000);
    assert.equal(after.config.colors.secondary, t.config.colors.secondary);
    assert.equal(after.name, 'Minimal Dark', 'i preset mantengono il nome');
    assert.equal(after.modified, true);
    assert.equal((await s.req('PUT', '/api/admin/overlay/themes/99999', { config: cfg, rev: 0 })).status, 404);
    assert.equal((await s.req('PUT', '/api/admin/overlay/themes/abc', { config: cfg, rev: 0 })).status, 404);
  });

  test('duplicazione, ripristino ed eliminazione', async () => {
    const neon = await bySlug('neon-hud');
    const dup = await s.req('POST', `/api/admin/overlay/themes/${neon.id}/duplicate`, { name: 'Neon del sabato' });
    assert.equal(dup.status, 200);
    const copy = dup.data.theme;
    assert.equal(copy.name, 'Neon del sabato');
    assert.equal(copy.base, 'neon-hud');
    assert.equal(copy.builtin, false);
    assert.deepEqual(copy.config, neon.config);

    // Modifica della copia e ripristino ai valori con cui è stata creata.
    const changed = structuredClone(copy.config);
    changed.colors.primary = '#ff0000';
    await s.req('PUT', `/api/admin/overlay/themes/${copy.id}`, { config: changed, name: 'Neon rosso', rev: copy.rev });
    const reset = await s.req('POST', `/api/admin/overlay/themes/${copy.id}/reset`);
    assert.deepEqual(reset.data.theme.config, neon.config);
    assert.equal(reset.data.theme.name, 'Neon rosso', 'il ripristino non cambia il nome');

    // Preset modificato e ripristinato ai valori originali.
    const md = await bySlug('minimal-dark');
    assert.equal(md.modified, true);
    const r2 = await s.req('POST', `/api/admin/overlay/themes/${md.id}/reset`);
    assert.deepEqual(r2.data.theme.config, PRESETS.find((p) => p.slug === 'minimal-dark').config);
    assert.equal(r2.data.theme.modified, false);

    // Nuovo tema da zero e limiti.
    const created = await s.req('POST', '/api/admin/overlay/themes', { name: 'Da zero', base: 'holographic' });
    assert.equal(created.data.theme.base, 'holographic');
    assert.equal((await s.req('POST', '/api/admin/overlay/themes', { name: 'X', base: 'inesistente' })).status, 400);

    // I preset non si eliminano; il tema personalizzato attivo eliminato → torna il Classico.
    assert.equal((await s.req('DELETE', `/api/admin/overlay/themes/${neon.id}`)).status, 400);
    await s.req('POST', `/api/admin/overlay/themes/${copy.id}/activate`);
    const delr = await s.req('DELETE', `/api/admin/overlay/themes/${copy.id}`);
    assert.equal(delr.status, 200);
    assert.equal(delr.data.activeChanged, true);
    assert.equal((await list()).themes.find((t) => t.id === delr.data.activeId).slug, 'classic');
    await s.req('DELETE', `/api/admin/overlay/themes/${created.data.theme.id}`);
  });

  test('esportazione e importazione JSON (anche con valori malevoli)', async () => {
    const holo = await bySlug('holographic');
    const exp = await s.req('GET', `/api/admin/overlay/themes/${holo.id}/export`);
    assert.equal(exp.data.format, THEME_FORMAT);
    assert.equal(exp.data.theme.base, 'holographic');
    assert.ok(!('id' in exp.data.theme), 'nessun dato interno esportato');

    const imp = await s.req('POST', '/api/admin/overlay/themes/import', { json: JSON.stringify(exp.data) });
    assert.equal(imp.status, 200);
    assert.deepEqual(imp.data.theme.config, holo.config);
    assert.equal(imp.data.theme.builtin, false);
    assert.notEqual(imp.data.theme.id, holo.id, 'l\'importazione non sovrascrive mai un tema esistente');

    // Anche il file esportato inviato così com'è.
    assert.equal((await s.req('POST', '/api/admin/overlay/themes/import', exp.data)).status, 200);

    const evil = structuredClone(exp.data);
    evil.theme.name = '</script><script>alert(1)</script>';
    evil.theme.config.colors.primary = 'red; background:url(http://evil.example/x)';
    evil.theme.config.typography = { font: 'custom', customFont: "x'); @import url(http://evil.example)" };
    evil.theme.config.__proto__ = { hacked: 1 };
    const r = await s.req('POST', '/api/admin/overlay/themes/import', { json: JSON.stringify(evil) });
    assert.equal(r.status, 200);
    assert.ok(r.data.warnings.length >= 2);
    assert.ok(!/[<>]/.test(r.data.theme.name));
    assert.equal(r.data.theme.config.colors.primary, holo.config.colors.primary);
    assert.notEqual(r.data.theme.config.typography.font, 'custom');

    assert.equal((await s.req('POST', '/api/admin/overlay/themes/import', { json: '{"format":"altro"}' })).status, 400);
    assert.equal((await s.req('POST', '/api/admin/overlay/themes/import', { json: 'non json' })).status, 400);
    // Oltre 64 KB: rifiutato dalla validazione (400) o già dalla lettura della richiesta (413 / connessione chiusa).
    const big = await s.req('POST', '/api/admin/overlay/themes/import', { json: 'x'.repeat(64 * 1024 + 200) });
    assert.equal(big.status, 400);
    // Corpo molto più grande: rifiutato già in lettura (connessione separata, il server chiude subito).
    const { rawRequest } = await import('./helpers.js');
    const huge = await rawRequest(s.port, { method: 'POST', path: '/api/admin/overlay/themes/import', headers: { 'Content-Type': 'application/json', 'User-Agent': 'node', ...s.authHeaders() }, body: JSON.stringify({ json: 'x'.repeat(200 * 1024) }) }).catch((e) => ({ status: e.code }));
    assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(huge.status), String(huge.status));
    for (const t of (await list()).themes.filter((x) => !x.builtin)) await s.req('DELETE', `/api/admin/overlay/themes/${t.id}`);
  });

  test('WebSocket: snapshot con il tema, cambio tema e modifiche del tema attivo arrivano subito', async () => {
    const o = overlaySocket(s.port);
    await o.open;
    await waitFor(() => o.msgs.some((m) => m.type === 'snapshot'), { message: 'snapshot' });
    const snap = o.msgs.find((m) => m.type === 'snapshot').data;
    assert.equal(snap.settings.theme.slug, 'classic');
    // Campi delle versioni precedenti ancora presenti (compatibilità).
    for (const k of ['layout', 'colors', 'animations', 'notifications', 'elements', 'font']) assert.ok(k in snap.settings, k);

    const cin = await bySlug('cinematic');
    const act = await s.req('POST', `/api/admin/overlay/themes/${cin.id}/activate`);
    assert.equal(act.data.overlays, 1);
    await waitFor(() => o.msgs.some((m) => m.type === 'settings' && m.data.theme.base === 'cinematic'), { message: 'tema inviato' });

    // Modifica del tema attivo → nuovo messaggio con il valore aggiornato.
    const cfg = structuredClone(cin.config);
    cfg.colors.primary = '#abcdef';
    await s.req('PUT', `/api/admin/overlay/themes/${cin.id}`, { config: cfg, rev: cin.rev });
    await waitFor(() => o.msgs.some((m) => m.type === 'settings' && m.data.theme.config.colors.primary === '#abcdef'), { message: 'modifica inviata' });

    // Modifica di un tema NON attivo: nessun messaggio all'overlay.
    const before = o.msgs.length;
    const glass = await bySlug('clean-glass');
    const g = structuredClone(glass.config);
    g.colors.primary = '#000001';
    await s.req('PUT', `/api/admin/overlay/themes/${glass.id}`, { config: g, rev: glass.rev });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(o.msgs.slice(before).filter((m) => m.type === 'settings').length, 0);

    // Le API pubbliche (usate dall'overlay al caricamento) riflettono il tema attivo senza riavvio.
    const pub = await s.req('GET', '/api/public/overlay', undefined, { auth: false });
    assert.equal(pub.data.settings.theme.base, 'cinematic');
    assert.equal(pub.data.settings.colors.primary, '#abcdef');
    o.ws.close();
    await s.req('POST', `/api/admin/overlay/themes/${cin.id}/reset`);
    await s.req('POST', `/api/admin/overlay/themes/${glass.id}/reset`);
  });

  test('overlay /overlay e fogli di stile dei temi serviti; renderer compatibile', async () => {
    const page = await fetch(`${s.base}/overlay`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('id="spawn"') && html.includes('id="notes"') && html.includes('/assets/js/overlay.js'));
    for (const base of Object.keys(LAYOUTS)) assert.equal((await fetch(`${s.base}/assets/css/themes/${base}.css`)).status, 200, base);
    assert.equal((await fetch(`${s.base}/assets/js/overlay/theme-core.js`)).status, 200);
    const js = await (await fetch(`${s.base}/assets/js/overlay.js`)).text();
    for (const ev of ["case 'snapshot'", "case 'settings'", "case 'spawn'", "case 'throw'", "case 'despawn'", "case 'state'", "case 'clear'"]) assert.ok(js.includes(ev), ev);
  });

  test('simulatore: nessuna scrittura nel database, nessun effetto su statistiche, classifiche e storico', async () => {
    const statsBefore = (await s.req('GET', '/api/admin/stats')).data;
    const lbBefore = (await s.req('GET', '/api/admin/overview')).data.allTime;
    const fp = dbFingerprint(s.app.db);
    const engineBefore = JSON.stringify(s.app.engine.status());

    let spawn = null;
    for (const kind of SIM_KINDS) {
      const r = await s.req('POST', '/api/admin/overlay/simulate', { kind, target: 'preview', spawn, text: 'Ciao <b>chat</b>' });
      assert.equal(r.status, 200, kind);
      spawn = r.data.spawn;
      for (const e of r.data.events) {
        assert.equal(e.data.sim, true, `${kind}: evento non marcato come simulato`);
        if (e.type === 'spawn') assert.ok(e.data.id < 0, 'id simulati negativi: mai confondibili con spawn reali');
      }
    }
    const o = overlaySocket(s.port);
    await o.open;
    for (const kind of SIM_KINDS) assert.equal((await s.req('POST', '/api/admin/overlay/simulate', { kind, target: 'obs' })).status, 200, kind);
    await waitFor(() => o.msgs.some((m) => m.type === 'spawn' && m.data.sim), { message: 'simulazione su OBS' });
    o.ws.close();

    assert.deepEqual(dbFingerprint(s.app.db), fp, 'il database non deve cambiare');
    assert.deepEqual((await s.req('GET', '/api/admin/stats')).data, statsBefore);
    assert.deepEqual((await s.req('GET', '/api/admin/overview')).data.allTime, lbBefore);
    assert.equal(JSON.stringify(s.app.engine.status()), engineBefore, 'motore di gioco invariato');
    assert.equal((await s.req('POST', '/api/admin/overlay/simulate', { kind: 'boom' })).status, 400);
  });

  test('simulatore su OBS rifiutato a gioco attivo (DEMO o diretta)', async () => {
    s.app.engine.startDemo();
    try {
      const r = await s.req('POST', '/api/admin/overlay/simulate', { kind: 'spawn', target: 'obs' });
      assert.equal(r.status, 409);
      // L'anteprima resta disponibile.
      assert.equal((await s.req('POST', '/api/admin/overlay/simulate', { kind: 'spawn', target: 'preview' })).status, 200);
    } finally {
      s.app.engine.stopDemo();
    }
  });

  test('API delle versioni precedenti (/api/admin/overlay) ancora funzionanti sul tema attivo', async () => {
    const g = await s.req('GET', '/api/admin/overlay');
    assert.equal(g.status, 200);
    assert.ok(g.data.colors && g.data.layout && g.data.theme);
    const p = await s.req('PUT', '/api/admin/overlay', { colors: { primary: '#010203' }, layout: { position: 'top-left', width: 1280, height: 720 } });
    assert.equal(p.status, 200);
    assert.equal(p.data.colors.primary, '#010203');
    assert.equal(p.data.layout.position, 'top-left');
    assert.equal(p.data.layout.width, 1280);
    const active = (await list()).themes.find((t) => t.id === (s.app.themes.activeId()));
    assert.equal(active.config.colors.primary, '#010203');
    assert.equal((await s.req('PUT', '/api/admin/overlay', { colors: { primary: 'not-a-color' } })).status, 400);
    await s.req('POST', `/api/admin/overlay/themes/${active.id}/reset`);
  });
});

describe('Overlay Themes: persistenza e aggiornamento da versioni precedenti', () => {
  test('i temi restano salvati dopo il riavvio (stesso volume dati)', async () => {
    const dir = tempDir();
    let { app } = await makeApp({ dir, configureTwitch: false });
    const t = app.themes.bySlug('cyber-pulse');
    const cfg = structuredClone(t.config);
    cfg.colors.primary = '#0f0f0f';
    app.themes.update(t.id, { config: cfg });
    const custom = app.themes.duplicate(t.id, 'Il mio Cyber');
    app.themes.setActive(custom.id);
    await app.close();

    ({ app } = await makeApp({ dir, configureTwitch: false }));
    try {
      assert.equal(app.themes.bySlug('cyber-pulse').config.colors.primary, '#0f0f0f');
      assert.equal(app.themes.activeId(), custom.id);
      assert.equal(app.themes.active().name, 'Il mio Cyber');
      assert.equal(app.themes.list().length, PRESETS.length + 1, 'nessun preset duplicato al riavvio');
      assert.equal(app.themes.effective().theme.base, 'cyber-pulse');
    } finally {
      await app.close();
      cleanup(dir);
    }
  });

  test('database 1.0.0-rc.2 (schema v2) con impostazioni overlay personalizzate: migrazione al tema Classico senza cambiare l\'aspetto', async () => {
    const dir = tempDir();
    let { app } = await makeApp({ dir, configureTwitch: false });
    await app.close();
    // Riporta il database allo stato della rc.2: niente tabella dei temi, impostazioni nel vecchio formato.
    const db = new DatabaseSync(join(dir, 'db', 'livecatch.sqlite'));
    db.exec('DROP TABLE overlay_themes; DELETE FROM schema_migrations WHERE id >= 3; DELETE FROM overlay_settings;');
    const ins = db.prepare("INSERT INTO overlay_settings (key, value, updated_at) VALUES (?, ?, '2026-01-01')");
    ins.run('colors', JSON.stringify({ primary: '#112233', accent: '#445566', background: 'rgba(1, 2, 3, 0.5)', text: '#fefefe', success: '#00ff00', failure: '#ff0000' }));
    ins.run('layout', JSON.stringify({ position: 'top-center', scale: 1.25, width: 1280, height: 720, offsetX: 12, offsetY: 34 }));
    ins.run('notifications', JSON.stringify({ durationMs: 6000, maxQueue: 10, showThrows: false, showFailures: true }));
    db.close();

    ({ app } = await makeApp({ dir, configureTwitch: false }));
    try {
      assert.equal(app.db.schemaVersion(), 3);
      const active = app.themes.active();
      assert.equal(active.slug, 'classic');
      assert.equal(active.modified, true);
      assert.equal(active.config.colors.primary, '#112233');
      assert.equal(active.config.colors.secondary, '#445566');
      assert.equal(active.config.colors.panel, 'rgba(1, 2, 3, 0.5)');
      assert.equal(active.config.layout.position, 'top-center');
      assert.equal(active.config.layout.scale, 1.25);
      assert.equal(active.config.notifications.showThrows, false);
      const eff = app.themes.effective();
      assert.equal(eff.layout.width, 1280);
      assert.equal(eff.colors.accent, '#445566');
      assert.ok(readdirSafe(join(dir, 'backups')).some((f) => f.includes('pre-migration')), 'backup prima della migrazione');
      // "Ripristina" porta il Classico ai valori del preset, non a quelli importati.
      assert.deepEqual(app.themes.reset(active.id).config, PRESETS.find((p) => p.slug === 'classic').config);
    } finally {
      await app.close();
      cleanup(dir);
    }
  });

  test('effectiveSettings mantiene il formato letto dagli overlay precedenti', () => {
    const e = effectiveSettings({ base: 'neon-hud', name: 'N', config: defaultConfig('neon-hud') });
    assert.deepEqual(Object.keys(e.colors).sort(), ['accent', 'background', 'failure', 'primary', 'success', 'text']);
    assert.ok(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'top-center', 'bottom-center', 'center-left', 'center-right'].includes(e.layout.position));
    assert.equal(typeof e.animations.enabled, 'boolean');
  });
});

function readdirSafe(d) { try { return readdirSync(d); } catch { return []; } }
