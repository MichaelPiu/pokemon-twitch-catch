// Accesso al database SQLite (modulo integrato node:sqlite, nessuna dipendenza nativa).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.js';

export function nowIso() {
  return new Date().toISOString();
}

export class Database {
  constructor(path) {
    this.path = path;
    this.open();
  }

  open() {
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.stmtCache = new Map();
    this.txDepth = 0;
  }

  close() {
    if (!this.db) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ignora */ }
    this.db.close();
    this.db = null;
    this.stmtCache = new Map();
  }

  prepare(sql) {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  get(sql, ...params) { return this.prepare(sql).get(...params); }
  all(sql, ...params) { return this.prepare(sql).all(...params); }
  run(sql, ...params) { return this.prepare(sql).run(...params); }
  exec(sql) { return this.db.exec(sql); }

  // Transazione IMMEDIATE (lock in scrittura acquisito subito). Annidabile tramite SAVEPOINT.
  tx(fn) {
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const r = fn();
        this.db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignora */ }
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    const applied = new Set(this.all('SELECT id FROM schema_migrations').map((r) => r.id));
    const pending = migrations.filter((m) => !applied.has(m.id));
    for (const m of pending) {
      this.tx(() => {
        this.db.exec(m.sql);
        this.run('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', m.id, m.name);
      });
    }
    return pending.map((m) => m.id);
  }

  pendingMigrations() {
    const has = this.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
    if (!has) return migrations.map((m) => m.id);
    const applied = new Set(this.all('SELECT id FROM schema_migrations').map((r) => r.id));
    return migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
  }

  schemaVersion() {
    return this.get('SELECT MAX(id) AS v FROM schema_migrations')?.v ?? 0;
  }

  integrityCheck() {
    return this.get('PRAGMA integrity_check')?.integrity_check === 'ok';
  }
}

// Archivio chiave/valore JSON sopra una delle tabelle *_settings.
export class SettingsStore {
  constructor(db, table, defaults = {}) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('invalid table');
    this.db = db;
    this.table = table;
    this.defaults = defaults;
  }

  get(key) {
    const row = this.db.get(`SELECT value FROM ${this.table} WHERE key = ?`, key);
    if (!row) return structuredClone(this.defaults[key]);
    try {
      const v = JSON.parse(row.value);
      const d = this.defaults[key];
      if (d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object') return { ...structuredClone(d), ...v };
      return v;
    } catch {
      return structuredClone(this.defaults[key]);
    }
  }

  set(key, value) {
    this.db.run(
      `INSERT INTO ${this.table} (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, JSON.stringify(value), nowIso(),
    );
  }

  all() {
    const out = structuredClone(this.defaults);
    for (const key of Object.keys(this.defaults)) out[key] = this.get(key);
    for (const row of this.db.all(`SELECT key FROM ${this.table}`)) {
      if (!(row.key in out)) out[row.key] = this.get(row.key);
    }
    return out;
  }
}
