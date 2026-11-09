// Elaborazione dei tentativi di cattura. Tutto il calcolo avviene lato backend,
// dentro una transazione: idempotenza (redemption_id univoco), controllo della
// sessione LIVE, validità dello spawn, limiti e modalità a vincitore singolo.
import { nowIso } from '../database/index.js';
import { upsertUser, isBanned } from '../pokedex/users.js';

export function captureProbability({ settings, rarity, catchModifier = 1, ball, isShiny }) {
  const c = settings.capture;
  if (ball.guaranteed && c.masterBallEnabled) return 1;
  let p = (settings.rarityCatchBase[rarity] ?? 0.3) * catchModifier * ball.multiplier * (c.globalModifier ?? 1);
  if (isShiny) p *= settings.shiny.catchModifier ?? 1;
  if (settings.event?.enabled) p *= settings.event.catchModifier ?? 1;
  return Math.min(c.maxChance ?? 0.95, Math.max(c.minChance ?? 0.01, p));
}

export function resolveBallForReward(db, rewardId) {
  return db.get(
    `SELECT b.*, r.reward_id, r.managed_by_app, r.is_enabled AS reward_enabled
     FROM twitch_rewards r JOIN ball_types b ON b.id = r.ball_type_id WHERE r.reward_id = ?`, rewardId) || null;
}

