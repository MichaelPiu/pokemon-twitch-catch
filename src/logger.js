// Logger con redazione automatica dei segreti, buffer in memoria per la
// dashboard e file su disco con rotazione.
import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_FILE = 5 * 1024 * 1024;
const KEEP_FILES = 3;

const SECRET_KEYS = /(token|secret|password|authorization|cookie|code|key)/i;

export function redact(value, depth = 0) {
  if (value == null || depth > 5) return value;
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer|OAuth)\s+[A-Za-z0-9._-]+/gi, '$1 [REDACTED]')
      .replace(/(access_token|refresh_token|client_secret|password|device_code)=([^&\s]+)/gi, '$1=[REDACTED]')
      .replace(/("(?:access_token|refresh_token|client_secret|password|device_code)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: redact(value.stack || '') };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) && typeof v === 'string' && !/^(user_code|code_count)$/i.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor({ dir = null, level = 'info', bufferSize = 1000, console: useConsole = true } = {}) {
    this.dir = dir;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.buffer = [];
    this.bufferSize = bufferSize;
    this.useConsole = useConsole;
    this.listeners = new Set();
    this.seq = 0;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  child(scope) {
    const parent = this;
    return {
      debug: (m, d) => parent.log('debug', scope, m, d),
      info: (m, d) => parent.log('info', scope, m, d),
      warn: (m, d) => parent.log('warn', scope, m, d),
      error: (m, d) => parent.log('error', scope, m, d),
    };
  }

  log(level, scope, message, data) {
    if ((LEVELS[level] ?? 0) < this.level) return;
    const entry = {
      id: ++this.seq,
      ts: new Date().toISOString(),
      level,
      scope,
      message: redact(String(message)),
      data: data === undefined ? undefined : redact(data),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.message}${entry.data !== undefined ? ' ' + safeJson(entry.data) : ''}`;
    if (this.useConsole) (level === 'error' ? console.error : console.log)(line);
    if (this.dir) this.writeFile(line);
    for (const l of this.listeners) {
      try { l(entry); } catch { /* ignora */ }
    }
  }

  writeFile(line) {
    const file = join(this.dir, 'app.log');
    try {
      if (existsSync(file) && statSync(file).size > MAX_FILE) {
        for (let i = KEEP_FILES - 1; i >= 1; i--) {
          const src = `${file}.${i}`;
          if (existsSync(src)) {
            if (i === KEEP_FILES - 1) unlinkSync(src);
            else renameSync(src, `${file}.${i + 1}`);
          }
        }
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line + '\n');
    } catch { /* il logging non deve mai bloccare l'app */ }
  }

  recent({ level = 'debug', limit = 200, scope = null } = {}) {
    const min = LEVELS[level] ?? 0;
    return this.buffer.filter((e) => LEVELS[e.level] >= min && (!scope || e.scope === scope)).slice(-limit);
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}
