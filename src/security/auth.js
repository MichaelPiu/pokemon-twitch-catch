// Autenticazione dell'amministratore: primo accesso, sessioni, CSRF.
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword, verifyPassword, randomToken, sha256, safeEqual } from './crypto.js';
import { nowIso } from '../database/index.js';

export const SESSION_COOKIE = 'lc_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export class AuthService {
  constructor({ db, dataDir, log, initialPassword }) {
    this.db = db;
    this.dataDir = dataDir;
    this.log = log;
    this.initialPassword = initialPassword;
  }

  // Crea l'utente admin al primo avvio. Se non è stata fornita una password
  // iniziale (ADMIN_INITIAL_PASSWORD / ${APP_PASSWORD} su Umbrel) ne genera una
  // casuale e la scrive in DATA_DIR/initial-admin-password.txt.
  async ensureAdmin() {
    const existing = this.db.get('SELECT id FROM admin_users LIMIT 1');
    // Recupero password: creando il file DATA_DIR/reset-admin-password e riavviando,
    // viene generata una nuova password temporanea (da cambiare al primo accesso).
    const trigger = join(this.dataDir, 'reset-admin-password');
    if (existing && existsSync(trigger)) {
      const password = randomToken(12);
      writeFileSync(join(this.dataDir, 'initial-admin-password.txt'),
        `Utente: admin\nPassword temporanea: ${password}\n(Il file viene eliminato dopo il cambio password.)\n`, { mode: 0o600 });
      this.db.run('UPDATE admin_users SET password_hash = ?, must_change_password = 1 WHERE id = ?', await hashPassword(password), existing.id);
      this.db.run('DELETE FROM admin_sessions');
      try { unlinkSync(trigger); } catch { /* ignora */ }
      this.log.warn('Password amministratore reimpostata: vedi initial-admin-password.txt nella cartella dati');
      return { created: false, reset: true };
    }
    if (existing) return { created: false };
    let password = this.initialPassword;
    let generated = false;
    if (!password) {
      password = randomToken(12);
      generated = true;
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(join(this.dataDir, 'initial-admin-password.txt'),
        `Utente: admin\nPassword iniziale: ${password}\n(Il file viene eliminato dopo il cambio password.)\n`, { mode: 0o600 });
    }
    const hash = await hashPassword(password);
    this.db.run('INSERT INTO admin_users (username, password_hash, must_change_password) VALUES (?, ?, 1)', 'admin', hash);
    this.log.info(generated
      ? 'Creato utente admin. Password iniziale salvata in initial-admin-password.txt nella cartella dati.'
      : 'Creato utente admin con la password iniziale fornita dall\'ambiente.');
    return { created: true, generated };
  }

  async login(username, password, meta = {}) {
    const user = this.db.get('SELECT * FROM admin_users WHERE username = ?', String(username || '').toLowerCase());
    // Verifica comunque un hash per non rivelare l'esistenza dell'utente tramite i tempi di risposta.
    const ok = await verifyPassword(String(password || ''), user?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    if (!user || !ok) return null;
    const token = randomToken(32);
    const csrf = randomToken(24);
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.db.run(
      'INSERT INTO admin_sessions (token_hash, csrf_token, admin_user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(token), csrf, user.id, expires, meta.ip || null, String(meta.userAgent || '').slice(0, 200),
    );
    this.db.run('UPDATE admin_users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    this.db.run('DELETE FROM admin_sessions WHERE expires_at < ?', nowIso());
    return { token, csrf, expires, mustChangePassword: !!user.must_change_password, username: user.username };
  }

  resolve(token) {
    if (!token) return null;
    const row = this.db.get(
      `SELECT s.id, s.csrf_token, s.expires_at, u.id AS user_id, u.username, u.must_change_password
       FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id WHERE s.token_hash = ?`, sha256(token));
    if (!row) return null;
    if (row.expires_at < nowIso()) {
      this.db.run('DELETE FROM admin_sessions WHERE id = ?', row.id);
      return null;
    }
    return {
      sessionId: row.id,
      userId: row.user_id,
      username: row.username,
      csrf: row.csrf_token,
      mustChangePassword: !!row.must_change_password,
    };
  }

  checkCsrf(session, header) {
    return !!session && !!header && safeEqual(session.csrf, header);
  }

  logout(token) {
    if (token) this.db.run('DELETE FROM admin_sessions WHERE token_hash = ?', sha256(token));
  }

  async changePassword(userId, currentPassword, newPassword, keepSessionId) {
    const user = this.db.get('SELECT * FROM admin_users WHERE id = ?', userId);
    if (!user || !(await verifyPassword(String(currentPassword || ''), user.password_hash))) {
      return { ok: false, error: 'Password attuale errata' };
    }
    const problem = passwordProblem(newPassword, currentPassword);
    if (problem) return { ok: false, error: problem };
    const hash = await hashPassword(newPassword);
    this.db.tx(() => {
      this.db.run('UPDATE admin_users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hash, nowIso(), userId);
      // Invalida tutte le altre sessioni.
      this.db.run('DELETE FROM admin_sessions WHERE admin_user_id = ? AND id != ?', userId, keepSessionId ?? -1);
    });
    const f = join(this.dataDir, 'initial-admin-password.txt');
    if (existsSync(f)) { try { unlinkSync(f); } catch { /* ignora */ } }
    this.log.info('Password amministratore aggiornata');
    return { ok: true };
  }
}

export function passwordProblem(pw, old) {
  if (typeof pw !== 'string' || pw.length < 10) return 'La nuova password deve avere almeno 10 caratteri';
  if (pw.length > 200) return 'Password troppo lunga';
  if (old && pw === old) return 'La nuova password deve essere diversa dalla precedente';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'La password deve contenere lettere e numeri';
  return null;
}

export function sessionCookie(token, { secure, maxAgeS = SESSION_TTL_MS / 1000 } = {}) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeS)}${secure ? '; Secure' : ''}`;
}
