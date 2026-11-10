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

  // Decifra un segreto salvato. Ritorna undefined se è cifrato con un'altra chiave
  // (es. backup ripristinato su un'installazione con secret.key diversa): il
  // segreto è trattato come assente, ma il valore cifrato resta intatto nel
  // database finché un nuovo collegamento riuscito non lo sostituisce.
  open(value) {
    if (!value) return null;
    try { return this.box.decrypt(value); } catch { return undefined; }
  }

  // Credenziali salvate ma non leggibili con la chiave attuale (null se nessuna).
  unreadable() {
    const r = this.raw();
    const bad = (v) => !!v && this.open(v) === undefined;
    const tok = (t) => !!t && (bad(t.accessToken) || bad(t.refreshToken));
    const out = { clientSecret: bad(r.clientSecret), broadcaster: tok(r.broadcaster), bot: tok(r.bot) };
    return out.clientSecret || out.broadcaster || out.bot ? out : null;
  }

  get clientSecret() {
    return this.open(this.raw().clientSecret) || '';
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
    const accessToken = this.open(t.accessToken);
    const refreshToken = this.open(t.refreshToken);
    if (accessToken === undefined || refreshToken === undefined) return null; // illeggibile: account scollegato
    return { ...t, accessToken, refreshToken };
  }

  setToken(role, { accessToken, refreshToken, expiresAt, scopes, userId, login, displayName }) {
    const r = this.raw();
    const prev = r[role] || {};
    r[role] = {
      accessToken: this.box.encrypt(accessToken),
      // Il vecchio refresh token si conserva solo se è leggibile con la chiave attuale.
      refreshToken: refreshToken ? this.box.encrypt(refreshToken) : (this.open(prev.refreshToken) ? prev.refreshToken : null),
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
    const u = this.unreadable() || {};
    const tok = (t, bad) => {
      if (t && bad) return { connected: false, unreadable: true, login: t.login, displayName: t.displayName, userId: t.userId };
      return t ? { connected: true, login: t.login, displayName: t.displayName, userId: t.userId, scopes: t.scopes || [], expiresAt: t.expiresAt, updatedAt: t.updatedAt, authError: t.authError || null } : { connected: false };
    };
    return {
      clientId: r.clientId || '',
      clientSecretSet: !!r.clientSecret && !u.clientSecret,
      clientSecretUnreadable: !!u.clientSecret,
      broadcaster: tok(r.broadcaster, u.broadcaster),
      bot: tok(r.bot, u.bot),
    };
  }
}
