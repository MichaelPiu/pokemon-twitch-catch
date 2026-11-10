// Backup su una cartella di rete montata nel container (NAS, altro server,
// condivisione SMB/NFS, disco esterno). Il container NON monta condivisioni da
// solo: la cartella deve essere un volume Docker. Su umbrelOS 2.x si sceglie
// nelle impostazioni dell'app ("Cartella dei backup", folderAccess) e compare
// nel container in BACKUP_TARGET_ROOT (default /backups-network).
//
// Ogni backup è una coppia di file nella cartella di destinazione:
//   livecatch-AAAAMMGG-HHMMSS-<tipo>[-n]-v<versione>.sqlite.gz   archivio
//   livecatch-AAAAMMGG-HHMMSS-<tipo>[-n]-v<versione>.manifest.json  manifest
// Il manifest (scritto per ultimo) contiene versione dell'app, schema, contenuto
// e checksum SHA-256: un archivio senza manifest è "incompleto" e non viene mai
// ripristinato. File con nomi diversi non vengono mai toccati.
//
// Tutte le operazioni sulla cartella sono asincrone e con timeout: una
// condivisione bloccata non ferma il gioco. Un'operazione alla volta.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp, existsSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA, schemaTooNewMessage } from '../database/migrations.js';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export const BACKUP_FORMAT = 'livecatch-backup';
export const KINDS = ['auto', 'manual', 'pre-update', 'pre-restore'];
const FILE_RE = /^livecatch-(\d{8})-(\d{6})-(auto|manual|pre-update|pre-restore)(?:-(\d{1,3}))?-v([0-9A-Za-z.+-]{1,40})\.sqlite\.gz$/;
const SUBDIR_RE = /^[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64}){0,3}$/;
export const FREQUENCIES = { hourly: 1, every6h: 6, every12h: 12, daily: 24, weekly: 168 };

// Tabelle escluse dall'impronta del contenuto (cambiano senza che i dati di gioco
// cambino) e righe rimosse dalla copia di backup (sessioni di accesso).
const VOLATILE_TABLES = new Set(['admin_sessions', 'twitch_events', 'state_transitions', 'backup_history', 'schema_migrations']);
const VOLATILE_SETTINGS = ['networkBackupState'];

export const NETWORK_DEFAULTS = {
  enabled: false, // backup automatici sulla cartella di rete
  subdir: 'livecatch', // sottocartella dentro la cartella montata
  frequency: 'daily',
  hour: 3, // per daily/weekly: ora locale dalla quale il backup è dovuto
  keep: 14, // backup automatici da conservare (i manuali restano finché non li elimini)
  beforeUpdate: true, // copia anche il backup fatto prima di un aggiornamento dello schema
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

export class BackupError extends Error {
  constructor(message, code = 'error') { super(message); this.code = code; }
}

// Promessa con limite di tempo: su una condivisione bloccata la chiamata al
// filesystem può non tornare mai; il servizio la considera fallita e va avanti.
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new BackupError(`${what}: la cartella non risponde (timeout ${Math.round(ms / 1000)} s)`, 'timeout')), ms); t.unref?.(); }),
  ]).finally(() => clearTimeout(t));
}

function fsError(e, what) {
  if (e instanceof BackupError) return e;
  const map = {
    ENOENT: 'non esiste', EACCES: 'permesso negato', EPERM: 'operazione non permessa', EROFS: 'filesystem in sola lettura',
    ENOSPC: 'spazio esaurito', EDQUOT: 'quota esaurita', EIO: 'errore di I/O', ENOTCONN: 'condivisione non connessa',
    ESTALE: 'condivisione non più valida (stale)', EHOSTDOWN: 'server non raggiungibile', ETIMEDOUT: 'timeout', ENOTDIR: 'non è una cartella',
  };
  return new BackupError(`${what}: ${map[e?.code] || e?.message || e}${e?.code ? ` (${e.code})` : ''}`, e?.code || 'error');
}

