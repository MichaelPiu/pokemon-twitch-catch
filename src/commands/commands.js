// Comandi chat configurabili (!pokedex, !pokemon, !dex @utente, ...).
// Attivi solo durante le dirette: fuori dalla LIVE vengono ignorati.
import { RateLimiter } from '../security/rateLimit.js';
import { summary, leaderboard } from '../pokedex/pokedex.js';
import { findUserByLogin, isBanned } from '../pokedex/users.js';
import { DEFAULT_COMMANDS, COMMAND_GLOBAL_DEFAULTS } from '../configuration/defaults.js';

export function seedCommands(db) {
  for (const c of DEFAULT_COMMANDS) {
    db.run(
      `INSERT OR IGNORE INTO command_settings (command, enabled, aliases, response, response_empty, global_cooldown_s, user_cooldown_s, options)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      c.command, JSON.stringify(c.aliases), c.response, c.response_empty, c.global_cooldown_s, c.user_cooldown_s, JSON.stringify(c.options),
    );
  }
}

export function listCommands(db) {
  return db.all('SELECT * FROM command_settings ORDER BY rowid').map((r) => ({
    ...r, enabled: !!r.enabled, aliases: JSON.parse(r.aliases || '[]'), options: JSON.parse(r.options || '{}'),
  }));
}

export function render(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

function relTime(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'pochi secondi fa';
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} ore fa`;
  return `${Math.round(s / 86400)} giorni fa`;
}

export class CommandHandler {
  constructor({ db, commandGlobals, log, leaderboard = null }) {
    this.db = db;
    this.leaderboard = leaderboard; // comando !leaderboard (riservato a broadcaster e moderatori)
    this.unauthorized = 0;
    this.globals = commandGlobals; // SettingsStore (game_settings key 'commands')
    this.log = log;
    this.cooldowns = new Map(); // `${cmd}` e `${cmd}:${user}` -> timestamp
    this.userLimiter = null;
    this.limKey = '';
    this.handled = 0;
  }

  conf() { return { ...COMMAND_GLOBAL_DEFAULTS, ...(this.globals.get('commands') || {}) }; }

  limiter(conf) {
    const key = `${conf.userMaxPerWindow}/${conf.userWindowS}`;
    if (key !== this.limKey) {
      this.userLimiter = new RateLimiter({ max: conf.userMaxPerWindow, windowMs: conf.userWindowS * 1000 });
      this.limKey = key;
    }
    return this.userLimiter;
  }

  // msg: { text, user: {twitchId, login, displayName}, messageId }, opts: { isDemo, now }
  // Ritorna { reply } oppure null se il messaggio non è un comando o va ignorato.
  handle(msg, { isDemo = false, now = Date.now() } = {}) {
    const conf = this.conf();
    const text = String(msg.text || '').trim();
    if (!text.startsWith(conf.prefix)) return null;
    const [rawName, ...args] = text.slice(conf.prefix.length).split(/\s+/);
    const name = (rawName || '').toLowerCase();
    if (!name) return null;
    const cmd = listCommands(this.db).find((c) => c.command === name || c.aliases.map((a) => a.toLowerCase()).includes(name));
    if (!cmd || !cmd.enabled) return null;

    const userRow = this.db.get('SELECT * FROM twitch_users WHERE twitch_id = ?', String(msg.user.twitchId));
    if (userRow && isBanned(this.db, userRow.id)) return null;

    // !leaderboard: autorizzazione PRIMA dei cooldown (uno spettatore non può
    // consumare il cooldown del moderatore). Disponibile solo durante la diretta.
    if (cmd.command === 'leaderboard') {
      const sub = (args[0] || '').toLowerCase();
      if (!msg.live || !this.leaderboard || !this.leaderboard.authorize({ isBroadcaster: msg.isBroadcaster, isModerator: msg.isModerator, twitchId: msg.user.twitchId }, sub)) {
        this.unauthorized++;
        this.log.info('Comando !leaderboard rifiutato: utente non autorizzato', { twitchId: String(msg.user.twitchId), sub: sub.slice(0, 12) });
        return { ignored: 'unauthorized' };
      }
    }

    const gKey = cmd.command;
    const uKey = `${cmd.command}:${msg.user.twitchId}`;
    if (now - (this.cooldowns.get(gKey) || 0) < cmd.global_cooldown_s * 1000) return { ignored: 'global_cooldown' };
    if (now - (this.cooldowns.get(uKey) || 0) < cmd.user_cooldown_s * 1000) return { ignored: 'user_cooldown' };
    if (!this.limiter(conf).hit(String(msg.user.twitchId), now)) return { ignored: 'spam' };
    this.cooldowns.set(gKey, now);
    this.cooldowns.set(uKey, now);
    if (this.cooldowns.size > 5000) this.cooldowns.clear();

    const reply = this.execute(cmd, args, msg, { isDemo, conf });
    if (reply) this.handled++;
    return reply ? { reply, command: cmd.command } : null;
  }

  execute(cmd, args, msg, { isDemo, conf }) {
    const userName = msg.user.displayName || msg.user.login;
    const base = { user: userName };
    const own = () => this.db.get('SELECT * FROM twitch_users WHERE twitch_id = ?', String(msg.user.twitchId));
    switch (cmd.command) {
      case 'pokedex':
      case 'pokemon': {
        const u = own();
        const s = u ? summary(this.db, u.id, { isDemo }) : null;
        if (!s || !s.total) return render(cmd.response_empty || cmd.response, { ...base, total: 0, species: 0, shiny: 0 });
        return render(cmd.response, { ...base, total: s.total, species: s.species, shiny: s.shiny });
      }
      case 'dex': {
        if (!cmd.options.allowOthers) return null;
        const target = (args[0] || '').replace(/^@/, '');
        if (!target || !/^[A-Za-z0-9_]{1,25}$/.test(target)) return render('@{user} uso: {prefix}dex @utente', { ...base, prefix: conf.prefix });
        const u = findUserByLogin(this.db, target, { includeDemo: isDemo });
        const s = u ? summary(this.db, u.id, { isDemo }) : null;
        const tname = u?.display_name || target;
        if (!s || !s.total) return render(cmd.response_empty || cmd.response, { ...base, target: tname, total: 0, species: 0, shiny: 0 });
        return render(cmd.response, { ...base, target: tname, total: s.total, species: s.species, shiny: s.shiny });
      }
      case 'ultimocatturato': {
        const u = own();
        const s = u ? summary(this.db, u.id, { isDemo }) : null;
        if (!s?.last) return render(cmd.response_empty || cmd.response, base);
        return render(cmd.response, {
          ...base, pokemon: s.last.name, shinyTag: s.last.shiny ? ' ✨' : '', ball: s.last.ball || 'Poké Ball', when: relTime(s.last.caughtAt), dex: s.last.dex,
        });
      }
      case 'classifica': {
        const size = Math.min(10, Math.max(1, cmd.options.size || 5));
        const top = leaderboard(this.db, { limit: size, isDemo });
        if (!top.length) return render(cmd.response_empty || cmd.response, base);
        return render(cmd.response, { ...base, top: top.map((t) => `${t.rank}. ${t.displayName} (${t.total})`).join(' · ') });
      }
      case 'leaderboard': {
        // Dalla prova della dashboard (o fuori diretta) nessuna azione: solo descrizione.
        if (!msg.live || !this.leaderboard) return '(prova) !leaderboard [hide|freeze|winner] è riservato a broadcaster e moderatori durante la diretta: nessuna azione eseguita.';
        return this.leaderboard.chatCommand((args[0] || '').toLowerCase(), { user: msg.user });
      }
      case 'help': {
        const cmds = listCommands(this.db).filter((c) => c.enabled && c.command !== 'leaderboard' && (c.command !== 'dex' || c.options.allowOthers))
          .map((c) => conf.prefix + c.command + (c.command === 'dex' ? ' @utente' : '')).join(' ');
        return render(cmd.response, { ...base, commands: cmds });
      }
      default:
        return cmd.response ? render(cmd.response, base) : null;
    }
  }
}
