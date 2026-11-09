// API di autenticazione amministratore.
import { HttpError, readJson } from '../http/router.js';
import { sessionCookie, SESSION_COOKIE } from '../security/auth.js';

export function registerAuthRoutes(app) {
  const r = app.router;

  r.post('/api/auth/login', async (ctx) => {
    if (!app.loginLimiter.hit(ctx.ip)) throw new HttpError(429, 'Troppi tentativi di accesso. Riprova tra 15 minuti.');
    const body = await readJson(ctx.req, 10 * 1024);
    const result = await app.auth.login(body.username, body.password, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    if (!result) {
      app.logger.child('auth').warn('Accesso fallito', { ip: ctx.ip });
      throw new HttpError(401, 'Credenziali non valide');
    }
    app.loginLimiter.reset(ctx.ip);
    ctx.res.setHeader('Set-Cookie', sessionCookie(result.token, { secure: app.config.secureCookies }));
    return { ok: true, csrf: result.csrf, mustChangePassword: result.mustChangePassword, username: result.username };
  }, { public: true });

  r.post('/api/auth/logout', async (ctx) => {
    app.auth.logout(ctx.cookies[SESSION_COOKIE]);
    ctx.res.setHeader('Set-Cookie', sessionCookie('', { secure: app.config.secureCookies, maxAgeS: 0 }));
    return { ok: true };
  }, { allowPasswordChange: true });

  r.get('/api/auth/me', async (ctx) => ({
    username: ctx.session.username, csrf: ctx.session.csrf, mustChangePassword: ctx.session.mustChangePassword, version: app.config.version,
  }), { allowPasswordChange: true });

  r.post('/api/auth/change-password', async (ctx) => {
    const body = await readJson(ctx.req, 10 * 1024);
    const res = await app.auth.changePassword(ctx.session.userId, body.currentPassword, body.newPassword, ctx.session.sessionId);
    if (!res.ok) throw new HttpError(400, res.error);
    return { ok: true };
  }, { allowPasswordChange: true });
}