// input: { redemptionId, rewardId?, ballTypeId? (demo), user: {twitchId, login, displayName},
//          redeemedAt, isDemo, accepting: {ok, reason}, sessionId }
export function processAttempt(db, settings, input, rng = Math.random) {
  return db.tx(() => {
    if (input.redemptionId) {
      const dup = db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', input.redemptionId);
      if (dup) return { duplicate: true, attempt: dup };
    }

    let ball;
    if (input.isDemo && input.ballTypeId) {
      ball = db.get('SELECT * FROM ball_types WHERE id = ?', input.ballTypeId);
    } else {
      ball = resolveBallForReward(db, input.rewardId);
      if (!ball) return { ignored: true }; // ricompensa non associata al gioco: non la tocchiamo
    }

    const user = upsertUser(db, { ...input.user, isDemo: input.isDemo });
    const reject = (reason, extra = {}) => {
      const r = db.run(
        `INSERT INTO capture_attempts (redemption_id, user_id, spawn_id, session_id, ball_type_id, reward_id, is_demo, outcome, reject_reason, redeemed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?)`,
        input.redemptionId || null, user.id, extra.spawnId ?? null, input.sessionId ?? null, ball?.id ?? null,
        input.rewardId || null, input.isDemo ? 1 : 0, reason, input.redeemedAt || nowIso(),
      );
      return { rejected: true, reason, user, ball, attemptId: Number(r.lastInsertRowid), managed: !!ball?.managed_by_app, spawnId: extra.spawnId ?? null };
    };

    if (!input.accepting?.ok) return reject(input.accepting?.reason || 'offline');
    if (!ball || !ball.enabled || (!input.isDemo && !ball.reward_enabled)) return reject('ball_disabled');
    if (isBanned(db, user.id)) return reject('banned');

    const spawnRow = db.get(
      `SELECT s.*, p.catch_modifier, p.name, p.name_it, p.dex_number FROM spawn_history s JOIN pokemon p ON p.id = s.pokemon_id
       WHERE s.status = 'active' LIMIT 1`);
    if (!spawnRow || !!spawnRow.is_demo !== !!input.isDemo || spawnRow.session_id !== input.sessionId) return reject('no_spawn');

    const grace = (settings.spawn.lateGraceS ?? 5) * 1000;
    const redeemedMs = Date.parse(input.redeemedAt || nowIso());
    if (redeemedMs + grace < Date.parse(spawnRow.started_at)) return reject('late', { spawnId: spawnRow.id });
    if (Math.min(redeemedMs, Date.now()) > Date.parse(spawnRow.expires_at) + grace) return reject('expired', { spawnId: spawnRow.id });

    const maxUser = settings.spawn.maxAttemptsPerUser || 0;
    if (maxUser > 0) {
      const n = db.get(
        "SELECT COUNT(*) AS n FROM capture_attempts WHERE spawn_id = ? AND user_id = ? AND outcome != 'rejected'", spawnRow.id, user.id).n;
      if (n >= maxUser) return reject('user_limit', { spawnId: spawnRow.id });
    }
    if (spawnRow.capture_mode === 'multi') {
      const already = db.get('SELECT id FROM user_pokemon WHERE spawn_id = ? AND user_id = ?', spawnRow.id, user.id);
      if (already) return reject('already_caught', { spawnId: spawnRow.id });
    }

    const probability = captureProbability({
      settings, rarity: spawnRow.rarity, catchModifier: spawnRow.catch_modifier, ball, isShiny: !!spawnRow.is_shiny,
    });
    const roll = rng();
    let caught = roll < probability;
    let spawnEnded = null;
    let userPokemonId = null;

    if (caught && spawnRow.capture_mode === 'single') {
      // Concorrenza: solo il primo che riesce a "chiudere" lo spawn vince.
      const upd = db.run(
        "UPDATE spawn_history SET status = 'caught', ended_at = ?, caught_by_user_id = ? WHERE id = ? AND status = 'active'",
        nowIso(), user.id, spawnRow.id);
      if (upd.changes !== 1) return reject('already_caught', { spawnId: spawnRow.id });
      spawnEnded = 'caught';
    }
    if (caught) {
      const r = db.run(
        `INSERT INTO user_pokemon (user_id, pokemon_id, is_shiny, is_demo, ball_type_id, ball_name, session_id, spawn_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'capture')`,
        user.id, spawnRow.pokemon_id, spawnRow.is_shiny, input.isDemo ? 1 : 0, ball.id, ball.name, spawnRow.session_id, spawnRow.id);
      userPokemonId = Number(r.lastInsertRowid);
    }

    const ins = db.run(
      `INSERT INTO capture_attempts (redemption_id, user_id, spawn_id, session_id, ball_type_id, reward_id, is_demo, probability, roll, outcome, user_pokemon_id, redeemed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.redemptionId || null, user.id, spawnRow.id, spawnRow.session_id, ball.id, input.rewardId || null,
      input.isDemo ? 1 : 0, probability, roll, caught ? 'caught' : 'failed', userPokemonId, input.redeemedAt || nowIso());

    db.run('UPDATE spawn_history SET attempts = attempts + 1, captures = captures + ? WHERE id = ?', caught ? 1 : 0, spawnRow.id);
    db.run(
      `UPDATE stream_sessions SET attempts = attempts + 1, captures = captures + ?, failures = failures + ?,
        participants = (SELECT COUNT(DISTINCT user_id) FROM capture_attempts WHERE session_id = ? AND outcome != 'rejected')
       WHERE id = ?`,
      caught ? 1 : 0, caught ? 0 : 1, spawnRow.session_id, spawnRow.session_id);

    const maxSpawn = settings.spawn.maxAttemptsPerSpawn || 0;
    if (!spawnEnded && maxSpawn > 0) {
      const total = db.get('SELECT attempts FROM spawn_history WHERE id = ?', spawnRow.id).attempts;
      if (total >= maxSpawn) {
        const upd = db.run("UPDATE spawn_history SET status = 'fled', ended_at = ? WHERE id = ? AND status = 'active'", nowIso(), spawnRow.id);
        if (upd.changes === 1) spawnEnded = 'fled';
      }
    }

    return {
      ok: true,
      caught,
      probability,
      roll,
      user,
      ball,
      attemptId: Number(ins.lastInsertRowid),
      userPokemonId,
      spawnId: spawnRow.id,
      spawnEnded,
      managed: !!ball.managed_by_app,
      pokemon: { id: spawnRow.pokemon_id, name: spawnRow.name_it || spawnRow.name, dex: spawnRow.dex_number, shiny: !!spawnRow.is_shiny, rarity: spawnRow.rarity },
    };
  });
}

// Riscossione annullata/rifiutata da un moderatore (EventSub redemption.update).
export function handleRedemptionUpdate(db, settings, { redemptionId, status }) {
  return db.tx(() => {
    const a = db.get('SELECT * FROM capture_attempts WHERE redemption_id = ?', redemptionId);
    if (!a) return { found: false };
    db.run('UPDATE capture_attempts SET redemption_status = ? WHERE id = ?', status, a.id);
    let revoked = false;
    if (String(status).toLowerCase() === 'canceled' && a.user_pokemon_id && settings.capture.revokeOnCancel) {
      db.run('DELETE FROM user_pokemon WHERE id = ?', a.user_pokemon_id);
      revoked = true;
    }
    return { found: true, revoked, attempt: a };
  });
}
