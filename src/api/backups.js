// API dei backup sulla cartella di rete. Solo amministratori autenticati, con i
// controlli CSRF/Origin già applicati dal router a tutte le scritture. Nessun
// percorso arbitrario: si lavora solo dentro la cartella montata, con nomi di
// file validati; nessun comando shell; nessun contenuto dei backup esposto.
import { HttpError, readJson } from '../http/router.js';
import { NetworkBackupService, BackupError, FREQUENCIES } from '../backup/network.js';
import { audit } from '../audit.js';

const STATUS = { invalid: 400, busy: 409, last_valid: 409, not_found: 404, not_mounted: 409 };

function fail(e) {
  if (e instanceof HttpError) throw e;
  if (e instanceof BackupError) throw new HttpError(STATUS[e.code] || 502, e.message, { code: e.code });
  throw new HttpError(500, e.message);
}

export const RESTORE_CONFIRM = 'RIPRISTINA';

export function registerBackupRoutes(app) {
  const r = app.router;
  const nb = () => app.networkBackups;
  const who = (ctx) => ctx.session?.username || null;

  r.get('/api/admin/backups/network', async () => {
    const root = await nb().rootStatus();
    let items = [];
    let listError = null;
    if (root.mounted) {
      try { items = await nb().list(); } catch (e) { listError = e.message; }
    }
    return {
      root: nb().root,
      mounted: root.mounted,
      mountError: root.error || null,
      dir: (() => { try { return nb().targetDir(); } catch { return null; } })(),
      settings: nb().conf(),
      state: nb().state(),
      frequencies: Object.keys(FREQUENCIES),
      busy: !!nb().busy,
      listError,
      items: items.map(({ manifest, ...rest }) => ({ ...rest, note: manifest?.note || null })),
    };
  });

  r.put('/api/admin/backups/network/settings', async (ctx) => {
    const b = await readJson(ctx.req);
    let next;
    try { next = NetworkBackupService.validateSettings(b, nb().conf()); } catch (e) { fail(e); }
    app.adminSettings.set('networkBackup', next);
    audit(app.db, { admin: who(ctx), action: 'backup_network_settings', targetType: 'settings', targetId: 'networkBackup', detail: next }, app.log);
    return next;
  });

  r.post('/api/admin/backups/network/test', async () => {
    try { return await nb().test(); } catch (e) { fail(e); }
  });

  r.post('/api/admin/backups/network', async (ctx) => {
    const b = await readJson(ctx.req).catch(() => ({}));
    try {
      const res = await nb().create('manual', { note: typeof b.note === 'string' ? b.note : null, admin: who(ctx) });
      audit(app.db, { admin: who(ctx), action: 'backup_network_create', targetType: 'backup', targetId: res.file, detail: { size: res.size, sha256: res.sha256 } }, app.log);
      return res;
    } catch (e) { fail(e); }
  });

  r.post('/api/admin/backups/network/retention', async (ctx) => {
    try {
      const res = await nb().retention();
      audit(app.db, { admin: who(ctx), action: 'backup_network_retention', targetType: 'backup', detail: res }, app.log);
      return res;
    } catch (e) { fail(e); }
  });

  r.get('/api/admin/backups/network/:file', async (ctx) => {
    try {
      const item = (await nb().list()).find((x) => x.file === ctx.params.file);
      if (!item) throw new HttpError(404, 'Backup non trovato');
      return item;
    } catch (e) { fail(e); }
  });

  // Verifica completa (checksum, integrità SQLite, compatibilità) senza modificare nulla.
  r.post('/api/admin/backups/network/:file/verify', async (ctx) => {
    try {
      const v = await nb().run(() => nb().verify(ctx.params.file));
      audit(app.db, { admin: who(ctx), action: 'backup_network_verify', targetType: 'backup', targetId: ctx.params.file, detail: { ok: v.ok } }, app.log);
      return v;
    } catch (e) { fail(e); }
  });

  r.delete('/api/admin/backups/network/:file', async (ctx) => {
    try {
      const res = await nb().remove(ctx.params.file);
      audit(app.db, { admin: who(ctx), action: 'backup_network_delete', targetType: 'backup', targetId: ctx.params.file }, app.log);
      return res;
    } catch (e) { fail(e); }
  });

  // Ripristino guidato: il client deve confermare esplicitamente e indicare il
  // checksum del backup che ha visto nell'anteprima (stesso file, non modificato).
  r.post('/api/admin/backups/network/:file/restore', async (ctx) => {
    const b = await readJson(ctx.req);
    if (b.confirm !== RESTORE_CONFIRM) throw new HttpError(400, `Conferma mancante: scrivi ${RESTORE_CONFIRM} per sostituire i dati attuali`);
    let v;
    try { v = await nb().run(() => nb().verify(ctx.params.file, { keepRaw: true })); } catch (e) { fail(e); }
    if (!v.ok) {
      const bad = v.checks.find((c) => !c.ok);
      throw new HttpError(422, `Backup non ripristinabile: ${bad ? `${bad.name} — ${bad.detail}` : 'verifica non superata'}`, { checks: v.checks });
    }
    if (b.sha256 !== v.manifest.archive.sha256) throw new HttpError(409, 'Il backup è cambiato dopo l\'anteprima: ricontrollalo prima di ripristinarlo');
    return app.restoreRaw(v.raw, { label: ctx.params.file, source: 'network', admin: who(ctx), keepSessionOf: ctx.session?.sessionId });
  });
}
