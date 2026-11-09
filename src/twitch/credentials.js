// Archivio credenziali Twitch: Client ID/Secret e token OAuth, cifrati a riposo
// (AES-256-GCM). Nessun segreto viene mai restituito al frontend.
const KEY = 'twitch_credentials';

export class TwitchCredentials {
  constructor({ adminSettings, box }) {
    this.store = adminSettings;
    this.box = box;
  }

  raw() { return this.store.get(KEY) || {}; }
  save(obj) { this.store.set(KEY, obj); }

  get clientId() { return this.raw().clientId || ''; }

  get clientSecret() {
    const r = this.raw();
    return r.clientSecret ? this.box.decrypt(r.clientSecret) : '';
  }

  setApp({ clientId, clientSecret }) {
    const r = this.raw();
    const changedClient = clientId !== undefined && clientId !== r.clientId;
    if (clientId !== undefined) r.clientId = clientId;
    if (clientSecret) r.clientSecret = this.box.encrypt(clientSecret);
    if (changedClient) { delete r.broadcaster; delete r.bot; } // i token appartengono al vecchio Client ID
    this.save(r);
  }

  // role: 'broadcaster' | 'bot'
  getToken(role) {
    const t = this.raw()[role];
    if (!t) return null;
    return {
      ...t,
      accessToken: t.accessToken ? this.box.decrypt(t.accessToken) : null,
      refreshToken: t.refreshToken ? this.box.decrypt(t.refreshToken) : null,
    };
  }

  setToken(role, { accessToken, refreshToken, expiresAt, scopes, userId, login, displayName }) {
    const r = this.raw();
    const prev = r[role] || {};
    r[role] = {
      accessToken: this.box.encrypt(accessToken),
      refreshToken: refreshToken ? this.box.encrypt(refreshToken) : prev.refreshToken || null,
      expiresAt: expiresAt ?? null,
      scopes: scopes ?? prev.scopes ?? [],
      userId: userId ?? prev.userId,
      login: login ?? prev.login,
      displayName: displayName ?? prev.displayName,
      updatedAt: new Date().toISOString(),
    };
    this.save(r);
  }

  // Token revocato o non più rinnovabile: lo segna (senza cancellarlo) finché
  // l'account non viene ricollegato o il rinnovo torna a funzionare.
  markInvalid(role, reason) {
    const r = this.raw();
    if (!r[role]) return;
    r[role].authError = { at: new Date().toISOString(), reason: String(reason || 'token non valido').slice(0, 200) };
    this.save(r);
  }

  authError(role) { return this.raw()[role]?.authError || null; }

  clearAuthError(role) {
    const r = this.raw();
    if (!r[role]?.authError) return;
    delete r[role].authError;
    this.save(r);
  }

  clearToken(role) {
    const r = this.raw();
    delete r[role];
    this.save(r);
  }

  // Vista sicura per la dashboard.
  publicView() {
    const r = this.raw();
    const tok = (t) => t ? { connected: true, login: t.login, displayName: t.displayName, userId: t.userId, scopes: t.scopes || [], expiresAt: t.expiresAt, updatedAt: t.updatedAt, authError: t.authError || null } : { connected: false };
    return {
      clientId: r.clientId || '',
      clientSecretSet: !!r.clientSecret,
      broadcaster: tok(r.broadcaster),
      bot: tok(r.bot),
    };
  }
}
