// Backup e ripristino del database (copia coerente con VACUUM INTO, compressa gzip),
// rotazione automatica, esportazione/importazione JSON delle collezioni.
import { mkdirSync, statSync, existsSync, unlinkSync, readFileSync, writeFileSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../database/index.js';

const NAME_RE = /^livecatch-\d{8}-\d{6}-[a-z-]+(-\d+)?\.sqlite\.gz$/;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class BackupService {
  constructor({ db, config, adminSettings, log }) {
    this.db = db;
    this.dir = config.backupsDir;
    this.dbPath = config.dbPath;
    this.settings = adminSettings;
    this.log = log;
    this.timer = null;
    this.lastAutoDate = null;
    mkdirSync(this.dir, { recursive: true });
  }

  validName(name) { return NAME_RE.test(name) && basename(name) === name; }

  create(kind = 'manual', note = null) {
    let name = `livecatch-${stamp()}-${kind}.sqlite.gz`;
    for (let i = 1; existsSync(join(this.dir, name)); i++) name = `livecatch-${stamp()}-${kind}-${i}.sqlite.gz`;
    const tmp = join(this.dir, `.tmp-${process.pid}-${Date.now()}.sqlite`);
    try {
      this.db.prepare('VACUUM INTO ?').run(tmp);
      const gz = gzipSync(readFileSync(tmp), { level: 6 });
      writeFileSync(join(this.dir, name), gz);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
    const size = statSync(join(this.dir, name)).size;
    this.db.run('INSERT INTO backup_history (filename, kind, size_bytes, note) VALUES (?, ?, ?, ?)', name, kind, size, note);
    this.log.info(`Backup creato: ${name}`, { size });
    if (kind === 'auto') this.rotate();
    return { filename: name, size };
  }

  list() {
    const rows = this.db.all('SELECT * FROM backup_history WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC');
    const known = new Set(rows.map((r) => r.filename));
    // Include anche file presenti su disco ma non registrati (es. dopo un ripristino).
    for (const f of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      if (this.validName(f) && !known.has(f)) {
        const st = statSync(join(this.dir, f));
        rows.push({ id: null, filename: f, kind: /-(manual|auto|pre-restore|pre-migration|upload)/.exec(f)?.[1] || 'manual', size_bytes: st.size, created_at: st.mtime.toISOString(), status: 'ok' });
      }
    }
    return rows.map((r) => ({ ...r, exists: existsSync(join(this.dir, r.filename)) }))
      .sort((a, b) => b.filename.slice(10, 25).localeCompare(a.filename.slice(10, 25)));
  }

  path(name) {
    if (!this.validName(name)) throw new Error('Nome file di backup non valido');
    const p = join(this.dir, name);
    if (!existsSync(p)) throw new Error('Backup non trovato');
    return p;
  }

  remove(name) {
    const p = this.path(name);
    unlinkSync(p);
    this.db.run('UPDATE backup_history SET deleted_at = ? WHERE filename = ?', nowIso(), name);
  }

  rotate() {
    const keep = Math.max(1, this.settings.get('backup').keep || 14);
    const autos = this.list().filter((b) => b.kind === 'auto' && b.exists).sort((a, b) => b.filename.localeCompare(a.filename));
    for (const old of autos.slice(keep)) {
      try { this.remove(old.filename); this.log.info(`Backup ruotato: ${old.filename}`); } catch { /* ignora */ }
    }
  }

  // Salva un file caricato dall'utente (gzip o sqlite non compresso) dopo averlo verificato.
  saveUpload(buf) {
    let raw = buf;
    if (buf[0] === 0x1f && buf[1] === 0x8b) raw = gunzipSync(buf);
    this.verifySqlite(raw);
    const name = `livecatch-${stamp()}-upload.sqlite.gz`;
    writeFileSync(join(this.dir, name), gzipSync(raw));
    this.db.run('INSERT INTO backup_history (filename, kind, size_bytes, note) VALUES (?, ?, ?, ?)', name, 'upload', statSync(join(this.dir, name)).size, 'caricato dalla dashboard');
    return name;
  }

  verifySqlite(raw) {
    if (raw.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new Error('Il file non è un database SQLite valido');
    const tmp = join(this.dir, `.verify-${Date.now()}.sqlite`);
    writeFileSync(tmp, raw);
    try {
      const d = new DatabaseSync(tmp, { readOnly: true });
      try {
        if (d.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database danneggiato');
        const t = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('twitch_users','user_pokemon','pokemon','schema_migrations')").all();
        if (t.length < 4) throw new Error('Il database non appartiene a questa applicazione');
      } finally { d.close(); }
    } finally {
      unlinkSync(tmp);
    }
  }

  // Ripristino: crea prima un backup di sicurezza, poi sostituisce il database.
  // Il chiamante deve riaprire il DB (vedi App.restore).
  restoreFile(name) {
    const raw = gunzipSync(readFileSync(this.path(name)));
    this.verifySqlite(raw);
    const safety = this.create('pre-restore', `prima del ripristino di ${name}`);
    const staged = `${this.dbPath}.restore`;
    writeFileSync(staged, raw);
    return { staged, safety: safety.filename };
  }

  swapInStaged(staged) {
    for (const ext of ['-wal', '-shm']) if (existsSync(this.dbPath + ext)) unlinkSync(this.dbPath + ext);
    if (existsSync(this.dbPath)) copyFileSync(this.dbPath, `${this.dbPath}.before-restore`);
    renameSync(staged, this.dbPath);
  }

  // --- Esportazione / importazione JSON -------------------------------------
  exportJson() {
    return {
      format: 'livecatch-export',
      version: 1,
      exportedAt: nowIso(),
      users: this.db.all('SELECT twitch_id, login, display_name, first_seen_at, last_seen_at FROM twitch_users WHERE is_demo = 0'),
      collections: this.db.all(
        `SELECT u.twitch_id, p.slug, up.is_shiny, up.ball_name, up.caught_at, up.source
         FROM user_pokemon up JOIN twitch_users u ON u.id = up.user_id JOIN pokemon p ON p.id = up.pokemon_id WHERE up.is_demo = 0`),
      pokemonSettings: this.db.all('SELECT slug, rarity, catch_modifier, spawn_weight, shiny_enabled, enabled FROM pokemon'),
      sessions: this.db.all('SELECT * FROM stream_sessions WHERE is_demo = 0'),
    };
  }

  importJson(data, { mode = 'merge' } = {}) {
    if (data?.format !== 'livecatch-export') throw new Error('File di esportazione non riconosciuto');
    return this.db.tx(() => {
      if (mode === 'replace') this.db.run('DELETE FROM user_pokemon WHERE is_demo = 0');
      let users = 0, mons = 0, skipped = 0;
      for (const u of data.users || []) {
        this.db.run(
          `INSERT INTO twitch_users (twitch_id, login, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(twitch_id) DO UPDATE SET login = excluded.login, display_name = excluded.display_name`,
          String(u.twitch_id), String(u.login).toLowerCase(), u.display_name, u.first_seen_at || nowIso(), u.last_seen_at || nowIso());
        users++;
      }
      for (const c of data.collections || []) {
        const u = this.db.get('SELECT id FROM twitch_users WHERE twitch_id = ?', String(c.twitch_id));
        const p = this.db.get('SELECT id FROM pokemon WHERE slug = ?', c.slug);
        if (!u || !p) { skipped++; continue; }
        if (mode === 'merge') {
          const exists = this.db.get('SELECT id FROM user_pokemon WHERE user_id = ? AND pokemon_id = ? AND caught_at = ?', u.id, p.id, c.caught_at);
          if (exists) { skipped++; continue; }
        }
        this.db.run(`INSERT INTO user_pokemon (user_id, pokemon_id, is_shiny, ball_name, caught_at, source) VALUES (?, ?, ?, ?, ?, 'import')`,
          u.id, p.id, c.is_shiny ? 1 : 0, c.ball_name || null, c.caught_at || nowIso());
        mons++;
      }
      for (const s of data.pokemonSettings || []) {
        this.db.run('UPDATE pokemon SET rarity = ?, catch_modifier = ?, spawn_weight = ?, shiny_enabled = ?, enabled = ? WHERE slug = ?',
          s.rarity, s.catch_modifier, s.spawn_weight, s.shiny_enabled, s.enabled, s.slug);
      }
      return { users, pokemon: mons, skipped };
    });
  }

  // Backup automatico giornaliero all'ora configurata.
  startScheduler() {
    this.timer = setInterval(() => this.checkAuto(), 60 * 1000);
    this.timer.unref?.();
  }

  checkAuto(now = new Date()) {
    const cfg = this.settings.get('backup');
    if (!cfg.autoEnabled) return null;
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() < cfg.hour) return null;
    if (this.lastAutoDate === today) return null;
    const last = this.db.get("SELECT created_at FROM backup_history WHERE kind = 'auto' ORDER BY id DESC LIMIT 1");
    if (last && last.created_at.slice(0, 10) === today) { this.lastAutoDate = today; return null; }
    this.lastAutoDate = today;
    try { return this.create('auto'); } catch (e) { this.log.error('Backup automatico fallito', { message: e.message }); return null; }
  }

  stop() { clearInterval(this.timer); }
}
