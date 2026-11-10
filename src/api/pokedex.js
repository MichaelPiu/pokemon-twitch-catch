// Modifica manuale del Pokédex dalla dashboard.
//
// Modello dati: il Pokédex di un allenatore è l'insieme dei suoi esemplari
// (tabella user_pokemon, un record per cattura). Ogni record ha un'origine:
//   twitch — catturato durante una diretta Twitch;
//   manual — catturato durante una sessione manuale (senza Twitch);
//   admin  — registrato dall'amministratore; import — da file JSON; demo.
// Una specie è "vista" se l'allenatore ha lanciato almeno una Poké Ball contro
// di essa, "catturata" se ne possiede almeno un esemplare.
//
// Regole sui dati (documentate anche nel README):
// - lo storico dei lanci e delle sessioni (capture_attempts, stream_sessions) non
//   viene mai modificato: le statistiche dei lanci restano quelle reali;
// - le modifiche cambiano solo la collezione (Pokédex, classifiche, !pokedex);
// - un record corretto conserva la propria origine ed è marcato con updated_by /
//   updated_at; una registrazione manuale ha origine "admin";
// - niente duplicati: la registrazione manuale di una specie già presente è
//   rifiutata (si aggiunge un doppione solo in modo esplicito);
// - transazioni, validazione lato server e controllo di concorrenza (rev).
import { HttpError, readJson, v } from '../http/router.js';
import { imageUrl } from '../spawn/spawn.js';
import { audit, auditList } from '../audit.js';

const id = (x, name = 'ID') => v.num(x, { min: 1, int: true, name });
const ORIGINS = ['twitch', 'manual', 'admin', 'import', 'demo'];

function parseDate(val) {
  const s = v.str(val, { min: 10, max: 40, name: 'Data di cattura' });
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new HttpError(400, 'Data di cattura non valida');
  if (t > Date.now() + 5 * 60000) throw new HttpError(400, 'La data di cattura non può essere nel futuro');
  if (t < Date.parse('2000-01-01')) throw new HttpError(400, 'Data di cattura troppo vecchia');
  return new Date(t).toISOString();
}

const entryView = (r) => ({
  id: r.id, pokemonId: r.pokemon_id, dex: r.dex_number, name: r.name_it || r.name, form: r.form_name || null,
  shiny: !!r.is_shiny, ball: r.ball_name, caughtAt: r.caught_at, origin: r.origin, source: r.source,
  sessionId: r.session_id, sessionKind: r.session_kind || null, note: r.note, rev: r.rev,
  updatedAt: r.updated_at, updatedBy: r.updated_by, corrected: !!r.updated_at,
});