export function parseBackupName(name) {
  const m = FILE_RE.exec(String(name));
  if (!m || basename(name) !== name) return null;
  return { date: m[1], time: m[2], kind: m[3], seq: m[4] ? Number(m[4]) : 0, version: m[5] };
}

export function manifestName(archive) { return archive.replace(/\.sqlite\.gz$/, '.manifest.json'); }

// Controlli su un database SQLite (file temporaneo locale): integrità, tabelle
// dell'app, schema non più recente di quello supportato.
export function inspectSqliteFile(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    if (d.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new BackupError('Database danneggiato (integrity_check)', 'corrupt');
    const t = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('twitch_users','user_pokemon','pokemon','schema_migrations')").all();
    if (t.length < 4) throw new BackupError('Il database non appartiene a Live Catch', 'foreign');
    const schema = d.prepare('SELECT MAX(id) AS v FROM schema_migrations').get()?.v ?? 0;
    return { schema, contents: contentSummary(d) };
  } finally { d.close(); }
}

function has(d, table) { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table); }
function count(d, sql) { try { return d.prepare(sql).get().n; } catch { return null; } }

export function contentSummary(d) {
  const kindCol = has(d, 'stream_sessions') && d.prepare('PRAGMA table_info(stream_sessions)').all().some((c) => c.name === 'kind');
  return {
    trainers: count(d, 'SELECT COUNT(*) AS n FROM twitch_users WHERE is_demo = 0'),
    pokedexEntries: count(d, 'SELECT COUNT(*) AS n FROM user_pokemon WHERE is_demo = 0'),
    pokemon: count(d, 'SELECT COUNT(*) AS n FROM pokemon'),
    sessionsTwitch: count(d, kindCol ? "SELECT COUNT(*) AS n FROM stream_sessions WHERE kind = 'twitch'" : 'SELECT COUNT(*) AS n FROM stream_sessions WHERE is_demo = 0'),
    sessionsManual: kindCol ? count(d, "SELECT COUNT(*) AS n FROM stream_sessions WHERE kind = 'manual'") : 0,
    captureAttempts: count(d, 'SELECT COUNT(*) AS n FROM capture_attempts WHERE is_demo = 0'),
    themes: has(d, 'overlay_themes') ? count(d, 'SELECT COUNT(*) AS n FROM overlay_themes') : 0,
    settings: count(d, 'SELECT (SELECT COUNT(*) FROM game_settings) + (SELECT COUNT(*) FROM overlay_settings) + (SELECT COUNT(*) FROM command_settings) AS n'),
  };
}

