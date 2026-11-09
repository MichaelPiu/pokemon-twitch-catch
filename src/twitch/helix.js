// Client per le API Helix di Twitch con rinnovo automatico dei token.
export class HelixError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class Helix {
  constructor({ config, credentials, oauth, log, fetchImpl = fetch }) {
    this.base = config.twitch.helixBase;
    this.creds = credentials;
    this.oauth = oauth;
    this.log = log;
    this.fetch = fetchImpl;
    this.refreshing = new Map();
  }

  async token(role) {
    const t = this.creds.getToken(role);
    if (!t?.accessToken) throw Object.assign(new HelixError(401, `Account Twitch (${role}) non collegato`), { authInvalid: true });
    if (t.expiresAt && t.expiresAt - Date.now() < 120000) return this.refresh(role);
    return t.accessToken;
  }

  async refresh(role) {
    if (!this.refreshing.has(role)) {
      this.refreshing.set(role, this.oauth.refresh(role).finally(() => this.refreshing.delete(role)));
    }
    return this.refreshing.get(role);
  }

  async request(method, path, { query, body, role = 'broadcaster', retry = true } = {}) {
    const url = new URL(this.base + path);
    if (query) {
      for (const [k, val] of Object.entries(query)) {
        if (val === undefined || val === null) continue;
        if (Array.isArray(val)) val.forEach((x) => url.searchParams.append(k, x));
        else url.searchParams.set(k, String(val));
      }
    }
    const token = await this.token(role);
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': this.creds.clientId,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      await this.refresh(role);
      return this.request(method, path, { query, body, role, retry: false });
    }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
    if (res.status >= 400) {
      throw new HelixError(res.status, `Helix ${method} ${path}: ${data?.message || res.status}`, data);
    }
    return data;
  }

  // --- Endpoint usati dall'applicazione ---------------------------------------
  async getUsers({ logins = [], ids = [] } = {}) {
    const r = await this.request('GET', '/users', { query: { login: logins, id: ids } });
    return r?.data || [];
  }

  async getStream(broadcasterId) {
    const r = await this.request('GET', '/streams', { query: { user_id: broadcasterId, type: 'live' } });
    return r?.data?.[0] || null;
  }

  async createSubscription(type, version, condition, sessionId) {
    return this.request('POST', '/eventsub/subscriptions', {
      body: { type, version, condition, transport: { method: 'websocket', session_id: sessionId } },
    });
  }

  async sendChatMessage({ broadcasterId, senderId, message, replyTo, role }) {
    const r = await this.request('POST', '/chat/messages', {
      role,
      body: { broadcaster_id: broadcasterId, sender_id: senderId, message, ...(replyTo ? { reply_parent_message_id: replyTo } : {}) },
    });
    return r?.data?.[0] || null;
  }

  async getRewards(broadcasterId, { onlyManageable = false, ids } = {}) {
    const r = await this.request('GET', '/channel_points/custom_rewards', {
      query: { broadcaster_id: broadcasterId, only_manageable_rewards: onlyManageable || undefined, id: ids },
    });
    return r?.data || [];
  }

  async createReward(broadcasterId, data) {
    const r = await this.request('POST', '/channel_points/custom_rewards', { query: { broadcaster_id: broadcasterId }, body: data });
    return r?.data?.[0];
  }

  async updateReward(broadcasterId, rewardId, data) {
    const r = await this.request('PATCH', '/channel_points/custom_rewards', { query: { broadcaster_id: broadcasterId, id: rewardId }, body: data });
    return r?.data?.[0];
  }

  async updateRedemption(broadcasterId, rewardId, redemptionId, status) {
    return this.request('PATCH', '/channel_points/custom_rewards/redemptions', {
      query: { broadcaster_id: broadcasterId, reward_id: rewardId, id: redemptionId },
      body: { status },
    });
  }
}