export function registerPokedexRoutes(app) {
  const r = app.router;
  const db = () => app.db;
  const who = (ctx) => ctx.session?.username || null;

  const getUser = (uid) => {
    const u = db().get('SELECT * FROM twitch_users WHERE id = ?', uid);
    if (!u) throw new HttpError(404, 'Allenatore non trovato');
    return u;
  };
  const getEntry = (eid) => {
    const e = db().get(
      `SELECT up.*, p.dex_number, p.name, p.name_it, p.form_name, s.kind AS session_kind FROM user_pokemon up
       JOIN pokemon p ON p.id = up.pokemon_id LEFT JOIN stream_sessions s ON s.id = up.session_id WHERE up.id = ?`, eid);
    if (!e) throw new HttpError(404, 'Registrazione non trovata');
    return e;
  };
  const notify = (userId) => app.hub.admin('pokedex', { userId });

  // Elenco delle specie con lo stato dell'allenatore: ricerca per nome o numero, filtri.
  r.get('/api/admin/pokedex', (ctx) => {
    const u = getUser(id(ctx.query.get('user'), 'Allenatore'));
    const q = String(ctx.query.get('q') || '').trim().toLowerCase();
    const status = ctx.query.get('status') || 'all';
    if (!['all', 'caught', 'seen', 'missing', 'shiny', 'corrected', 'admin', 'manual', 'twitch'].includes(status)) throw new HttpError(400, 'Filtro non valido');
    const limit = Math.min(500, Math.max(1, Math.floor(Number(ctx.query.get('limit'))) || 100));
    const offset = Math.max(0, Math.floor(Number(ctx.query.get('offset'))) || 0);
    const where = [];
    const args = [u.id, u.id];
    if (q) {
      if (/^#?\d{1,4}$/.test(q)) { where.push('p.dex_number = ?'); args.push(Number(q.replace('#', ''))); }
      else { where.push('(LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.name_it, \'\')) LIKE ?)'); const like = `%${q.replace(/[%_]/g, '')}%`; args.push(like, like); }
    }
    const having = {
      all: '', caught: 'WHERE c.count > 0', seen: 'WHERE c.count = 0 AND c.seen > 0', missing: 'WHERE c.count = 0 AND c.seen = 0',
      shiny: 'WHERE c.shiny > 0', corrected: 'WHERE c.corrected > 0', admin: 'WHERE c.admin > 0', manual: 'WHERE c.manual > 0', twitch: 'WHERE c.twitch > 0',
    }[status];
    const base = `SELECT * FROM (
      SELECT p.id, p.dex_number, p.name, p.name_it, p.form_name, p.rarity, p.image_file, p.shiny_image_file, p.image_url, p.shiny_image_url,
        COUNT(up.id) AS count, COALESCE(SUM(up.is_shiny), 0) AS shiny,
        COALESCE(SUM(up.origin = 'twitch'), 0) AS twitch, COALESCE(SUM(up.origin = 'manual'), 0) AS manual,
        COALESCE(SUM(up.origin IN ('admin','import')), 0) AS admin, COALESCE(SUM(up.updated_at IS NOT NULL), 0) AS corrected,
        MIN(up.caught_at) AS first_caught, MAX(up.caught_at) AS last_caught,
        (SELECT COUNT(*) FROM capture_attempts a JOIN spawn_history s ON s.id = a.spawn_id
          WHERE a.user_id = ? AND s.pokemon_id = p.id AND a.outcome != 'rejected') AS seen
      FROM pokemon p LEFT JOIN user_pokemon up ON up.pokemon_id = p.id AND up.user_id = ?
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY p.id) c ${having}`;
    const total = db().get(`SELECT COUNT(*) AS n FROM (${base})`, ...args).n;
    const rows = db().all(`${base} ORDER BY c.dex_number, c.id LIMIT ? OFFSET ?`, ...args, limit, offset);
    const sum = db().get(`SELECT COUNT(*) AS total, COUNT(DISTINCT pokemon_id) AS species, COALESCE(SUM(is_shiny), 0) AS shiny,
      COALESCE(SUM(origin = 'twitch'), 0) AS twitch, COALESCE(SUM(origin = 'manual'), 0) AS manual, COALESCE(SUM(origin IN ('admin','import')), 0) AS admin
      FROM user_pokemon WHERE user_id = ?`, u.id);
    return {
      user: { id: u.id, login: u.login, displayName: u.display_name, origin: u.origin, isDemo: !!u.is_demo },
      summary: sum,
      total,
      items: rows.map((x) => ({
        pokemonId: x.id, dex: x.dex_number, name: x.name_it || x.name, form: x.form_name, rarity: x.rarity,
        image: imageUrl(x, false), count: x.count, shiny: x.shiny, seen: x.seen > 0, caught: x.count > 0,
        origins: { twitch: x.twitch, manual: x.manual, admin: x.admin }, corrected: x.corrected,
        firstCaught: x.first_caught, lastCaught: x.last_caught,
      })),
    };
  });

  // Dettaglio di una specie per un allenatore: esemplari, varianti disponibili, storico modifiche.
  r.get('/api/admin/pokedex/:userId/:pokemonId', (ctx) => {
    const u = getUser(id(ctx.params.userId, 'Allenatore'));
    const p = db().get('SELECT * FROM pokemon WHERE id = ?', id(ctx.params.pokemonId, 'Pokémon'));
    if (!p) throw new HttpError(404, 'Pokémon non trovato');
    const entries = db().all(
      `SELECT up.*, p.dex_number, p.name, p.name_it, p.form_name, s.kind AS session_kind FROM user_pokemon up
       JOIN pokemon p ON p.id = up.pokemon_id LEFT JOIN stream_sessions s ON s.id = up.session_id
       WHERE up.user_id = ? AND p.dex_number = ? ORDER BY up.caught_at, up.id`, u.id, p.dex_number).map(entryView);
    const ids = entries.map((e) => String(e.id));
    return {
      user: { id: u.id, displayName: u.display_name, origin: u.origin },
      pokemon: { id: p.id, dex: p.dex_number, name: p.name_it || p.name, form: p.form_name, rarity: p.rarity, image: imageUrl(p, false), shinyEnabled: !!p.shiny_enabled },
      variants: db().all('SELECT id, name, name_it, form_name FROM pokemon WHERE dex_number = ? ORDER BY is_default_form DESC, id', p.dex_number)
        .map((x) => ({ id: x.id, name: x.name_it || x.name, form: x.form_name })),
      entries,
      seen: db().get(`SELECT COUNT(*) AS n FROM capture_attempts a JOIN spawn_history s ON s.id = a.spawn_id
        WHERE a.user_id = ? AND s.pokemon_id IN (SELECT id FROM pokemon WHERE dex_number = ?) AND a.outcome != 'rejected'`, u.id, p.dex_number).n,
      balls: db().all('SELECT name FROM ball_types ORDER BY sort_order, id').map((b) => b.name),
      history: ids.length ? auditList(db(), { targetType: 'pokedex_entry', limit: 500 }).filter((a) => ids.includes(a.target_id)).slice(0, 50) : [],
    };
  });

  const cleanChanges = (b, { creating = false } = {}) => {
    const out = {};
    if (b.pokemonId !== undefined) out.pokemon_id = id(b.pokemonId, 'Pokémon');
    if (b.shiny !== undefined) out.is_shiny = v.bool(b.shiny) ? 1 : 0;
    if (b.ball !== undefined) out.ball_name = b.ball === null || b.ball === '' ? null : v.str(b.ball, { min: 1, max: 40, name: 'Poké Ball' });
    if (b.caughtAt !== undefined) out.caught_at = parseDate(b.caughtAt);
    if (b.note !== undefined) out.note = b.note === null || b.note === '' ? null : v.str(b.note, { max: 500, name: 'Nota' });
    if (creating && out.pokemon_id === undefined) throw new HttpError(400, 'Indica il Pokémon da registrare');
    return out;
  };

  // Registrazione manuale di una specie non ancora presente (o, esplicitamente, di un doppione).
  r.post('/api/admin/pokedex/:userId/entries', async (ctx) => {
    const u = getUser(id(ctx.params.userId, 'Allenatore'));
    const b = await readJson(ctx.req);
    const ch = cleanChanges(b, { creating: true });
    const p = db().get('SELECT * FROM pokemon WHERE id = ?', ch.pokemon_id);
    if (!p) throw new HttpError(404, 'Pokémon non trovato');
    if (ch.is_shiny && !p.shiny_enabled) throw new HttpError(400, 'Questo Pokémon non ha la variante shiny abilitata');
    const additional = v.bool(b.additional);
    const record = {
      pokemon: p.name_it || p.name, dex: p.dex_number, form: p.form_name || null, shiny: !!ch.is_shiny,
      ball: ch.ball_name ?? 'Registrato da admin', caughtAt: ch.caught_at || new Date().toISOString(), note: ch.note ?? null, origin: u.is_demo ? 'demo' : 'admin',
    };
    if (v.bool(b.dryRun)) return { dryRun: true, create: record };
    return db().tx(() => {
      const dup = db().get('SELECT id FROM user_pokemon WHERE user_id = ? AND pokemon_id = ? LIMIT 1', u.id, p.id);
      if (dup && !additional) throw new HttpError(409, `${record.pokemon} è già nel Pokédex di ${u.display_name}: modifica la registrazione esistente oppure aggiungi un doppione in modo esplicito`, { existing: dup.id });
      const res = db().run(
        `INSERT INTO user_pokemon (user_id, pokemon_id, is_shiny, is_demo, ball_name, caught_at, source, origin, note, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
        u.id, p.id, ch.is_shiny || 0, u.is_demo, record.ball, record.caughtAt, record.origin, record.note, who(ctx));
      const eid = Number(res.lastInsertRowid);
      audit(db(), { admin: who(ctx), action: 'pokedex_register', targetType: 'pokedex_entry', targetId: eid, detail: { userId: u.id, user: u.display_name, additional, ...record } }, app.log);
      app.log.info(`Pokédex: ${record.pokemon} registrato manualmente per ${u.display_name}`, { entry: eid, admin: who(ctx) });
      notify(u.id);
      return { entry: entryView(getEntry(eid)) };
    });
  });

  // Correzione di un record. dryRun = solo anteprima delle modifiche.
  r.patch('/api/admin/pokedex/entries/:entryId', async (ctx) => {
    const e = getEntry(id(ctx.params.entryId, 'Registrazione'));
    const b = await readJson(ctx.req);
    const rev = v.num(b.rev, { min: 0, int: true, name: 'Revisione' });
    const ch = cleanChanges(b.changes || {});
    if (ch.pokemon_id !== undefined && ch.pokemon_id !== e.pokemon_id) {
      const np = db().get('SELECT * FROM pokemon WHERE id = ?', ch.pokemon_id);
      if (!np) throw new HttpError(404, 'Pokémon non trovato');
      // Correzione della forma/variante: stessa specie (stesso numero del Pokédex).
      if (np.dex_number !== e.dex_number) throw new HttpError(400, 'Si può cambiare solo la forma o variante della stessa specie: per un Pokémon diverso rimuovi la registrazione e registrane una nuova');
    }
    if (ch.is_shiny) {
      const pid = ch.pokemon_id ?? e.pokemon_id;
      if (!db().get('SELECT shiny_enabled FROM pokemon WHERE id = ?', pid).shiny_enabled) throw new HttpError(400, 'Questo Pokémon non ha la variante shiny abilitata');
    }
    const diff = Object.entries(ch).filter(([k, val]) => e[k] !== val).map(([k, val]) => ({ field: k, from: e[k], to: val }));
    if (!diff.length) return { unchanged: true, entry: entryView(e) };
    if (v.bool(b.dryRun)) return { dryRun: true, diff, entry: entryView(e) };
    return db().tx(() => {
      const sets = diff.map((d) => `${d.field} = ?`);
      const res = db().run(
        `UPDATE user_pokemon SET ${sets.join(', ')}, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ? AND rev = ?`,
        ...diff.map((d) => d.to), new Date().toISOString(), who(ctx), e.id, rev);
      if (res.changes !== 1) throw new HttpError(409, 'La registrazione è stata modificata da un\'altra operazione: ricarica e riprova', { current: entryView(getEntry(e.id)) });
      audit(db(), { admin: who(ctx), action: 'pokedex_edit', targetType: 'pokedex_entry', targetId: e.id, detail: { userId: e.user_id, origin: e.origin, diff } }, app.log);
      app.log.info(`Pokédex: registrazione #${e.id} corretta`, { fields: diff.map((d) => d.field), admin: who(ctx) });
      notify(e.user_id);
      return { entry: entryView(getEntry(e.id)), diff };
    });
  });

  // Rimozione di una registrazione errata: conferma esplicita e revisione attuale.
  r.post('/api/admin/pokedex/entries/:entryId/delete', async (ctx) => {
    const e = getEntry(id(ctx.params.entryId, 'Registrazione'));
    const b = await readJson(ctx.req);
    if (b.confirm !== true) throw new HttpError(400, 'Conferma la rimozione');
    const rev = v.num(b.rev, { min: 0, int: true, name: 'Revisione' });
    return db().tx(() => {
      const res = db().run('DELETE FROM user_pokemon WHERE id = ? AND rev = ?', e.id, rev);
      if (res.changes !== 1) throw new HttpError(409, 'La registrazione è stata modificata da un\'altra operazione: ricarica e riprova');
      audit(db(), { admin: who(ctx), action: 'pokedex_remove', targetType: 'pokedex_entry', targetId: e.id, detail: { userId: e.user_id, ...entryView(e) } }, app.log);
      app.log.info(`Pokédex: registrazione #${e.id} rimossa`, { origin: e.origin, admin: who(ctx) });
      notify(e.user_id);
      return { removed: e.id };
    });
  });

  // Registro delle modifiche amministrative (Pokédex, backup, sessioni manuali).
  r.get('/api/admin/audit', (ctx) => {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(ctx.query.get('limit'))) || 100));
    const type = ctx.query.get('type');
    if (type && !/^[a-z_]{1,30}$/.test(type)) throw new HttpError(400, 'Tipo non valido');
    return auditList(db(), { limit, targetType: type || null });
  });
}

export { ORIGINS };
