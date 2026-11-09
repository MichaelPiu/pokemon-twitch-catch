// Gestione delle Channel Points Rewards associate alle Poké Ball.
import { nowIso } from '../database/index.js';

export class RewardsService {
  constructor({ db, helix, credentials, log }) {
    this.db = db;
    this.helix = helix;
    this.creds = credentials;
    this.log = log;
  }

  broadcasterId() {
    const b = this.creds.getToken('broadcaster');
    if (!b?.userId) throw new Error('Collega prima l\'account Twitch del canale');
    return b.userId;
  }

  list() {
    return this.db.all(
      `SELECT r.*, b.name AS ball_name, b.code AS ball_code FROM twitch_rewards r
       LEFT JOIN ball_types b ON b.id = r.ball_type_id ORDER BY r.id`);
  }

  // Ricompense esistenti sul canale (per collegarle manualmente).
  async remote() {
    const bid = this.broadcasterId();
    const [all, manageable] = await Promise.all([
      this.helix.getRewards(bid),
      this.helix.getRewards(bid, { onlyManageable: true }).catch(() => []),
    ]);
    const mset = new Set(manageable.map((r) => r.id));
    return all.map((r) => ({
      id: r.id, title: r.title, cost: r.cost, isEnabled: r.is_enabled, isPaused: r.is_paused,
      manageable: mset.has(r.id), linked: !!this.db.get('SELECT id FROM twitch_rewards WHERE reward_id = ?', r.id),
    }));
  }

  // Crea una nuova ricompensa tramite API (richiede canale Affiliate/Partner).
  async create({ ballTypeId, title, cost, prompt, color }) {
    const ball = this.db.get('SELECT * FROM ball_types WHERE id = ?', ballTypeId);
    if (!ball) throw new Error('Poké Ball non trovata');
    const bid = this.broadcasterId();
    const reward = await this.helix.createReward(bid, {
      title: title || `Lancia una ${ball.name}`,
      cost: cost || 500,
      prompt: prompt || `Lancia una ${ball.name} al Pokémon apparso in diretta!`,
      is_enabled: true,
      background_color: color || ball.color,
      should_redemptions_skip_request_queue: false,
    });
    this.db.run(
      `INSERT INTO twitch_rewards (reward_id, ball_type_id, title, cost, is_enabled, managed_by_app, last_verified_at, verify_status)
       VALUES (?, ?, ?, ?, 1, 1, ?, 'ok')`,
      reward.id, ball.id, reward.title, reward.cost, nowIso());
    this.log.info(`Ricompensa creata: ${reward.title}`);
    return reward;
  }

  // Collega una ricompensa esistente tramite il suo ID ufficiale.
  link({ rewardId, ballTypeId, title, cost }) {
    if (!/^[0-9a-f-]{36}$/i.test(String(rewardId || ''))) throw new Error('ID ricompensa non valido (atteso formato UUID)');
    const ball = this.db.get('SELECT id FROM ball_types WHERE id = ?', ballTypeId);
    if (!ball) throw new Error('Poké Ball non trovata');
    this.db.run(
      `INSERT INTO twitch_rewards (reward_id, ball_type_id, title, cost, is_enabled, managed_by_app)
       VALUES (?, ?, ?, ?, 1, 0)
       ON CONFLICT(reward_id) DO UPDATE SET ball_type_id = excluded.ball_type_id, title = excluded.title`,
      rewardId, ballTypeId, title || 'Ricompensa collegata', cost ?? null);
    return this.db.get('SELECT * FROM twitch_rewards WHERE reward_id = ?', rewardId);
  }

  async update(id, { ballTypeId, isEnabled, cost, title }) {
    const r = this.db.get('SELECT * FROM twitch_rewards WHERE id = ?', id);
    if (!r) throw new Error('Ricompensa non trovata');
    if (r.managed_by_app && (isEnabled !== undefined || cost !== undefined || title !== undefined)) {
      const patch = {};
      if (isEnabled !== undefined) patch.is_enabled = !!isEnabled;
      if (cost !== undefined) patch.cost = cost;
      if (title !== undefined) patch.title = title;
      await this.helix.updateReward(this.broadcasterId(), r.reward_id, patch);
    }
    this.db.run(
      `UPDATE twitch_rewards SET ball_type_id = COALESCE(?, ball_type_id), is_enabled = COALESCE(?, is_enabled),
        cost = COALESCE(?, cost), title = COALESCE(?, title) WHERE id = ?`,
      ballTypeId ?? null, isEnabled === undefined ? null : (isEnabled ? 1 : 0), cost ?? null, title ?? null, id);
    return this.db.get('SELECT * FROM twitch_rewards WHERE id = ?', id);
  }

  remove(id) {
    this.db.run('DELETE FROM twitch_rewards WHERE id = ?', id);
  }

  // Verifica che gli ID salvati esistano ancora su Twitch.
  async verify() {
    const remote = await this.helix.getRewards(this.broadcasterId());
    const manageable = new Set((await this.helix.getRewards(this.broadcasterId(), { onlyManageable: true }).catch(() => [])).map((r) => r.id));
    const byId = new Map(remote.map((r) => [r.id, r]));
    const results = [];
    for (const local of this.list()) {
      const rem = byId.get(local.reward_id);
      const status = rem ? 'ok' : 'missing';
      this.db.run(
        'UPDATE twitch_rewards SET verify_status = ?, last_verified_at = ?, title = COALESCE(?, title), cost = COALESCE(?, cost), managed_by_app = ? WHERE id = ?',
        status, nowIso(), rem?.title ?? null, rem?.cost ?? null, manageable.has(local.reward_id) ? 1 : 0, local.id);
      results.push({ id: local.id, rewardId: local.reward_id, status, title: rem?.title || local.title, remoteEnabled: rem?.is_enabled ?? null });
    }
    return results;
  }
}
