// OAuth Twitch tramite Device Code Grant Flow: funziona in rete locale senza
// redirect HTTPS pubblici. L'utente apre twitch.tv/activate e inserisce un codice.
import { BROADCASTER_SCOPES, BOT_SCOPES } from '../configuration/defaults.js';
import { fetchWithRetry, TwitchTransientError } from './http.js';

export class TwitchOAuth {
  constructor({ config, credentials, log, fetchImpl = fetch }) {
    this.base = config.twitch.oauthBase;
    this.creds = credentials;
    this.log = log;
    this.fetch = fetchImpl;
    this.http = { ...(config.twitch.http || {}), log };
    this.pending = new Map(); // role -> stato del device flow (solo in memoria)
  }

  scopesFor(role) { return role === 'bot' ? BOT_SCOPES : BROADCASTER_SCOPES; }

  // POST verso id.twitch.tv. `idempotent`: la richiesta può essere ripetuta
  // senza effetti collaterali anche dopo un 5xx o un timeout (es. rinnovo token:
  // nel peggiore dei casi Twitch rifiuta il vecchio refresh token con 400, che
  // viene comunque gestito). Il Device Code Flow non viene ritentato.
  async form(path, params, { idempotent = false, retries } = {}) {
    const res = await fetchWithRetry(this.fetch, `${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }, { ...this.http, idempotent, ...(retries != null ? { retries } : {}), label: `OAuth ${path}` });
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
    let status, body;
    try {
      ({ status, body } = await this.form('/token', params));
    } catch (e) {
      if (!e.transient) throw e;
      return { status: 'pending' }; // Twitch momentaneamente non raggiungibile: il polling continua
    }
    if (status === 200 && body.access_token) {
      let info;
      try {
        info = await this.validate(body.access_token);
      } catch (e) {
        if (!e.transient) throw e;
        st.status = 'error';
        st.error = 'Twitch temporaneamente non disponibile: riprova il collegamento tra qualche minuto';
        return { status: 'error', error: st.error };
      }
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

  // Ritorna le informazioni del token, null se Twitch lo dichiara non valido
  // (401), oppure lancia TwitchTransientError se la risposta non permette di
  // deciderlo (rete, timeout, 429, 5xx, altri codici inattesi).
  async validate(accessToken) {
    const res = await fetchWithRetry(this.fetch, `${this.base}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } }, { ...this.http, label: 'OAuth /validate' });
    if (res.status === 200) return res.json();
    await res.text().catch(() => {});
    if (res.status === 401) return null;
    throw new TwitchTransientError(`Verifica del token non conclusa (HTTP ${res.status})`, { status: res.status });
  }

  async refresh(role) {
    const t = this.creds.getToken(role);
    if (!t?.refreshToken) throw Object.assign(new Error('Nessun refresh token disponibile'), { authInvalid: true });
    const params = { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: this.creds.clientId };
    const secret = this.creds.clientSecret;
    if (secret) params.client_secret = secret;
    // Errori di rete, timeout, 429 e 5xx arrivano come TwitchTransientError
    // (authInvalid: false): il token NON viene considerato revocato.
    const { status, body } = await this.form('/token', params, { idempotent: true });
    if (status !== 200 || !body.access_token) {
      const err = new Error(`Rinnovo token fallito (${role}): ${body.message || status}`);
      // 400/401: Twitch rifiuta il refresh token (revocato, scaduto o app scollegata).
      err.authInvalid = status === 400 || status === 401;
      err.status = status;
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
