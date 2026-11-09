// API della dashboard amministrativa unica. Tutte le rotte richiedono
// sessione admin + token CSRF per le operazioni di scrittura.
import { statfsSync, existsSync, statSync, readFileSync } from 'node:fs';
import { HttpError, readJson, readBody, v } from '../http/router.js';
import { RARITIES } from '../configuration/defaults.js';
import { validateGame, validateSpawn, validateCommandGlobals, validateOverlay } from '../configuration/validate.js';
import { STATES } from '../game_engine/stateMachine.js';
import { activeSpawn, publicSpawn, imageUrl } from '../spawn/spawn.js';
import { summary, collection, captures, leaderboard } from '../pokedex/pokedex.js';
import { upsertUser } from '../pokedex/users.js';
import { listCommands } from '../commands/commands.js';
import { periodStats, totals, topLists, recentCaptures, sessionDetail, sessionTimeline, activityFeed } from '../stats/stats.js';
import { captureProbability } from '../capture/capture.js';
import { randomToken } from '../security/crypto.js';
import { validHostname, parseHost } from '../security/origin.js';

const id = (x, name = 'ID') => v.num(x, { min: 1, int: true, name });

export function registerAdminRoutes(app) {
  const r = app.router;
  const db = () => app.db;

  // --- Panoramica --------------------------------------------------------------
  r.get('/api/admin/overview', () => {
    const st = app.liveStatus();
    // Sessione mostrata: la diretta reale o, se attiva, la sessione DEMO (marcata come tale).
    const sess = st.session || null;
    const isDemo = !!sess?.is_demo;
    const cfg = app.engine.cfg();
    const sp = st.engine.activeSpawn;
    let baseChance = null;
    if (sp) {
      const row = db().get('SELECT catch_modifier FROM pokemon WHERE id = ?', sp.pokemonId);
      baseChance = captureProbability({ settings: cfg, rarity: sp.rarity, catchModifier: row?.catch_modifier ?? 1, ball: { multiplier: 1, guaranteed: 0 }, isShiny: sp.shiny });
    }
    return {
      ...st,
      session: sess,
      isDemo,
      current: sess ? totals(db(), { sessionId: sess.id }) : null,
      allTime: totals(db()),
      newTrainersToday: db().get("SELECT COUNT(*) AS n FROM twitch_users WHERE is_demo = ? AND date(first_seen_at, 'localtime') = date('now', 'localtime')", isDemo ? 1 : 0).n,
      spawnInfo: sp ? { baseChance, mode: sp.mode } : null,
      recentCaptures: recentCaptures(db(), { limit: 5, isDemo }),
      activity: activityFeed(db(), { limit: 6, isDemo }),
      recentEvents: db().all('SELECT event_type, received_at, status, detail FROM twitch_events ORDER BY id DESC LIMIT 15'),
      errors: app.logger.recent({ level: 'warn', limit: 15 }).reverse(),
      pokemonCount: db().get('SELECT COUNT(*) AS n, COALESCE(SUM(enabled), 0) AS enabled FROM pokemon'),
    };
  });

  r.get('/api/admin/overview/timeline', (ctx) => {
    const sess = app.engine.session || app.engine.sessions.current(false);
    const minutes = v.num(ctx.query.get('minutes') ?? 30, { min: 0, max: 1440, int: true, name: 'Minuti' });
    if (!sess) return { points: [] };
    return sessionTimeline(db(), sess.id, { minutes });
  });

  // --- Statistiche -------------------------------------------------------------
  r.get('/api/admin/stats', (ctx) => {
    const period = ctx.query.get('period') || 'day';
    const sid = app.engine.mode === 'live' ? app.engine.session?.id : null;
    return {
      period,
      series: periodStats(db(), period),
      totals: totals(db()),
      current: sid ? { session: app.engine.sessions.byId(sid), totals: totals(db(), { sessionId: sid }) } : null,
      top: topLists(db(), { limit: 10 }),
      leaderboard: leaderboard(db(), { limit: 20 }),
    };
  });

  // --- Storico dirette --------------------------------------------------------
  r.get('/api/admin/sessions', (ctx) => {
    const limit = Math.min(200, Number(ctx.query.get('limit')) || 50);
    const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
    const demo = ctx.query.get('demo') === '1' ? 1 : 0;
    return {
      total: db().get('SELECT COUNT(*) AS n FROM stream_sessions WHERE is_demo = ?', demo).n,
      items: db().all('SELECT * FROM stream_sessions WHERE is_demo = ? ORDER BY started_at DESC LIMIT ? OFFSET ?', demo, limit, offset),
    };
  });
  r.get('/api/admin/sessions/:id', (ctx) => {
    const d = sessionDetail(db(), id(ctx.params.id));
    if (!d) throw new HttpError(404, 'Sessione non trovata');
    return d;
  });

  // --- Utenti e Pokédex --------------------------------------------------------
  r.get('/api/admin/users', (ctx) => {
    const q = `%${(ctx.query.get('q') || '').toLowerCase().replace(/[%_]/g, '')}%`;
    const demo = ctx.query.get('demo') === '1' ? 1 : 0;
    const limit = Math.min(200, Number(ctx.query.get('limit')) || 50);
    const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
    const where = 'WHERE u.is_demo = ? AND (u.login LIKE ? OR LOWER(u.display_name) LIKE ?)';
    return {
      total: db().get(`SELECT COUNT(*) AS n FROM twitch_users u ${where}`, demo, q, q).n,
      items: db().all(
        `SELECT u.*, (SELECT COUNT(*) FROM user_pokemon up WHERE up.user_id = u.id) AS total,
                (SELECT COUNT(DISTINCT pokemon_id) FROM user_pokemon up WHERE up.user_id = u.id) AS species,
                (SELECT COALESCE(SUM(is_shiny),0) FROM user_pokemon up WHERE up.user_id = u.id) AS shiny,
                EXISTS(SELECT 1 FROM user_bans b WHERE b.user_id = u.id AND b.active = 1) AS banned
         FROM twitch_users u ${where} ORDER BY total DESC, u.last_seen_at DESC LIMIT ? OFFSET ?`, demo, q, q, limit, offset),
    };
  });

  const getUser = (uid) => {
    const u = db().get('SELECT * FROM twitch_users WHERE id = ?', uid);
    if (!u) throw new HttpError(404, 'Utente non trovato');
    return u;
  };

  r.get('/api/admin/users/:id', (ctx) => {
    const u = getUser(id(ctx.params.id));
    const isDemo = !!u.is_demo;
    return {
      user: u,
      summary: summary(db(), u.id, { isDemo }),
      collection: collection(db(), u.id, { isDemo }),
      captures: captures(db(), u.id, { isDemo, limit: 200 }),
      attempts: db().all(
        `SELECT a.id, a.created_at, a.outcome, a.reject_reason, a.probability, b.name AS ball, COALESCE(p.name_it, p.name) AS pokemon
         FROM capture_attempts a LEFT JOIN ball_types b ON b.id = a.ball_type_id LEFT JOIN spawn_history s ON s.id = a.spawn_id
         LEFT JOIN pokemon p ON p.id = s.pokemon_id WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 200`, u.id),
      bans: db().all('SELECT * FROM user_bans WHERE user_id = ? ORDER BY id DESC', u.id),
    };
  });

  r.post('/api/admin/users/:id/pokemon', async (ctx) => {
    const u = getUser(id(ctx.params.id));
    const b = await readJson(ctx.req);
    const p = db().get('SELECT id FROM pokemon WHERE id = ?', id(b.pokemonId, 'Pokémon'));
    if (!p) throw new HttpError(404, 'Pokémon non trovato');
    const qty = v.num(b.quantity ?? 1, { min: 1, max: 100, int: true, name: 'Quantità' });
    db().tx(() => {
      for (let i = 0; i < qty; i++) {
        db().run("INSERT INTO user_pokemon (user_id, pokemon_id, is_shiny, is_demo, ball_name, source) VALUES (?, ?, ?, ?, ?, 'admin')",
          u.id, p.id, v.bool(b.shiny) ? 1 : 0, u.is_demo, 'Aggiunto da admin');
      }
    });
    app.log.info(`Admin: aggiunti ${qty} Pokémon a ${u.display_name}`);
    return { ok: true };
  });

  r.delete('/api/admin/users/:id/pokemon/:upid', (ctx) => {
    const u = getUser(id(ctx.params.id));
    const res = db().run('DELETE FROM user_pokemon WHERE id = ? AND user_id = ?', id(ctx.params.upid), u.id);
    if (!res.changes) throw new HttpError(404, 'Esemplare non trovato');
    return { ok: true };
  });

  r.post('/api/admin/users/:id/reset', (ctx) => {
    const u = getUser(id(ctx.params.id));
    const res = db().run('DELETE FROM user_pokemon WHERE user_id = ?', u.id);
    app.log.info(`Admin: reset Pokédex di ${u.display_name} (${res.changes} esemplari)`);
    return { ok: true, removed: res.changes };
  });

  r.post('/api/admin/users/:id/ban', async (ctx) => {
    const u = getUser(id(ctx.params.id));
    const b = await readJson(ctx.req);
    const days = b.days ? v.num(b.days, { min: 1, max: 3650, int: true, name: 'Giorni' }) : null;
    const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    db().run('INSERT INTO user_bans (user_id, reason, expires_at) VALUES (?, ?, ?)', u.id, b.reason ? v.str(b.reason, { max: 200 }) : null, expires);
    app.log.info(`Admin: ${u.display_name} escluso dal gioco`);
    return { ok: true };
  });

  r.delete('/api/admin/users/:id/ban', (ctx) => {
    const u = getUser(id(ctx.params.id));
    db().run('UPDATE user_bans SET active = 0 WHERE user_id = ?', u.id);
    return { ok: true };
  });

  // --- Spawn -------------------------------------------------------------------
  r.get('/api/admin/spawn', (ctx) => {
    const limit = Math.min(200, Number(ctx.query.get('limit')) || 50);
    return {
      settings: app.gameSettings.get('spawn'),
      engine: app.engine.status(),
      active: publicSpawn(activeSpawn(db())),
      history: db().all(
        `SELECT s.id, s.session_id, s.started_at, s.ended_at, s.status, s.is_shiny, s.is_demo, s.rarity, s.source, s.attempts, s.captures,
                COALESCE(p.name_it, p.name) AS name, p.dex_number AS dex, u.display_name AS caught_by
         FROM spawn_history s JOIN pokemon p ON p.id = s.pokemon_id LEFT JOIN twitch_users u ON u.id = s.caught_by_user_id
         ORDER BY s.id DESC LIMIT ?`, limit),
    };
  });

  r.put('/api/admin/spawn/settings', async (ctx) => {
    const b = await readJson(ctx.req);
    const s = validateSpawn(b, app.gameSettings.get('spawn'));
    const wasEnabled = app.gameSettings.get('spawn').enabled;
    app.gameSettings.set('spawn', s);
    if (s.enabled !== wasEnabled || !app.engine.nextSpawnAt) {
      if (app.engine.running && !activeSpawn(db())) app.engine.scheduleNext();
    }
    app.engine.emitStatus();
    return s;
  });

  r.post('/api/admin/spawn/manual', async (ctx) => {
    const b = await readJson(ctx.req);
    // La generazione manuale rispetta lo stato LIVE: senza diretta serve la modalità DEMO.
    if (!app.engine.running) throw new HttpError(409, 'Il motore di gioco non è attivo: il canale è offline. Usa la modalità DEMO per i test.');
    if (activeSpawn(db())) throw new HttpError(409, 'C\'è già un Pokémon in campo: terminalo prima di generarne un altro');
    const sp = app.engine.spawn({ source: 'manual', pokemonId: b.pokemonId ? id(b.pokemonId) : null, shiny: b.shiny === undefined || b.shiny === null ? null : v.bool(b.shiny) });
    if (!sp) throw new HttpError(409, app.engine.lastError || 'Impossibile generare il Pokémon');
    return sp;
  });

  r.post('/api/admin/spawn/cancel', () => {
    if (!app.engine.cancelSpawn()) throw new HttpError(409, 'Nessuno spawn attivo');
    return { ok: true };
  });

  // --- Impostazioni di gioco ----------------------------------------------------
  r.get('/api/admin/settings/game', () => {
    const s = app.gameSettings;
    return { spawn: s.get('spawn'), rarityWeights: s.get('rarityWeights'), rarityCatchBase: s.get('rarityCatchBase'), shiny: s.get('shiny'),
      capture: s.get('capture'), event: s.get('event'), lifecycle: s.get('lifecycle'), rewards: s.get('rewards') };
  });

  r.put('/api/admin/settings/game', async (ctx) => {
    const b = await readJson(ctx.req);
    const out = validateGame(b, app.gameSettings);
    for (const [k, val] of Object.entries(out)) app.gameSettings.set(k, val);
    app.log.info('Impostazioni di gioco aggiornate', { keys: Object.keys(out) });
    return out;
  });

  // --- Pokémon -----------------------------------------------------------------
  r.get('/api/admin/pokemon', (ctx) => {
    const q = ctx.query.get('q') || '';
    const rarity = ctx.query.get('rarity');
    const enabled = ctx.query.get('enabled');
    const gen = ctx.query.get('generation');
    const limit = Math.min(500, Number(ctx.query.get('limit')) || 60);
    const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
    const where = [];
    const args = [];
    if (q) {
      if (/^\d+$/.test(q)) { where.push('dex_number = ?'); args.push(Number(q)); }
      else { where.push('(LOWER(name) LIKE ? OR LOWER(name_it) LIKE ? OR slug LIKE ?)'); const l = `%${q.toLowerCase()}%`; args.push(l, l, l); }
    }
    if (rarity && RARITIES.includes(rarity)) { where.push('rarity = ?'); args.push(rarity); }
    if (enabled === '1' || enabled === '0') { where.push('enabled = ?'); args.push(Number(enabled)); }
    if (gen && /^\d+$/.test(gen)) { where.push('generation = ?'); args.push(Number(gen)); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = db().all(`SELECT * FROM pokemon ${w} ORDER BY dex_number, is_default_form DESC, id LIMIT ? OFFSET ?`, ...args, limit, offset)
      .map((p) => ({ ...p, types: JSON.parse(p.types || '[]'), image: imageUrl(p, false) }));
    return {
      total: db().get(`SELECT COUNT(*) AS n FROM pokemon ${w}`, ...args).n,
      items,
      counts: db().all('SELECT rarity, COUNT(*) AS n, SUM(enabled) AS enabled FROM pokemon GROUP BY rarity'),
      import: app.importer.progress,
    };
  });

  function pokemonPatch(b) {
    const set = [];
    const args = [];
    if (b.rarity !== undefined) { set.push('rarity = ?'); args.push(v.oneOf(b.rarity, RARITIES, 'Rarità')); }
    if (b.catch_modifier !== undefined) { set.push('catch_modifier = ?'); args.push(v.num(b.catch_modifier, { min: 0.01, max: 100, name: 'Difficoltà' })); }
    if (b.spawn_weight !== undefined) { set.push('spawn_weight = ?'); args.push(v.num(b.spawn_weight, { min: 0, max: 10000, name: 'Peso spawn' })); }
    if (b.shiny_enabled !== undefined) { set.push('shiny_enabled = ?'); args.push(v.bool(b.shiny_enabled) ? 1 : 0); }
    if (b.enabled !== undefined) { set.push('enabled = ?'); args.push(v.bool(b.enabled) ? 1 : 0); }
    if (b.name_it !== undefined) { set.push('name_it = ?'); args.push(b.name_it ? v.str(b.name_it, { max: 60 }) : null); }
    if (!set.length) throw new HttpError(400, 'Nessun campo da aggiornare');
    return { set: set.join(', '), args };
  }

  r.patch('/api/admin/pokemon/:id', async (ctx) => {
    const pid = id(ctx.params.id);
    const { set, args } = pokemonPatch(await readJson(ctx.req));
    const res = db().run(`UPDATE pokemon SET ${set} WHERE id = ?`, ...args, pid);
    if (!res.changes) throw new HttpError(404, 'Pokémon non trovato');
    return db().get('SELECT * FROM pokemon WHERE id = ?', pid);
  });

  r.post('/api/admin/pokemon/bulk', async (ctx) => {
    const b = await readJson(ctx.req);
    const { set, args } = pokemonPatch(b.patch || {});
    const where = [];
    const wargs = [];
    if (Array.isArray(b.ids) && b.ids.length) { where.push(`id IN (${b.ids.map(() => '?').join(',')})`); wargs.push(...b.ids.map((x) => id(x))); }
    if (b.rarity) { where.push('rarity = ?'); wargs.push(v.oneOf(b.rarity, RARITIES)); }
    if (b.generation) { where.push('generation = ?'); wargs.push(v.num(b.generation, { min: 1, max: 20, int: true })); }
    if (b.formsOnly) where.push('is_default_form = 0');
    if (!where.length && !b.all) throw new HttpError(400, 'Specifica un filtro (ids, rarity, generation) o all=true');
    const res = db().run(`UPDATE pokemon SET ${set} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...args, ...wargs);
    return { updated: res.changes };
  });

  r.get('/api/admin/pokemon/:id/stats', (ctx) => {
    const pid = id(ctx.params.id);
    const p = db().get('SELECT * FROM pokemon WHERE id = ?', pid);
    if (!p) throw new HttpError(404, 'Pokémon non trovato');
    return {
      pokemon: { ...p, types: JSON.parse(p.types || '[]'), image: imageUrl(p, false), shinyImage: imageUrl(p, true) },
      spawns: db().get('SELECT COUNT(*) AS n, COALESCE(SUM(is_shiny),0) AS shiny FROM spawn_history WHERE pokemon_id = ? AND is_demo = 0', pid),
      attempts: db().get(
        `SELECT COUNT(*) AS n, COALESCE(SUM(a.outcome='caught'),0) AS caught FROM capture_attempts a JOIN spawn_history s ON s.id = a.spawn_id
         WHERE s.pokemon_id = ? AND a.is_demo = 0 AND a.outcome != 'rejected'`, pid),
      owners: db().get('SELECT COUNT(DISTINCT user_id) AS n, COUNT(*) AS owned FROM user_pokemon WHERE pokemon_id = ? AND is_demo = 0', pid),
    };
  });

  r.get('/api/admin/pokemon-import', () => app.importer.progress);
  r.post('/api/admin/pokemon-import', async (ctx) => {
    const b = await readJson(ctx.req);
    if (app.importer.progress.running) throw new HttpError(409, 'Importazione già in corso');
    const generations = Array.isArray(b.generations) ? b.generations.map((g) => v.num(g, { min: 1, max: 20, int: true, name: 'Generazione' })) : [];
    app.importer.run({ generations, includeForms: v.bool(b.includeForms), images: b.images !== false, shinyImages: b.shinyImages !== false })
      .catch(() => {});
    return { started: true };
  });
  r.post('/api/admin/pokemon-import/cancel', () => { app.importer.cancel(); return { ok: true }; });
  r.post('/api/admin/pokemon-import/images', () => {
    app.importer.cacheMissingImages().then((n) => app.log.info(`Immagini scaricate: ${n}`)).catch((e) => app.log.warn('Download immagini fallito', { message: e.message }));
    return { started: true };
  });

  // --- Poké Ball ----------------------------------------------------------------
  const ballBody = (b, cur = {}) => {
    const o = { ...cur, ...b };
    return {
      code: v.str(String(o.code || '').toLowerCase(), { min: 2, max: 30, pattern: /^[a-z0-9_-]+$/, name: 'Codice' }),
      name: v.str(o.name, { min: 1, max: 40, name: 'Nome' }),
      multiplier: v.num(o.multiplier, { min: 0, max: 100, name: 'Moltiplicatore' }),
      guaranteed: v.bool(o.guaranteed) ? 1 : 0,
      enabled: o.enabled === undefined ? 1 : (v.bool(o.enabled) ? 1 : 0),
      color: v.color(o.color || '#e3350d'),
      sort_order: v.num(o.sort_order ?? 0, { min: 0, max: 1000, int: true }),
    };
  };
  r.get('/api/admin/balls', () => db().all(
    `SELECT b.*, (SELECT COUNT(*) FROM twitch_rewards r WHERE r.ball_type_id = b.id) AS rewards,
       (SELECT COUNT(*) FROM capture_attempts a WHERE a.ball_type_id = b.id AND a.is_demo = 0 AND a.outcome != 'rejected') AS used
     FROM ball_types b ORDER BY sort_order, id`));
  r.post('/api/admin/balls', async (ctx) => {
    const b = ballBody(await readJson(ctx.req));
    if (db().get('SELECT id FROM ball_types WHERE code = ?', b.code)) throw new HttpError(409, 'Codice già esistente');
    const res = db().run('INSERT INTO ball_types (code, name, multiplier, guaranteed, enabled, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      b.code, b.name, b.multiplier, b.guaranteed, b.enabled, b.color, b.sort_order);
    return db().get('SELECT * FROM ball_types WHERE id = ?', Number(res.lastInsertRowid));
  });
  r.patch('/api/admin/balls/:id', async (ctx) => {
    const bid = id(ctx.params.id);
    const cur = db().get('SELECT * FROM ball_types WHERE id = ?', bid);
    if (!cur) throw new HttpError(404, 'Poké Ball non trovata');
    const b = ballBody(await readJson(ctx.req), cur);
    db().run('UPDATE ball_types SET code = ?, name = ?, multiplier = ?, guaranteed = ?, enabled = ?, color = ?, sort_order = ? WHERE id = ?',
      b.code, b.name, b.multiplier, b.guaranteed, b.enabled, b.color, b.sort_order, bid);
    return db().get('SELECT * FROM ball_types WHERE id = ?', bid);
  });
  r.delete('/api/admin/balls/:id', (ctx) => {
    const bid = id(ctx.params.id);
    const used = db().get('SELECT COUNT(*) AS n FROM capture_attempts WHERE ball_type_id = ?', bid).n;
    if (used) {
      db().run('UPDATE ball_types SET enabled = 0 WHERE id = ?', bid);
      return { ok: true, disabled: true, message: 'La Poké Ball è già stata usata: è stata disattivata invece che eliminata' };
    }
    db().run('DELETE FROM ball_types WHERE id = ?', bid);
    return { ok: true };
  });

  // --- Sicurezza ----------------------------------------------------------------
  const securityView = (ctx) => {
    const sec = app.adminSettings.get('security');
    return {
      ...sec,
      adminHostsEffective: app.guard.adminHosts(),
      adminHostsFromEnv: app.adminHostsFromEnv,
      request: { host: ctx.req.headers.host || '', clientIp: ctx.ip, peer: ctx.req.socket.remoteAddress, https: app.secureRequest(ctx.req) },
      proxy: app.proxy.info(),
    };
  };
  r.get('/api/admin/security', (ctx) => securityView(ctx));
  r.put('/api/admin/security', async (ctx) => {
    const b = await readJson(ctx.req);
    const cur = app.adminSettings.get('security');
    const next = { ...cur };
    if (b.adminHosts !== undefined) {
      const list = (Array.isArray(b.adminHosts) ? b.adminHosts : String(b.adminHosts).split(','))
        .map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      if (list.length > 5) throw new HttpError(400, 'Puoi indicare al massimo 5 hostname');
      for (const h of list) if (!validHostname(h)) throw new HttpError(400, `Hostname non valido: ${h} (senza http:// e senza porta)`);
      if (app.adminHostsFromEnv) throw new HttpError(409, 'Gli hostname della dashboard sono impostati dalla variabile ADMIN_HOSTS');
      const here = parseHost(ctx.req.headers.host)?.hostname;
      if (list.length && !list.includes(here)) {
        throw new HttpError(400, `Per evitare di restare chiuso fuori, apri prima la dashboard da uno degli hostname indicati (ora stai usando "${here}")`);
      }
      next.adminHosts = [...new Set(list)];
    }
    if (b.bindSessionIp !== undefined) next.bindSessionIp = v.bool(b.bindSessionIp);
    if (b.idleTimeoutH !== undefined) next.idleTimeoutH = v.num(b.idleTimeoutH, { min: 1, max: 168, int: true, name: 'Ore di inattività' });
    app.adminSettings.set('security', next);
    let closed = 0;
    // Attivando l'hostname dedicato si chiudono le altre sessioni (i cui cookie
    // potrebbero essere stati creati sull'host condiviso).
    if (next.adminHosts.length && JSON.stringify(next.adminHosts) !== JSON.stringify(cur.adminHosts || [])) {
      closed = app.auth.closeOtherSessions(ctx.session.sessionId);
    }
    app.log.info('Impostazioni di sicurezza aggiornate', { adminHosts: next.adminHosts, bindSessionIp: next.bindSessionIp, closedSessions: closed });
    return { ...securityView(ctx), closedSessions: closed };
  });

  // --- Twitch --------------------------------------------------------------------
  r.get('/api/admin/twitch', () => ({
    credentials: app.credentials.publicView(),
    status: app.monitor.status(),
    lifecycle: app.sm.snapshot(),
    rewards: app.rewards.list(),
    settings: app.adminSettings.get('twitch'),
    pending: {
      broadcaster: app.oauth.pending.get('broadcaster') ? publicPending(app.oauth.pending.get('broadcaster')) : null,
      bot: app.oauth.pending.get('bot') ? publicPending(app.oauth.pending.get('bot')) : null,
    },
    scopes: { broadcaster: app.oauth.scopesFor('broadcaster'), bot: app.oauth.scopesFor('bot') },
  }));

  r.put('/api/admin/twitch/app', async (ctx) => {
    const b = await readJson(ctx.req);
    const clientId = b.clientId !== undefined ? v.str(b.clientId, { min: 10, max: 64, pattern: /^[a-z0-9]+$/, name: 'Client ID' }) : undefined;
    const clientSecret = b.clientSecret ? v.str(b.clientSecret, { min: 10, max: 64, pattern: /^[a-z0-9]+$/, name: 'Client Secret' }) : undefined;
    app.credentials.setApp({ clientId, clientSecret });
    if (b.useSeparateBot !== undefined) app.adminSettings.set('twitch', { ...app.adminSettings.get('twitch'), useSeparateBot: v.bool(b.useSeparateBot) });
    app.log.info('Credenziali applicazione Twitch aggiornate');
    return app.credentials.publicView();
  });

  r.post('/api/admin/twitch/auth/:role/start', async (ctx) => {
    const role = v.oneOf(ctx.params.role, ['broadcaster', 'bot'], 'Ruolo');
    try {
      return await app.oauth.startDeviceFlow(role);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  });

  r.post('/api/admin/twitch/auth/:role/poll', async (ctx) => {
    const role = v.oneOf(ctx.params.role, ['broadcaster', 'bot'], 'Ruolo');
    const res = await app.oauth.pollDeviceFlow(role);
    if (res.status === 'authorized') {
      app.oauth.pending.delete(role);
      if (role === 'broadcaster') {
        const t = app.credentials.getToken('broadcaster');
        app.adminSettings.set('twitch', { ...app.adminSettings.get('twitch'), channelLogin: t.login });
      }
      app.monitor.restart().catch(() => {});
    }
    return res;
  });

  r.delete('/api/admin/twitch/auth/:role', async (ctx) => {
    const role = v.oneOf(ctx.params.role, ['broadcaster', 'bot'], 'Ruolo');
    await app.oauth.revoke(role);
    if (role === 'broadcaster') { app.monitor.stop(); await app.monitor.start(); }
    return { ok: true };
  });

  r.post('/api/admin/twitch/test', async () => {
    const results = [];
    const step = async (name, fn) => {
      try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, detail: e.message }); }
    };
    await step('Client ID configurato', async () => { if (!app.credentials.clientId) throw new Error('mancante'); return 'ok'; });
    for (const role of ['broadcaster', 'bot']) {
      const t = app.credentials.getToken(role);
      if (!t?.accessToken) { if (role === 'broadcaster') results.push({ name: 'Token canale', ok: false, detail: 'account non collegato' }); continue; }
      await step(role === 'bot' ? 'Token bot' : 'Token canale', async () => {
        let info = await app.oauth.validate(t.accessToken);
        if (!info) { await app.oauth.refresh(role); info = await app.oauth.validate(app.credentials.getToken(role).accessToken); }
        if (!info) throw new Error('token non valido: ricollega l\'account');
        return `${info.login} · scope: ${(info.scopes || []).join(', ')}`;
      });
    }
    const b = app.credentials.getToken('broadcaster');
    if (b?.userId) {
      await step('API Helix /streams', async () => ((await app.helix.getStream(b.userId)) ? 'canale LIVE' : 'canale offline'));
      await step('Channel Points', async () => `${(await app.helix.getRewards(b.userId)).length} ricompense trovate`);
    }
    await step('EventSub WebSocket', async () => { if (!app.monitor.eventsub?.connected) throw new Error('non connesso'); return 'connesso'; });
    return { results };
  });

  r.post('/api/admin/twitch/reconnect', async () => { await app.monitor.restart(); return app.monitor.status(); });

  r.get('/api/admin/twitch/events', (ctx) => {
    const limit = Math.min(500, Number(ctx.query.get('limit')) || 100);
    return db().all('SELECT id, message_id, event_type, received_at, status, detail FROM twitch_events ORDER BY id DESC LIMIT ?', limit);
  });

  // Ricompense
  r.get('/api/admin/twitch/rewards', () => app.rewards.list());
  r.get('/api/admin/twitch/rewards/remote', async () => {
    try { return await app.rewards.remote(); } catch (e) { throw new HttpError(e.status === 403 ? 403 : 400, rewardError(e)); }
  });
  r.post('/api/admin/twitch/rewards', async (ctx) => {
    const b = await readJson(ctx.req);
    try {
      return await app.rewards.create({
        ballTypeId: id(b.ballTypeId, 'Poké Ball'),
        title: b.title ? v.str(b.title, { min: 1, max: 45, name: 'Titolo' }) : undefined,
        cost: v.num(b.cost ?? 500, { min: 1, max: 10000000, int: true, name: 'Costo' }),
        prompt: b.prompt ? v.str(b.prompt, { max: 200, name: 'Descrizione' }) : undefined,
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, rewardError(e));
    }
  });
  r.post('/api/admin/twitch/rewards/link', async (ctx) => {
    const b = await readJson(ctx.req);
    try {
      return app.rewards.link({ rewardId: String(b.rewardId || '').trim(), ballTypeId: id(b.ballTypeId, 'Poké Ball'), title: b.title, cost: b.cost });
    } catch (e) { throw new HttpError(400, e.message); }
  });
  r.patch('/api/admin/twitch/rewards/:id', async (ctx) => {
    const b = await readJson(ctx.req);
    try {
      return await app.rewards.update(id(ctx.params.id), {
        ballTypeId: b.ballTypeId !== undefined ? id(b.ballTypeId) : undefined,
        isEnabled: b.isEnabled !== undefined ? v.bool(b.isEnabled) : undefined,
        cost: b.cost !== undefined ? v.num(b.cost, { min: 1, max: 10000000, int: true, name: 'Costo' }) : undefined,
        title: b.title !== undefined ? v.str(b.title, { min: 1, max: 45 }) : undefined,
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, rewardError(e));
    }
  });
  // Riscatti: stato su Twitch, recupero di quelli rimasti in coda, pausa ricompense.
  r.get('/api/admin/twitch/redemptions', () => ({
    last: app.monitor.reconciler.last,
    pending: app.monitor.reconciler.pending(),
    recovered: app.monitor.reconciler.recentRecovered(),
    rewardsPause: app.monitor.status().rewardsPause,
    settings: app.gameSettings.get('rewards'),
  }));
  r.post('/api/admin/twitch/redemptions/reconcile', async () => {
    if (!app.credentials.getToken('broadcaster')?.userId) throw new HttpError(400, 'Collega prima l\'account Twitch del canale');
    return app.monitor.reconciler.run('manuale');
  });
  r.post('/api/admin/twitch/rewards/sync-pause', async () => {
    await app.monitor.syncRewardPause({ force: true });
    return { ...app.monitor.status().rewardsPause, rewards: app.rewards.list() };
  });
  r.get('/api/admin/settings/rewards', () => app.gameSettings.get('rewards'));
  r.put('/api/admin/settings/rewards', async (ctx) => {
    const out = validateGame({ rewards: await readJson(ctx.req) }, app.gameSettings);
    app.gameSettings.set('rewards', out.rewards);
    app.monitor.syncRewardPause();
    return out.rewards;
  });
  r.delete('/api/admin/twitch/rewards/:id', (ctx) => { app.rewards.remove(id(ctx.params.id)); return { ok: true }; });
  r.post('/api/admin/twitch/rewards/verify', async () => {
    try { return await app.rewards.verify(); } catch (e) { throw new HttpError(400, rewardError(e)); }
  });

  // --- Comandi chat ----------------------------------------------------------------
  r.get('/api/admin/commands', () => ({ globals: app.gameSettings.get('commands'), commands: listCommands(db()) }));
  r.put('/api/admin/commands/globals', async (ctx) => {
    const g = validateCommandGlobals(await readJson(ctx.req), app.gameSettings.get('commands'));
    app.gameSettings.set('commands', g);
    return g;
  });
  r.patch('/api/admin/commands/:command', async (ctx) => {
    const cur = db().get('SELECT * FROM command_settings WHERE command = ?', ctx.params.command);
    if (!cur) throw new HttpError(404, 'Comando non trovato');
    const b = await readJson(ctx.req);
    const options = { ...JSON.parse(cur.options || '{}') };
    if (b.options?.allowOthers !== undefined) options.allowOthers = v.bool(b.options.allowOthers);
    if (b.options?.size !== undefined) options.size = v.num(b.options.size, { min: 1, max: 10, int: true, name: 'Dimensione classifica' });
    const aliases = Array.isArray(b.aliases) ? b.aliases.map((a) => v.str(a, { min: 1, max: 25, pattern: /^[a-z0-9àèéìòù_]+$/i, name: 'Alias' }).toLowerCase()) : JSON.parse(cur.aliases);
    db().run(
      `UPDATE command_settings SET enabled = ?, aliases = ?, response = ?, response_empty = ?, global_cooldown_s = ?, user_cooldown_s = ?, options = ?, updated_at = ?
       WHERE command = ?`,
      b.enabled === undefined ? cur.enabled : (v.bool(b.enabled) ? 1 : 0),
      JSON.stringify(aliases),
      b.response !== undefined ? v.str(b.response, { min: 1, max: 450, name: 'Risposta' }) : cur.response,
      b.response_empty !== undefined ? (b.response_empty ? v.str(b.response_empty, { max: 450, name: 'Risposta vuota' }) : null) : cur.response_empty,
      b.global_cooldown_s !== undefined ? v.num(b.global_cooldown_s, { min: 0, max: 3600, int: true, name: 'Cooldown globale' }) : cur.global_cooldown_s,
      b.user_cooldown_s !== undefined ? v.num(b.user_cooldown_s, { min: 0, max: 3600, int: true, name: 'Cooldown utente' }) : cur.user_cooldown_s,
      JSON.stringify(options), new Date().toISOString(), cur.command);
    return listCommands(db()).find((c) => c.command === cur.command);
  });
  // Prova di un comando dalla dashboard: la risposta NON viene inviata in chat.
  r.post('/api/admin/commands/test', async (ctx) => {
    const b = await readJson(ctx.req);
    const login = v.str(b.login || 'admin_test', { max: 25, pattern: /^[A-Za-z0-9_]+$/, name: 'Utente' });
    const u = db().get('SELECT * FROM twitch_users WHERE login = ? ORDER BY is_demo LIMIT 1', login.toLowerCase());
    const user = u ? { twitchId: u.twitch_id, login: u.login, displayName: u.display_name } : { twitchId: `test:${login}`, login, displayName: login };
    const out = app.commands.execute(
      listCommands(db()).find((c) => {
        const conf = app.commands.conf();
        const name = String(b.text || '').trim().slice(conf.prefix.length).split(/\s+/)[0].toLowerCase();
        return c.command === name || c.aliases.includes(name);
      }) || { command: '__none' },
      String(b.text || '').trim().split(/\s+/).slice(1), { user }, { isDemo: !!u?.is_demo, conf: app.commands.conf() });
    return { reply: out || '(nessuna risposta: comando sconosciuto o disattivato)' };
  });

  // --- Overlay ---------------------------------------------------------------------
  // Formato delle versioni precedenti: legge/modifica il tema attivo (vedi anche src/api/overlay.js).
  r.get('/api/admin/overlay', () => app.themes.effective());
  r.put('/api/admin/overlay', async (ctx) => {
    const body = await readJson(ctx.req);
    const out = validateOverlay(body, { get: (k) => app.themes.effective()[k] });
    // Dimensioni della sorgente OBS: informazione di configurazione, non del tema.
    if (out.layout) app.overlaySettings.set('layout', { ...app.overlaySettings.get('layout'), width: out.layout.width, height: out.layout.height });
    app.themes.applyLegacy(out);
    const all = app.themes.effective();
    app.hub.overlay('settings', all);
    return all;
  });

  // --- Pagine pubbliche -----------------------------------------------------------
  r.get('/api/admin/public-pages', () => app.adminSettings.get('publicPages'));
  r.put('/api/admin/public-pages', async (ctx) => {
    const b = await readJson(ctx.req);
    const cur = app.adminSettings.get('publicPages');
    const next = { landing: v.bool(b.landing ?? cur.landing), pokedex: v.bool(b.pokedex ?? cur.pokedex), leaderboard: v.bool(b.leaderboard ?? cur.leaderboard) };
    app.adminSettings.set('publicPages', next);
    return next;
  });

  // --- Modalità DEMO (separata dalla LIVE, non contamina le statistiche) ------------
  r.post('/api/admin/demo/start', () => {
    if ([STATES.LIVE, STATES.PAUSED].includes(app.sm.state)) throw new HttpError(409, 'Non puoi usare la DEMO mentre il canale è in diretta');
    try { app.engine.startDemo(); } catch (e) { throw new HttpError(409, e.message); }
    return app.engine.status();
  });
  r.post('/api/admin/demo/stop', () => { app.engine.stopDemo(); return app.engine.status(); });
  r.post('/api/admin/demo/throw', async (ctx) => {
    if (app.engine.mode !== 'demo') throw new HttpError(409, 'Avvia prima la modalità DEMO');
    const b = await readJson(ctx.req);
    const name = v.str(b.username || 'Spettatore_Demo', { min: 1, max: 25, pattern: /^[A-Za-z0-9_]+$/, name: 'Nome spettatore' });
    const res = app.engine.attempt({
      redemptionId: `demo-${randomToken(9)}`,
      ballTypeId: id(b.ballTypeId, 'Poké Ball'),
      user: { twitchId: `demo:${name.toLowerCase()}`, login: name.toLowerCase(), displayName: name },
      redeemedAt: new Date().toISOString(),
      isDemo: true,
    });
    return { rejected: !!res.rejected, reason: res.reason || null, caught: !!res.caught, probability: res.probability ?? null, fled: res.spawnEnded === 'fled' };
  });
  r.post('/api/admin/demo/command', async (ctx) => {
    if (app.engine.mode !== 'demo') throw new HttpError(409, 'Avvia prima la modalità DEMO');
    const b = await readJson(ctx.req);
    const name = v.str(b.username || 'Spettatore_Demo', { min: 1, max: 25, pattern: /^[A-Za-z0-9_]+$/, name: 'Nome spettatore' });
    const out = app.commands.handle(
      { text: v.str(b.text || '', { min: 1, max: 200, name: 'Messaggio' }), user: { twitchId: `demo:${name.toLowerCase()}`, login: name.toLowerCase(), displayName: name } },
      { isDemo: true });
    return { reply: out?.reply || null, ignored: out?.ignored || (out ? null : 'non è un comando attivo') };
  });
  r.post('/api/admin/demo/clear', () => {
    if (app.engine.mode === 'demo') throw new HttpError(409, 'Ferma prima la modalità DEMO');
    const res = db().tx(() => {
      db().run('DELETE FROM capture_attempts WHERE is_demo = 1');
      db().run('DELETE FROM user_pokemon WHERE is_demo = 1');
      db().run('DELETE FROM spawn_history WHERE is_demo = 1');
      db().run('DELETE FROM stream_sessions WHERE is_demo = 1');
      return db().run('DELETE FROM twitch_users WHERE is_demo = 1').changes;
    });
    return { ok: true, users: res };
  });

  // --- Backup e sistema ------------------------------------------------------------
  r.get('/api/admin/backups', () => ({ items: app.backups.list(), settings: app.adminSettings.get('backup') }));
  r.post('/api/admin/backups', () => app.backups.create('manual'));
  r.put('/api/admin/backups/settings', async (ctx) => {
    const b = await readJson(ctx.req);
    const cur = app.adminSettings.get('backup');
    const next = {
      autoEnabled: v.bool(b.autoEnabled ?? cur.autoEnabled),
      hour: v.num(b.hour ?? cur.hour, { min: 0, max: 23, int: true, name: 'Ora' }),
      keep: v.num(b.keep ?? cur.keep, { min: 1, max: 365, int: true, name: 'Backup da conservare' }),
    };
    app.adminSettings.set('backup', next);
    return next;
  });
  r.get('/api/admin/backups/:name/download', (ctx) => {
    let p;
    try { p = app.backups.path(ctx.params.name); } catch (e) { throw new HttpError(404, e.message); }
    ctx.res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${ctx.params.name}"`,
      'Content-Length': statSync(p).size,
    });
    ctx.res.end(readFileSync(p));
  });
  r.delete('/api/admin/backups/:name', (ctx) => {
    try { app.backups.remove(ctx.params.name); } catch (e) { throw new HttpError(404, e.message); }
    return { ok: true };
  });
  r.post('/api/admin/backups/:name/restore', async (ctx) => {
    try { return await app.restore(ctx.params.name); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `Ripristino non riuscito: ${e.message}`);
    }
  });
  r.post('/api/admin/backups-upload', async (ctx) => {
    const buf = await readBody(ctx.req, 512 * 1024 * 1024);
    try { return { filename: app.backups.saveUpload(buf) }; } catch (e) { throw new HttpError(400, e.message); }
  });
  r.get('/api/admin/export', (ctx) => {
    const data = app.backups.exportJson();
    const name = `livecatch-export-${new Date().toISOString().slice(0, 10)}.json`;
    ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"` });
    ctx.res.end(JSON.stringify(data, null, 1));
  });
  r.post('/api/admin/import', async (ctx) => {
    const b = await readJson(ctx.req, 200 * 1024 * 1024);
    try {
      app.backups.create('manual', 'prima di un\'importazione JSON');
      return app.backups.importJson(b.data || b, { mode: b.mode === 'replace' ? 'replace' : 'merge' });
    } catch (e) { throw new HttpError(400, e.message); }
  });

  r.get('/api/admin/system', () => {
    const c = app.config;
    let disk = null;
    try { const s = statfsSync(c.dataDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { /* non supportato */ }
    const size = (p) => { try { return existsSync(p) ? statSync(p).size : 0; } catch { return 0; } };
    const backupsBytes = app.backups.list().reduce((s, b) => s + (b.size_bytes || 0), 0);
    const mem = process.memoryUsage();
    return {
      version: c.version,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeS: Math.round(process.uptime()),
      startedAt: app.startedAt.toISOString(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
      dataDir: c.dataDir,
      schemaVersion: app.db.schemaVersion(),
      storage: {
        database: size(c.dbPath) + size(c.dbPath + '-wal'),
        images: app.importer.imageStats(),
        backups: backupsBytes,
        logs: size(`${c.logsDir}/app.log`),
        disk,
      },
      components: {
        api: 'ok',
        database: app.db.integrityCheck() ? 'ok' : 'error',
        websocket: app.hub.counts(),
        twitch: app.monitor.status().eventsubConnected ? 'connesso' : 'non connesso',
        lifecycle: app.sm.state,
        engine: app.engine.running ? app.engine.mode : 'fermo',
      },
    };
  });

  r.get('/api/admin/logs', (ctx) => app.logger.recent({ level: ctx.query.get('level') || 'info', limit: Math.min(1000, Number(ctx.query.get('limit')) || 300) }).reverse());
}

function publicPending(p) {
  return { userCode: p.userCode, verificationUri: p.verificationUri, expiresAt: p.expiresAt, status: p.status, error: p.error };
}

function rewardError(e) {
  if (e.status === 403) return 'Twitch ha negato l\'operazione: il canale deve essere Affiliate o Partner e la ricompensa deve essere stata creata da questa app per poterla modificare.';
  if (e.status === 400 && /DUPLICATE/i.test(JSON.stringify(e.body || ''))) return 'Esiste già una ricompensa con questo titolo';
  return e.message;
}
