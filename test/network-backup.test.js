// Backup automatici e ripristino su una cartella di rete montata (qui: una
// cartella temporanea che fa le veci del volume BACKUP_TARGET_ROOT).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  makeApp, cleanup, seedPokemon, tempDir, adminClient, FakeTwitch, FakeEventSub, waitFor, BROADCASTER_ID,
} from './helpers.js';
import { manifestName, parseBackupName } from '../src/backup/network.js';
import { LATEST_SCHEMA } from '../src/database/migrations.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('Backup su cartella di rete', () => {
  let ctx, app, root, client;

  beforeEach(async () => {
    root = tempDir();
    ctx = await makeApp({ configureTwitch: false, env: { BACKUP_TARGET_ROOT: root, BACKUP_TIMEOUT_MS: '2000' } });
    app = ctx.app;
    seedPokemon(app.db);
    client = await adminClient(app);
  });

  afterEach(async () => {
    try { chmodSync(join(root, 'livecatch'), 0o755); } catch { /* ignora */ }
    await app.close();
    cleanup(ctx.dir);
    cleanup(root);
  });

  const nb = () => app.networkBackups;
  const dir = () => join(root, 'livecatch');
  const addTrainer = (login) => app.db.run('INSERT INTO twitch_users (twitch_id, login, display_name) VALUES (?, ?, ?)', `t-${login}`, login, login);
  const files = () => (existsSync(dir()) ? readdirSync(dir()).sort() : []);
  const archives = () => files().filter((f) => parseBackupName(f));

  test('1. cartella montata: verifica connessione completa senza toccare file estranei', async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'foto-vacanze.jpg'), 'non toccare');
    const r = await client.req('POST', '/api/admin/backups/network/test', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true, JSON.stringify(r.data.checks));
    for (const n of ['Cartella montata nel container', 'Cartella di destinazione', 'Permessi di lettura e scrittura', 'Creazione e lettura di un file temporaneo', 'Eliminazione del file temporaneo', 'Spazio disponibile']) {
      assert.ok(r.data.checks.find((c) => c.name === n && c.ok), n);
    }
    assert.ok(r.data.space.free > 0);
    assert.deepEqual(files(), ['foto-vacanze.jpg'], 'solo il file di prova creato e rimosso');
    assert.equal(readFileSync(join(dir(), 'foto-vacanze.jpg'), 'utf8'), 'non toccare');
  });

  test('2. cartella inesistente (volume non montato): errore chiaro, nuovo tentativo programmato, gioco non bloccato', async () => {
    cleanup(root);
    const t = await client.req('POST', '/api/admin/backups/network/test', {});
    assert.equal(t.data.ok, false);
    assert.match(t.data.checks[0].detail, /Nessuna cartella montata/);
    const c = await client.req('POST', '/api/admin/backups/network', {});
    assert.equal(c.status, 409);
    const st = nb().state();
    assert.equal(st.lastStatus, 'error');
    assert.equal(st.failures, 1);
    assert.ok(Date.parse(st.nextRetryAt) > Date.now());
    const list = await client.req('GET', '/api/admin/backups/network');
    assert.equal(list.data.mounted, false);
    // Il gioco continua a funzionare.
    app.engine.startManual();
    assert.equal(app.engine.running, true);
  });

  test('3. cartella senza permessi di scrittura: verifica e backup falliscono, il backup precedente resta intatto', async (t) => {
    if (process.getuid?.() === 0) { t.skip('eseguito come root: i permessi non si possono negare'); return; }
    const first = await nb().create('manual');
    const before = readFileSync(join(dir(), first.file));
    chmodSync(dir(), 0o555);
    const r = await nb().test();
    assert.equal(r.ok, false);
    assert.ok(r.checks.some((c) => !c.ok && /permesso negato|EACCES/.test(c.detail)));
    await assert.rejects(() => nb().create('manual'), /permesso negato|EACCES/);
    chmodSync(dir(), 0o755);
    assert.deepEqual(readFileSync(join(dir(), first.file)), before);
    assert.equal(archives().length, 1);
    assert.equal(nb().state().lastStatus, 'error');
  });

  test('4. cartella temporaneamente non raggiungibile: nuovo tentativo controllato e ripresa; timeout gestito', async () => {
    app.adminSettings.set('networkBackup', { ...nb().conf(), enabled: true, frequency: 'hourly' });
    const away = `${root}-staccata`;
    renameSync(root, away);
    const now = new Date();
    assert.equal(await nb().tick(now), null);
    const st = nb().state();
    assert.equal(st.lastStatus, 'error');
    assert.equal(nb().due(new Date(now.getTime() + 60000)), false, 'nessun tentativo prima del ritardo');
    renameSync(away, root);
    const later = new Date(Date.parse(st.nextRetryAt) + 1000);
    const ok = await nb().tick(later);
    assert.ok(ok?.file, 'backup riuscito al nuovo tentativo');
    assert.equal(nb().state().failures, 0);
    // Una chiamata che non risponde mai (condivisione bloccata) scade invece di bloccare il servizio.
    await assert.rejects(() => nb().t(new Promise(() => {}), 'Prova', 50), /non risponde \(timeout/);
  });

  test('5. backup manuale: archivio, manifest con versione, schema, contenuto e checksum; niente segreti in chiaro', async () => {
    addTrainer('ash');
    const r = await client.req('POST', '/api/admin/backups/network', { note: 'prima del torneo' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const meta = parseBackupName(r.data.file);
    assert.equal(meta.kind, 'manual');
    assert.equal(meta.version, app.config.version);
    const gz = readFileSync(join(dir(), r.data.file));
    const m = JSON.parse(readFileSync(join(dir(), manifestName(r.data.file)), 'utf8'));
    assert.equal(m.format, 'livecatch-backup');
    assert.equal(m.app.version, app.config.version);
    assert.equal(m.schemaVersion, app.db.schemaVersion());
    assert.equal(m.archive.sha256, sha(gz));
    assert.equal(m.archive.size, gz.length);
    assert.equal(m.contents.trainers, 1);
    assert.equal(m.note, 'prima del torneo');
    assert.ok(m.excludes.some((x) => /secret\.key/.test(x)));
    const raw = gunzipSync(gz);
    assert.equal(m.sqlite.sha256, sha(raw));
    const tmp = join(ctx.dir, 'check.sqlite');
    writeFileSync(tmp, raw);
    const d = new DatabaseSync(tmp, { readOnly: true });
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n, 0, 'nessuna sessione di accesso nel backup');
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'networkBackupState'").get().n, 0);
    d.close();
    assert.ok(!files().some((f) => f.includes('.partial')), 'nessun file temporaneo rimasto');
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'backup_network_create'"));
  });

  test('6. backup automatico programmato: orario, nessun duplicato inutile, nuovo backup dopo una modifica', async () => {
    const put = await client.req('PUT', '/api/admin/backups/network/settings', { enabled: true, frequency: 'daily', hour: 3, keep: 5 });
    assert.equal(put.status, 200);
    const day1early = new Date(2030, 0, 10, 2, 0);
    assert.equal(nb().due(day1early), false, 'prima dell\'orario');
    const at = (d) => { nb().now = () => d; return d; };
    const day1 = at(new Date(2030, 0, 10, 3, 5));
    const a = await nb().tick(day1);
    assert.ok(a.file);
    assert.equal(parseBackupName(a.file).kind, 'auto');
    assert.equal(nb().due(new Date(2030, 0, 10, 20, 0)), false, 'già fatto oggi');
    const b = await nb().tick(at(new Date(2030, 0, 11, 3, 5)));
    assert.equal(b.skipped, true, 'nessuna modifica: niente duplicato');
    addTrainer('misty');
    const c = await nb().tick(at(new Date(2030, 0, 12, 3, 5)));
    assert.ok(c.file, 'dati cambiati: nuovo backup');
    assert.equal(archives().length, 2);
  });

  test('7. database in modalità WAL: il backup contiene anche le scritture non ancora trasferite nel file principale', async () => {
    assert.equal(app.db.get('PRAGMA journal_mode').journal_mode, 'wal');
    app.db.prepare('PRAGMA wal_autocheckpoint = 0').get();
    for (let i = 0; i < 50; i++) addTrainer(`wal${i}`);
    assert.ok(existsSync(`${app.config.dbPath}-wal`));
    const r = await nb().create('manual');
    const raw = gunzipSync(readFileSync(join(dir(), r.file)));
    const tmp = join(ctx.dir, 'wal.sqlite');
    writeFileSync(tmp, raw);
    const d = new DatabaseSync(tmp, { readOnly: true });
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM twitch_users WHERE login LIKE 'wal%'").get().n, 50);
    assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    d.close();
  });

  test('8–9. verifica dei checksum; backup alterato, incompleto o troncato rifiutato', async () => {
    const r = await nb().create('manual');
    const ok = await client.req('POST', `/api/admin/backups/network/${r.file}/verify`, {});
    assert.equal(ok.data.ok, true);
    assert.equal(ok.data.compatible, true);
    // Alterazione di un byte.
    const p = join(dir(), r.file);
    const buf = readFileSync(p);
    buf[buf.length - 20] ^= 0xff;
    writeFileSync(p, buf);
    const bad = await client.req('POST', `/api/admin/backups/network/${r.file}/verify`, {});
    assert.equal(bad.data.ok, false);
    assert.ok(bad.data.checks.some((c) => !c.ok && /Checksum/.test(c.name)));
    const res = await client.req('POST', `/api/admin/backups/network/${r.file}/restore`, { confirm: 'RIPRISTINA', sha256: 'x' });
    assert.equal(res.status, 422);
    // Archivio senza manifest = incompleto.
    const r2 = await nb().create('manual');
    unlinkSync(join(dir(), manifestName(r2.file)));
    const list = await client.req('GET', '/api/admin/backups/network');
    assert.equal(list.data.items.find((x) => x.file === r2.file).status, 'incomplete');
    assert.equal((await client.req('POST', `/api/admin/backups/network/${r2.file}/restore`, { confirm: 'RIPRISTINA', sha256: 'x' })).status, 422);
    // Archivio troncato (dimensione diversa dal manifest).
    const r3 = await nb().create('manual');
    const p3 = join(dir(), r3.file);
    writeFileSync(p3, readFileSync(p3).subarray(0, 100));
    const l3 = await client.req('GET', '/api/admin/backups/network');
    assert.equal(l3.data.items.find((x) => x.file === r3.file).status, 'corrupt');
  });

  test('10–11. conservazione: restano gli ultimi N automatici, mai l\'ultimo valido, mai manuali o file estranei', async () => {
    app.adminSettings.set('networkBackup', { ...nb().conf(), keep: 2 });
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'appunti.txt'), 'estraneo');
    writeFileSync(join(dir(), 'livecatch-20200101-000000-auto-vX.sqlite.gz.bak'), 'estraneo');
    const manual = await nb().create('manual');
    const autos = [];
    for (let i = 0; i < 4; i++) {
      addTrainer(`r${i}`);
      nb().now = () => new Date(2030, 0, 1 + i, 4, 0);
      autos.push((await nb().create('auto')).file);
    }
    const left = archives();
    assert.ok(left.includes(manual.file), 'manuale conservato');
    assert.deepEqual(left.filter((f) => parseBackupName(f).kind === 'auto').sort(), autos.slice(2).sort());
    assert.ok(files().includes('appunti.txt'));
    assert.ok(files().includes('livecatch-20200101-000000-auto-vX.sqlite.gz.bak'));
    // Unico backup valido: non si elimina.
    for (const f of archives()) if (f !== autos[3]) { const del = await client.req('DELETE', `/api/admin/backups/network/${f}`); assert.equal(del.status, 200); }
    const last = await client.req('DELETE', `/api/admin/backups/network/${autos[3]}`);
    assert.equal(last.status, 409);
    assert.match(last.data.error, /unico backup valido/);
    app.adminSettings.set('networkBackup', { ...nb().conf(), keep: 1 });
    await nb().retention();
    assert.deepEqual(archives(), [autos[3]]);
  });

  const restore = async (file) => {
    const v = await client.req('POST', `/api/admin/backups/network/${file}/verify`, {});
    return client.req('POST', `/api/admin/backups/network/${file}/restore`, { confirm: 'RIPRISTINA', sha256: v.data.manifest.archive.sha256 });
  };

  test('12. ripristino corretto con backup di sicurezza; sessione admin e impostazioni di rete conservate', async () => {
    addTrainer('ash');
    app.adminSettings.set('networkBackup', { ...nb().conf(), keep: 7 });
    const b = await nb().create('manual');
    addTrainer('dopo');
    app.adminSettings.set('networkBackup', { ...nb().conf(), keep: 9 });
    const noConfirm = await client.req('POST', `/api/admin/backups/network/${b.file}/restore`, { sha256: 'x' });
    assert.equal(noConfirm.status, 400);
    const r = await restore(b.file);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.integrity, true);
    assert.match(r.data.safetyBackup, /pre-restore/);
    assert.ok(existsSync(join(app.config.backupsDir, r.data.safetyBackup)), '14. backup di sicurezza creato prima del ripristino');
    assert.ok(app.db.get("SELECT 1 FROM twitch_users WHERE login = 'ash'"));
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM twitch_users WHERE login = 'dopo'").n, 0);
    assert.equal(nb().conf().keep, 9, 'impostazioni della cartella di rete conservate');
    assert.equal((await client.req('GET', '/api/admin/game')).status, 200, 'la sessione dell\'amministratore resta valida');
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'restore'"));
  });

  test('13. ripristino fallito durante l\'aggiornamento: ritorno automatico ai dati precedenti', async () => {
    addTrainer('prima');
    const b = await nb().create('manual');
    // Backup che supera i controlli ma fa fallire la migrazione (schema dichiarato 3 con le colonne delle versioni successive).
    const p = join(dir(), b.file);
    const tmp = join(ctx.dir, 'broken.sqlite');
    writeFileSync(tmp, gunzipSync(readFileSync(p)));
    const d = new DatabaseSync(tmp);
    d.exec('DELETE FROM schema_migrations WHERE id >= 4;');
    d.close();
    const raw = readFileSync(tmp);
    const gz = gzipSync(raw);
    writeFileSync(p, gz);
    const mp = join(dir(), manifestName(b.file));
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    Object.assign(m, { schemaVersion: 3, archive: { size: gz.length, sha256: sha(gz) }, sqlite: { size: raw.length, sha256: sha(raw) } });
    writeFileSync(mp, JSON.stringify(m));
    addTrainer('attuale');
    const r = await restore(b.file);
    assert.equal(r.status, 500);
    assert.match(r.data.error, /ripristinati automaticamente/);
    assert.ok(app.db.get("SELECT 1 FROM twitch_users WHERE login = 'attuale'"), 'dati attuali intatti');
    assert.equal(app.db.schemaVersion(), LATEST_SCHEMA);
    assert.equal(app.db.integrityCheck(), true);
    assert.ok(app.db.get("SELECT 1 FROM admin_audit WHERE action = 'restore_failed'"));
  });

  test('15. compatibilità: backup di una versione più recente rifiutato con un messaggio chiaro', async () => {
    const b = await nb().create('manual');
    const p = join(dir(), b.file);
    const tmp = join(ctx.dir, 'future.sqlite');
    writeFileSync(tmp, gunzipSync(readFileSync(p)));
    const d = new DatabaseSync(tmp);
    d.exec("INSERT INTO schema_migrations (id, name) VALUES (99, 'futuro');");
    d.close();
    const raw = readFileSync(tmp);
    const gz = gzipSync(raw);
    writeFileSync(p, gz);
    const mp = join(dir(), manifestName(b.file));
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    Object.assign(m, { schemaVersion: 99, app: { version: '9.0.0' }, archive: { size: gz.length, sha256: sha(gz) }, sqlite: { size: raw.length, sha256: sha(raw) } });
    writeFileSync(mp, JSON.stringify(m));
    const v = await client.req('POST', `/api/admin/backups/network/${b.file}/verify`, {});
    assert.equal(v.data.ok, false);
    assert.equal(v.data.compatible, false);
    assert.match(JSON.stringify(v.data.checks), /versione più recente/);
    const r = await client.req('POST', `/api/admin/backups/network/${b.file}/restore`, { confirm: 'RIPRISTINA', sha256: m.archive.sha256 });
    assert.equal(r.status, 422);
    assert.equal(app.db.schemaVersion(), LATEST_SCHEMA);
  });

  test('16. ripristino con sessione manuale attiva: la sessione viene chiusa in modo controllato', async () => {
    const b = await nb().create('manual');
    app.engine.startManual();
    const sid = app.engine.session.id;
    const r = await restore(b.file);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.stoppedSessions, [sid]);
    assert.equal(app.engine.mode, null);
    // La sessione è stata chiusa (motivo "restore") prima del backup di sicurezza: lo stato
    // precedente al ripristino la contiene chiusa correttamente.
    const tmp = join(ctx.dir, 'safety.sqlite');
    writeFileSync(tmp, gunzipSync(readFileSync(join(app.config.backupsDir, r.data.safetyBackup))));
    const d = new DatabaseSync(tmp, { readOnly: true });
    const s = d.prepare('SELECT kind, end_reason FROM stream_sessions WHERE id = ?').get(sid);
    assert.deepEqual({ ...s }, { kind: 'manual', end_reason: 'restore' });
    assert.ok(d.prepare("SELECT 1 FROM admin_audit WHERE action = 'manual_session_stop' AND target_id = ?").get(String(sid)));
    d.close();
  });

  test('18. riavvio del container dopo il ripristino: dati ripristinati e app funzionante', async () => {
    addTrainer('persistente');
    const b = await nb().create('manual');
    app.db.run("DELETE FROM twitch_users WHERE login = 'persistente'");
    assert.equal((await restore(b.file)).status, 200);
    await app.close();
    ({ app } = await makeApp({ dir: ctx.dir, configureTwitch: false, env: { BACKUP_TARGET_ROOT: root } }));
    assert.ok(app.db.get("SELECT 1 FROM twitch_users WHERE login = 'persistente'"));
    assert.equal(app.db.integrityCheck(), true);
    assert.equal(app.db.schemaVersion(), LATEST_SCHEMA);
  });

  test('sicurezza: path traversal, sottocartelle non valide e collegamenti simbolici fuori dalla cartella', async () => {
    for (const bad of ['../etc', 'a/../../b', '/assoluto/..', 'a\\b', 'a b']) {
      const r = await client.req('PUT', '/api/admin/backups/network/settings', { subdir: bad });
      assert.equal(r.status, 400, bad);
    }
    for (const name of ['..%2F..%2Fetc%2Fpasswd', 'livecatch-x.sqlite.gz', '%2e%2e']) {
      const r = await client.req('POST', `/api/admin/backups/network/${name}/verify`, {});
      // 405: il router normalizza "/x/../verify" in un altro percorso, nessun file raggiunto.
      assert.ok([400, 404, 405].includes(r.status), `${name}: ${r.status}`);
    }
    const outside = tempDir();
    symlinkSync(outside, join(root, 'fuga'));
    assert.equal((await client.req('PUT', '/api/admin/backups/network/settings', { subdir: 'fuga' })).status, 200);
    const t = await nb().test();
    assert.equal(t.ok, false);
    assert.match(JSON.stringify(t.checks), /collegamento simbolico/);
    await assert.rejects(() => nb().create('manual'), /collegamento simbolico/);
    assert.deepEqual(readdirSync(outside), []);
    cleanup(outside);
    // Senza login nessuna operazione.
    assert.equal((await client.req('GET', '/api/admin/backups/network', undefined, { auth: false })).status, 401);
    assert.equal((await client.req('POST', '/api/admin/backups/network', {}, { csrfToken: 'no' })).status, 403);
  });
});