// Impronta del contenuto di gioco: serve a non creare backup automatici identici.
export function contentFingerprint(db) {
  const h = createHash('sha256');
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  for (const t of tables) {
    if (VOLATILE_TABLES.has(t)) continue;
    h.update(`\u0000${t}\u0000`);
    const where = t === 'admin_settings' ? `WHERE key NOT IN (${VOLATILE_SETTINGS.map(() => '?').join(',')})` : '';
    const rows = db.prepare(`SELECT * FROM "${t}" ${where} ORDER BY rowid`).iterate(...(t === 'admin_settings' ? VOLATILE_SETTINGS : []));
    for (const row of rows) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

export class NetworkBackupService {
  constructor({ db, config, adminSettings, log, version, timers = true }) {
    this.db = db; // getter: l'app riapre il database dopo un ripristino
    this.config = config;
    this.settings = adminSettings;
    this.log = log;
    this.version = version;
    this.timersEnabled = timers;
    this.root = resolve(config.backupTargetRoot);
    this.timeoutMs = config.backupTimeoutMs;
    this.tmpDir = join(config.dataDir, 'tmp');
    this.busy = null;
    this.timer = null;
    this.now = () => new Date();
  }

  conf() { return { ...NETWORK_DEFAULTS, ...(this.settings.get('networkBackup') || {}) }; }
  state() { return { lastRunAt: null, lastStatus: null, lastSuccessAt: null, lastFile: null, lastError: null, failures: 0, nextRetryAt: null, lastAutoAt: null, ...(this.settings.get('networkBackupState') || {}) }; }
  setState(patch) { this.settings.set('networkBackupState', { ...this.state(), ...patch }); }

  static validateSettings(input, cur = NETWORK_DEFAULTS) {
    const out = { ...NETWORK_DEFAULTS, ...cur };
    const bad = (m) => { throw new BackupError(m, 'invalid'); };
    if (input.enabled !== undefined) out.enabled = input.enabled === true || input.enabled === 'true' || input.enabled === 1;
    if (input.subdir !== undefined) {
      const s = String(input.subdir).trim().replace(/^\/+|\/+$/g, '');
      if (!SUBDIR_RE.test(s) || s.split('/').some((x) => x === '.' || x === '..')) bad('Sottocartella non valida: usa solo lettere, numeri, . _ - e al massimo 4 livelli (niente "..")');
      out.subdir = s;
    }
    if (input.frequency !== undefined) { if (!FREQUENCIES[input.frequency]) bad('Frequenza non valida'); out.frequency = input.frequency; }
    const int = (k, min, max, label) => {
      if (input[k] === undefined) return;
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < min || n > max) bad(`${label}: valore tra ${min} e ${max}`);
      out[k] = n;
    };
    int('hour', 0, 23, 'Ora');
    int('keep', 1, 365, 'Backup da conservare');
    if (input.beforeUpdate !== undefined) out.beforeUpdate = input.beforeUpdate === true || input.beforeUpdate === 'true' || input.beforeUpdate === 1;
    return out;
  }

  // Cartella di destinazione, sempre dentro la cartella montata (nessun percorso arbitrario).
  targetDir(subdir = this.conf().subdir) {
    const dir = resolve(this.root, subdir);
    if (dir !== this.root && !dir.startsWith(this.root + sep)) throw new BackupError('Percorso fuori dalla cartella dei backup', 'invalid');
    return dir;
  }

  async ensureInsideRoot(dir) {
    // Un collegamento simbolico non deve portare fuori dalla cartella montata.
    const [realRoot, realDir] = await Promise.all([fsp.realpath(this.root), fsp.realpath(dir)]);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) throw new BackupError('La cartella di destinazione esce dalla cartella montata (collegamento simbolico)', 'invalid');
  }

  fileIn(dir, name) {
    if (!parseBackupName(name)) throw new BackupError('Nome di backup non valido', 'invalid');
    return join(dir, name);
  }

  run(fn) {
    if (this.busy) throw new BackupError('Un\'altra operazione di backup è in corso: riprova tra poco', 'busy');
    const p = (async () => fn())();
    this.busy = p;
    return p.finally(() => { this.busy = null; });
  }

  t(promise, what, ms = this.timeoutMs) { return withTimeout(promise, ms, what).catch((e) => { throw fsError(e, what); }); }

  async rootStatus() {
    try {
      const st = await this.t(fsp.stat(this.root), 'Cartella montata');
      if (!st.isDirectory()) return { mounted: false, error: `${this.root} non è una cartella` };
      return { mounted: true };
    } catch (e) {
      if (e.code === 'ENOENT') return { mounted: false, error: `Nessuna cartella montata in ${this.root}. Su Umbrel scegli la "Cartella dei backup" nelle impostazioni dell'app; con Docker monta un volume su ${this.root}.` };
      return { mounted: false, error: e.message };
    }
  }

  // --- Verifica connessione ---------------------------------------------------
  // Non cancella né modifica nulla nella cartella, tranne il proprio file di prova.
  async test() {
    const checks = [];
    const add = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
    const root = await this.rootStatus();
    if (!add('Cartella montata nel container', root.mounted, root.mounted ? this.root : root.error)) return { ok: false, root: this.root, checks };
    let dir;
    try { dir = this.targetDir(); } catch (e) { add('Percorso di destinazione', false, e.message); return { ok: false, root: this.root, checks }; }
    try {
      await this.t(fsp.mkdir(dir, { recursive: true }), 'Creazione della sottocartella');
      await this.ensureInsideRoot(dir);
      add('Cartella di destinazione', true, dir);
    } catch (e) { add('Cartella di destinazione', false, e.message); return { ok: false, root: this.root, dir, checks }; }
    try { await this.t(fsp.access(dir, 2 | 4), 'Permessi'); add('Permessi di lettura e scrittura', true, 'ok'); } catch (e) { add('Permessi di lettura e scrittura', false, e.message); }
    const probe = join(dir, `.livecatch-write-test-${randomBytes(6).toString('hex')}`);
    const data = randomBytes(64);
    try {
      await this.t(fsp.writeFile(probe, data, { flag: 'wx' }), 'Scrittura del file di prova');
      const back = await this.t(fsp.readFile(probe), 'Lettura del file di prova');
      add('Creazione e lettura di un file temporaneo', back.equals(data), back.equals(data) ? 'ok' : 'contenuto riletto diverso');
    } catch (e) { add('Creazione e lettura di un file temporaneo', false, e.message); }
    try {
      if (existsSync(probe)) { await this.t(fsp.unlink(probe), 'Eliminazione del file di prova'); }
      add('Eliminazione del file temporaneo', !existsSync(probe), 'ok');
    } catch (e) { add('Eliminazione del file temporaneo', false, e.message); }
    let space = null;
    try {
      const s = await this.t(fsp.statfs(dir), 'Spazio disponibile');
      space = { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
      add('Spazio disponibile', true, `${Math.round(space.free / 1048576)} MiB liberi`);
    } catch (e) { add('Spazio disponibile', true, `non rilevabile (${e.message})`); }
    return { ok: checks.every((c) => c.ok), root: this.root, dir, space, checks };
  }

  // --- Creazione --------------------------------------------------------------
  create(kind = 'manual', { note = null, admin = null, force = false } = {}) {
    if (!KINDS.includes(kind)) throw new BackupError('Tipo di backup non valido', 'invalid');
    return this.run(() => this.#create(kind, { note, admin, force }));
  }

  async #create(kind, { note, admin, force }) {
    const started = this.now();
    this.setState({ lastRunAt: started.toISOString() });
    let tmpDb = null;
    let partial = null;
    let manifestPartial = null;
    try {
      const root = await this.rootStatus();
      if (!root.mounted) throw new BackupError(root.error, 'not_mounted');
      const dir = this.targetDir();
      await this.t(fsp.mkdir(dir, { recursive: true }), 'Creazione della cartella di destinazione');
      await this.ensureInsideRoot(dir);

      const fingerprint = contentFingerprint(this.db());
      if (kind === 'auto' && !force) {
        const last = (await this.list({ dir })).find((b) => b.status === 'ok');
        if (last?.manifest?.fingerprint === fingerprint) {
          this.setState({ lastStatus: 'unchanged', lastError: null, failures: 0, nextRetryAt: null, lastAutoAt: started.toISOString() });
          this.log.info('Backup automatico non necessario: nessuna modifica dall\'ultimo backup', { last: last.file });
          return { skipped: true, reason: 'unchanged', last: last.file };
        }
      }

      // 1. Istantanea coerente (anche con WAL) in un file locale, non sulla rete.
      mkdirSync(this.tmpDir, { recursive: true });
      tmpDb = join(this.tmpDir, `netbackup-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);
      this.db().prepare('VACUUM INTO ?').run(tmpDb);
      // 2. La copia non contiene sessioni di accesso né lo stato interno dei backup.
      const d = new DatabaseSync(tmpDb);
      try {
        d.exec('DELETE FROM admin_sessions;');
        d.prepare(`DELETE FROM admin_settings WHERE key IN (${VOLATILE_SETTINGS.map(() => '?').join(',')})`).run(...VOLATILE_SETTINGS);
        d.exec('VACUUM;');
      } finally { d.close(); }
      const info = inspectSqliteFile(tmpDb);
      const raw = readFileSync(tmpDb);
      const gz = await gzip(raw, { level: 6 });

      // 3. Nome univoco, scrittura su file temporaneo, rilettura e verifica, rinomina atomica.
      const base = `livecatch-${stamp(started)}-${kind}`;
      const existing = new Set(await this.t(fsp.readdir(dir), 'Lettura della cartella'));
      let name = `${base}-v${this.version}.sqlite.gz`;
      for (let i = 1; existing.has(name) || existing.has(manifestName(name)); i++) name = `${base}-${i}-v${this.version}.sqlite.gz`;
      const final = join(dir, name);
      partial = join(dir, `.livecatch-tmp-${randomBytes(6).toString('hex')}.partial`);
      const ms = Math.max(this.timeoutMs, Math.ceil(gz.length / (256 * 1024)) * 1000); // almeno 256 KiB/s
      await this.t((async () => {
        const fh = await fsp.open(partial, 'wx');
        try { await fh.writeFile(gz); await fh.sync(); } finally { await fh.close(); }
      })(), 'Scrittura del backup', ms);
      const back = await this.t(fsp.readFile(partial), 'Verifica del backup scritto', ms);
      if (back.length !== gz.length || sha256(back) !== sha256(gz)) throw new BackupError('Il file scritto sulla cartella di rete non corrisponde: backup scartato', 'verify_failed');
      await this.t(fsp.rename(partial, final), 'Rinomina del backup');
      partial = null;

      const manifest = {
        format: BACKUP_FORMAT,
        formatVersion: 1,
        file: name,
        kind,
        createdAt: started.toISOString(),
        app: { name: 'Pokémon Live Catch', version: this.version },
        schemaVersion: info.schema,
        archive: { size: gz.length, sha256: sha256(gz) },
        sqlite: { size: raw.length, sha256: sha256(raw) },
        fingerprint,
        contents: info.contents,
        includes: ['database SQLite completo (Pokédex, catture, statistiche, sessioni Twitch e manuali, impostazioni di gioco, temi e impostazioni overlay, comandi, Poké Ball, ricompense, registro operazioni)'],
        excludes: ['sessioni di accesso alla dashboard', 'chiave di cifratura secret.key', 'immagini dei Pokémon (si riscaricano dalla dashboard)', 'log'],
        secrets: 'Le credenziali Twitch sono incluse solo cifrate (AES-256-GCM): la chiave secret.key non è nel backup. Su un altro server ricollega l\'account Twitch dopo il ripristino.',
        note: note ? String(note).slice(0, 200) : null,
        createdBy: admin,
      };
      const mBuf = Buffer.from(JSON.stringify(manifest, null, 2));
      manifestPartial = join(dir, `.livecatch-tmp-${randomBytes(6).toString('hex')}.partial`);
      await this.t((async () => {
        const fh = await fsp.open(manifestPartial, 'wx');
        try { await fh.writeFile(mBuf); await fh.sync(); } finally { await fh.close(); }
      })(), 'Scrittura del manifest');
      await this.t(fsp.rename(manifestPartial, join(dir, manifestName(name))), 'Rinomina del manifest');
      manifestPartial = null;

      const patch = { lastStatus: 'ok', lastSuccessAt: started.toISOString(), lastFile: name, lastError: null, failures: 0, nextRetryAt: null };
      if (kind === 'auto') patch.lastAutoAt = started.toISOString();
      this.setState(patch);
      this.log.info(`Backup sulla cartella di rete: ${name}`, { size: gz.length, kind });
      let removed = [];
      if (kind === 'auto') {
        try { removed = (await this.#retention(dir)).removed; } catch (e) { this.log.warn('Pulizia dei backup vecchi non riuscita', { message: e.message }); }
      }
      return { file: name, size: gz.length, sha256: manifest.archive.sha256, schemaVersion: info.schema, removed };
    } catch (e) {
      const err = e instanceof BackupError ? e : fsError(e, 'Backup');
      const st = this.state();
      const failures = (st.failures || 0) + 1;
      const delayMin = Math.min(360, 5 * 2 ** Math.min(7, failures - 1)); // 5, 10, 20, … fino a 6 ore
      this.setState({ lastStatus: 'error', lastError: err.message, failures, nextRetryAt: new Date(this.now().getTime() + delayMin * 60000).toISOString() });
      this.log.error('Backup sulla cartella di rete non riuscito', { kind, message: err.message, nextRetryMin: delayMin });
      throw err;
    } finally {
      // Solo i propri file temporanei: il backup precedente resta intatto.
      for (const f of [partial, manifestPartial]) if (f) await fsp.unlink(f).catch(() => {});
      if (tmpDb && existsSync(tmpDb)) try { unlinkSync(tmpDb); } catch { /* ignora */ }
    }
  }

  // Copia nella cartella di rete un backup locale già creato (es. pre-migrazione).
  async copyLocal(localGzPath, kind, note) {
    return this.run(async () => {
      const root = await this.rootStatus();
      if (!root.mounted) throw new BackupError(root.error, 'not_mounted');
      const dir = this.targetDir();
      await this.t(fsp.mkdir(dir, { recursive: true }), 'Creazione della cartella di destinazione');
      await this.ensureInsideRoot(dir);
      const gz = readFileSync(localGzPath);
      const raw = await gunzip(gz);
      mkdirSync(this.tmpDir, { recursive: true });
      const tmp = join(this.tmpDir, `netcopy-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);
      let partial = null;
      try {
        await fsp.writeFile(tmp, raw);
        const info = inspectSqliteFile(tmp);
        const started = this.now();
        const ver = (note && /v([0-9A-Za-z.+-]{1,40})$/.exec(note)?.[1]) || this.version;
        const name = `livecatch-${stamp(started)}-${kind}-v${ver}.sqlite.gz`;
        partial = join(dir, `.livecatch-tmp-${randomBytes(6).toString('hex')}.partial`);
        await this.t(fsp.writeFile(partial, gz, { flag: 'wx' }), 'Scrittura del backup');
        await this.t(fsp.rename(partial, join(dir, name)), 'Rinomina del backup');
        partial = null;
        const manifest = {
          format: BACKUP_FORMAT, formatVersion: 1, file: name, kind, createdAt: started.toISOString(),
          app: { name: 'Pokémon Live Catch', version: ver }, schemaVersion: info.schema,
          archive: { size: gz.length, sha256: sha256(gz) }, sqlite: { size: raw.length, sha256: sha256(raw) },
          fingerprint: null, contents: info.contents, note: note || null,
          includes: ['database SQLite completo'], excludes: ['chiave di cifratura secret.key', 'immagini', 'log'],
          secrets: 'Credenziali Twitch incluse solo cifrate; secret.key non incluso.',
        };
        await this.t(fsp.writeFile(join(dir, manifestName(name)), JSON.stringify(manifest, null, 2), { flag: 'wx' }), 'Scrittura del manifest');
        this.log.info(`Backup ${kind} copiato sulla cartella di rete: ${name}`);
        return { file: name };
      } finally {
        if (partial) await fsp.unlink(partial).catch(() => {});
        if (existsSync(tmp)) try { unlinkSync(tmp); } catch { /* ignora */ }
      }
    });
  }

  // --- Elenco e verifica ------------------------------------------------------
  async list({ dir = null } = {}) {
    const d = dir || this.targetDir();
    let names;
    try { names = await this.t(fsp.readdir(d), 'Lettura della cartella'); } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const set = new Set(names);
    const out = [];
    for (const n of names) {
      const meta = parseBackupName(n);
      if (!meta) continue; // file estranei: ignorati e mai toccati
      const item = { file: n, kind: meta.kind, version: meta.version, createdAt: null, size: null, schemaVersion: null, status: 'incomplete', manifest: null, problem: null };
      try { item.size = (await this.t(fsp.stat(join(d, n)), 'Lettura del backup')).size; } catch (e) { item.problem = e.message; }
      const mn = manifestName(n);
      if (!set.has(mn)) { item.problem = item.problem || 'manifest mancante: backup incompleto'; out.push(item); continue; }
      try {
        const m = JSON.parse(await this.t(fsp.readFile(join(d, mn), 'utf8'), 'Lettura del manifest'));
        if (m.format !== BACKUP_FORMAT || m.file !== n || !/^[a-f0-9]{64}$/.test(m.archive?.sha256 || '')) throw new Error('manifest non valido');
        item.manifest = m;
        item.createdAt = m.createdAt;
        item.schemaVersion = m.schemaVersion;
        item.appVersion = m.app?.version;
        item.contents = m.contents;
        if (item.size !== m.archive.size) { item.status = 'corrupt'; item.problem = `dimensione ${item.size} diversa dal manifest (${m.archive.size})`; } else item.status = 'ok';
      } catch (e) { item.status = 'corrupt'; item.problem = e.message; }
      out.push(item);
    }
    const dt = (x) => `${parseBackupName(x.file).date}${parseBackupName(x.file).time}${String(parseBackupName(x.file).seq).padStart(3, '0')}`;
    return out.sort((a, b) => dt(b).localeCompare(dt(a)));
  }

  // Verifica completa: checksum dell'archivio e del database, integrità SQLite,
  // compatibilità dello schema. Ritorna anche il database decompresso se richiesto.
  async verify(name, { keepRaw = false } = {}) {
    const dir = this.targetDir();
    const file = this.fileIn(dir, name);
    const result = { file: name, ok: false, checks: [], manifest: null, compatible: false, warnings: [] };
    const add = (n, ok, detail) => { result.checks.push({ name: n, ok, detail }); return ok; };
    let m;
    try { m = JSON.parse(await this.t(fsp.readFile(join(dir, manifestName(name)), 'utf8'), 'Lettura del manifest')); } catch (e) {
      add('Manifest', false, e.code === 'ENOENT' ? 'manifest mancante: backup incompleto' : e.message); return result;
    }
    if (!add('Manifest', m.format === BACKUP_FORMAT && m.file === name && /^[a-f0-9]{64}$/.test(m.archive?.sha256 || ''), 'formato e nome')) return result;
    result.manifest = m;
    let gz;
    try { gz = await this.t(fsp.readFile(file), 'Lettura del backup', Math.max(this.timeoutMs, 120000)); } catch (e) { add('Archivio', false, e.message); return result; }
    if (!add('Dimensione', gz.length === m.archive.size, `${gz.length} byte`)) return result;
    if (!add('Checksum SHA-256 dell\'archivio', sha256(gz) === m.archive.sha256, m.archive.sha256)) return result;
    let raw;
    try { raw = await gunzip(gz); } catch { add('Decompressione', false, 'archivio gzip danneggiato'); return result; }
    if (!add('Checksum SHA-256 del database', sha256(raw) === m.sqlite?.sha256, m.sqlite?.sha256)) return result;
    mkdirSync(this.tmpDir, { recursive: true });
    const tmp = join(this.tmpDir, `verify-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);
    try {
      await fsp.writeFile(tmp, raw);
      const info = inspectSqliteFile(tmp);
      add('Integrità del database SQLite', true, 'integrity_check ok');
      if (info.schema !== m.schemaVersion) { add('Schema dichiarato', false, `manifest v${m.schemaVersion}, database v${info.schema}`); return result; }
      result.schemaVersion = info.schema;
      result.contents = info.contents;
      result.compatible = info.schema <= LATEST_SCHEMA;
      if (!add('Compatibilità dello schema', result.compatible, result.compatible ? `schema v${info.schema} (supportato fino a v${LATEST_SCHEMA})` : schemaTooNewMessage(info.schema, 'Il backup'))) return result;
      if (info.schema < LATEST_SCHEMA) result.warnings.push(`Backup con schema v${info.schema}: dopo il ripristino il database verrà aggiornato allo schema v${LATEST_SCHEMA}.`);
      if (m.app?.version && m.app.version !== this.version) result.warnings.push(`Backup creato con la versione ${m.app.version} (in uso: ${this.version}).`);
    } catch (e) {
      add('Integrità del database SQLite', false, e.message);
      return result;
    } finally {
      if (existsSync(tmp)) try { unlinkSync(tmp); } catch { /* ignora */ }
    }
    result.ok = true;
    if (keepRaw) result.raw = raw;
    return result;
  }

  // --- Conservazione ----------------------------------------------------------
  // Tiene gli ultimi `keep` backup automatici validi. Mai: l'ultimo backup valido,
  // i backup manuali e di sicurezza, i file incompleti o estranei.
  retention() { return this.run(() => this.#retention(this.targetDir())); }

  async #retention(dir) {
    const keep = Math.max(1, this.conf().keep);
    const items = await this.list({ dir });
    const valid = items.filter((b) => b.status === 'ok');
    const newest = valid[0]?.file;
    const autos = valid.filter((b) => b.kind === 'auto');
    const removed = [];
    for (const b of autos.slice(keep)) {
      if (b.file === newest) continue;
      try {
        await this.t(fsp.unlink(join(dir, b.file)), 'Eliminazione');
        await this.t(fsp.unlink(join(dir, manifestName(b.file))), 'Eliminazione del manifest').catch(() => {});
        removed.push(b.file);
      } catch (e) { this.log.warn(`Backup vecchio non eliminato: ${b.file}`, { message: e.message }); }
    }
    if (removed.length) this.log.info(`Conservazione: eliminati ${removed.length} backup automatici vecchi`, { keep });
    return { removed, kept: valid.length - removed.length };
  }

  // Eliminazione manuale di un backup. L'unico backup valido rimasto non si elimina.
  remove(name) {
    return this.run(async () => {
      const dir = this.targetDir();
      const file = this.fileIn(dir, name);
      const items = await this.list({ dir });
      const item = items.find((b) => b.file === name);
      if (!item) throw new BackupError('Backup non trovato', 'not_found');
      const valid = items.filter((b) => b.status === 'ok');
      if (item.status === 'ok' && valid.length === 1) throw new BackupError('È l\'unico backup valido nella cartella: creane un altro prima di eliminarlo', 'last_valid');
      await this.t(fsp.unlink(file), 'Eliminazione');
      await this.t(fsp.unlink(join(dir, manifestName(name))), 'Eliminazione del manifest').catch((e) => { if (e.code !== 'ENOENT') throw e; });
      this.log.info(`Backup eliminato dalla cartella di rete: ${name}`);
      return { removed: name };
    });
  }

  // --- Pianificazione ---------------------------------------------------------
  due(now = this.now()) {
    const c = this.conf();
    if (!c.enabled) return false;
    const s = this.state();
    if (s.lastStatus === 'error' && s.nextRetryAt && now < new Date(s.nextRetryAt)) return false;
    const last = s.lastAutoAt ? new Date(s.lastAutoAt) : null;
    const h = FREQUENCIES[c.frequency] || 24;
    if (s.lastStatus === 'error' && s.nextRetryAt) return true; // nuovo tentativo programmato
    if (c.frequency === 'daily') {
      if (now.getHours() < c.hour) return false;
      const day = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      return !last || day(last) !== day(now);
    }
    if (c.frequency === 'weekly') {
      if (now.getHours() < c.hour) return false;
      return !last || now - last >= (h - 1) * 3600000;
    }
    return !last || now - last >= h * 3600000 - 60000;
  }

  async tick(now = this.now()) {
    if (this.busy || !this.due(now)) return null;
    try { return await this.create('auto'); } catch { return null; }
  }

  startScheduler() {
    if (!this.timersEnabled) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 60 * 1000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }
}
