// OAuth Twitch tramite Device Code Grant Flow: funziona in rete locale senza
// redirect HTTPS pubblici. L'utente apre twitch.tv/activate e inserisce un codice.
import { BROADCASTER_SCOPES, BOT_SCOPES } from '../configuration/defaults.js';

export class TwitchOAuth {
  constructor({ config, credentials, log, fetchImpl = fetch }) {
    this.base = config.twitch.oauthBase;
    this.creds = credentials;
    this.log = log;
    this.fetch = fetchImpl;
    this.pending = new Map(); // role -> stato del device flow (solo in memoria)
  }

  scopesFor(role) { return role === 'bot' ? BOT_SCOPES : BROADCASTER_SCOPES; }

  async form(path, params) {
    const res = await this.fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let body = {};
    try { body = await res.json(); } catch { /* corpo vuoto */ }
    return { status: res.status, body };
  }

  async startDeviceFlow(role) {
    const clientId = this.creds.clientId;
    if (!clientId) throw new Error('Configura prima il Client ID Twitch');
    const scopes = this.scopesFor(role).join(' ');
    const { status, body } = await this.form('/device', { client_id: clientId, scopes });
    if (status !== 200) throw new Error(`Twitch ha rifiutato la richiesta: ${body.message || status}`);
    const state = {
      role,
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      interval: Math.max(1, body.interval || 5),
      expiresAt: Date.now() + (body.expires_in || 1800) * 1000,
      scopes,
      status: 'pending',
      error: null,
    };
    this.pending.set(role, state);
    return { userCode: state.userCode, verificationUri: state.verificationUri, expiresAt: state.expiresAt, interval: state.interval };
  }

  // Un singolo tentativo di polling. Ritorna lo stato del flusso.
  async pollDeviceFlow(role) {
    const st = this.pending.get(role);
    if (!st) return { status: 'none' };
    if (st.status !== 'pending') return { status: st.status, error: st.error };
    if (Date.now() > st.expiresAt) {
      st.status = 'expired';
      return { status: 'expired' };
    }
    const params = {
      client_id: this.creds.clientId,
      scopes: st.scopes,
      device_code: st.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    };
    const secret = this.creds.clientSecret;
    if (secret) params.client_secret = secret;
    const { status, body } = await this.form('/token', params);
    if (status === 200 && body.access_token) {
      const info = await this.validate(body.access_token);
      if (!info) {
        st.status = 'error';
        st.error = 'Token ricevuto ma non valido';
        return { status: 'error', error: st.error };
      }
      this.creds.setToken(role, {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
        scopes: body.scope || info.scopes || [],
        userId: info.user_id,
        login: info.login,
        displayName: info.login,
      });
      st.status = 'authorized';
      this.log.info(`Account Twitch collegato (${role}): ${info.login}`);
      return { status: 'authorized', login: info.login };
    }
    const msg = body.message || '';
    if (msg === 'authorization_pending' || msg === 'slow_down') return { status: 'pending' };
    st.status = 'error';
    st.error = msg === 'invalid device code' ? 'Codice scaduto o già usato' : (msg || `Errore ${status}`);
    return { status: 'error', error: st.error };
  }

  async validate(accessToken) {
    const res = await this.fetch(`${this.base}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } });
    if (res.status !== 200) return null;
    return res.json();
  }

  async refresh(role) {
    const t = this.creds.getToken(role);
    if (!t?.refreshToken) throw Object.assign(new Error('Nessun refresh token disponibile'), { authInvalid: true });
    const params = { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: this.creds.clientId };
    const secret = this.creds.clientSecret;
    if (secret) params.client_secret = secret;
    const { status, body } = await this.form('/token', params);
    if (status !== 200 || !body.access_token) {
      const err = new Error(`Rinnovo token fallito (${role}): ${body.message || status}`);
      err.authInvalid = status === 400 || status === 401;
      throw err;
    }
    this.creds.setToken(role, {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
      scopes: body.scope,
    });
    this.log.info(`Token Twitch rinnovato (${role})`);
    return body.access_token;
  }

  async revoke(role) {
    const t = this.creds.getToken(role);
    if (t?.accessToken) {
      try { await this.form('/revoke', { client_id: this.creds.clientId, token: t.accessToken }); } catch { /* ignora */ }
    }
    this.creds.clearToken(role);
  }
}