describe('Backup su cartella di rete: ripristino durante una diretta Twitch', () => {
  test('17. rifiutato con sessione Twitch attiva, nessun dato modificato', async () => {
    const root = tempDir();
    const tw = new FakeTwitch();
    const es = await new FakeEventSub().start();
    const ctx = await makeApp({ twitch: tw, eventsub: es, env: { BACKUP_TARGET_ROOT: root } });
    const app = ctx.app;
    try {
      seedPokemon(app.db);
      const b = await app.networkBackups.create('manual');
      await app.monitor.start();
      await waitFor(() => app.sm.state === 'OFFLINE');
      tw.live = { id: 'live-1' };
      es.notify('stream.online', { id: 'live-1', broadcaster_user_id: BROADCASTER_ID, type: 'live', started_at: new Date().toISOString() });
      await waitFor(() => app.engine.mode === 'live');
      const client = await adminClient(app);
      const v = await client.req('POST', `/api/admin/backups/network/${b.file}/verify`, {});
      const r = await client.req('POST', `/api/admin/backups/network/${b.file}/restore`, { confirm: 'RIPRISTINA', sha256: v.data.manifest.archive.sha256 });
      assert.equal(r.status, 409);
      assert.match(r.data.error, /durante una diretta/);
      assert.equal(app.engine.mode, 'live');
      assert.ok(app.engine.sessions.current('twitch'));
    } finally {
      await app.close();
      await es.stop();
      cleanup(ctx.dir);
      cleanup(root);
    }
  });
});
