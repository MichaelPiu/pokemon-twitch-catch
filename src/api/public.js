// API pubbliche (sola lettura) per overlay, Pokédex pubblico e classifica.
import { HttpError } from '../http/router.js';
import { summary, collection, leaderboard } from '../pokedex/pokedex.js';
import { findUserByLogin } from '../pokedex/users.js';
import { RARITY_LABELS } from '../configuration/defaults.js';

export function registerPublicRoutes(app) {
  const r = app.router;
  const pages = () => app.adminSettings.get('publicPages');

  r.get('/api/public/info', () => ({
    pages: pages(),
    live: app.sm.state === 'LIVE',
    channel: app.adminSettings.get('twitch').channelLogin || null,
    pokemon: app.db.get('SELECT COUNT(*) AS n FROM pokemon WHERE enabled = 1').n,
    trainers: app.db.get('SELECT COUNT(*) AS n FROM twitch_users WHERE is_demo = 0').n,
    caught: app.db.get('SELECT COUNT(*) AS n FROM user_pokemon WHERE is_demo = 0').n,
    rarities: RARITY_LABELS,
  }), { public: true });

  r.get('/api/public/overlay', () => ({ ...app.engine.overlaySnapshot(), settings: app.themes.effective(), rarities: RARITY_LABELS, leaderboard: app.leaderboard.overlayPayload(), rotation: app.rotation.payload(), events: app.events.overlayPayload() }), { public: true });

  r.get('/api/public/leaderboard', (ctx) => {
    if (!pages().leaderboard) throw new HttpError(404, 'Classifica non disponibile');
    return { items: leaderboard(app.db, { limit: Math.min(100, Math.max(1, Math.floor(Number(ctx.query.get('limit'))) || 50)) }) };
  }, { public: true });

  r.get('/api/public/pokedex/:login', (ctx) => {
    if (!pages().pokedex) throw new HttpError(404, 'Pokédex pubblici non disponibili');
    const u = findUserByLogin(app.db, ctx.params.login);
    if (!u) throw new HttpError(404, 'Allenatore non trovato');
    const banned = app.db.get('SELECT 1 FROM user_bans WHERE user_id = ? AND active = 1', u.id);
    if (banned) throw new HttpError(404, 'Allenatore non trovato');
    return {
      trainer: { login: u.login, displayName: u.display_name, firstSeen: u.first_seen_at },
      summary: summary(app.db, u.id),
      collection: collection(app.db, u.id),
      totalSpecies: app.db.get('SELECT COUNT(DISTINCT dex_number) AS n FROM pokemon WHERE is_default_form = 1').n,
      rarities: RARITY_LABELS,
    };
  }, { public: true });
}
