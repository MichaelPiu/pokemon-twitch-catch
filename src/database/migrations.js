// Migrazioni dello schema. Ogni migrazione viene applicata una sola volta e
// registrata in schema_migrations. Non modificare migrazioni già rilasciate:
// aggiungerne sempre di nuove in coda.
export const migrations = [
  {
    id: 1,
    name: 'schema_iniziale',
    sql: `
CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

CREATE TABLE admin_sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

CREATE TABLE admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE game_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE overlay_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE command_settings (
  command TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  aliases TEXT NOT NULL DEFAULT '[]',
  response TEXT NOT NULL,
  response_empty TEXT,
  global_cooldown_s INTEGER NOT NULL DEFAULT 5 CHECK (global_cooldown_s >= 0),
  user_cooldown_s INTEGER NOT NULL DEFAULT 30 CHECK (user_cooldown_s >= 0),
  options TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE twitch_users (
  id INTEGER PRIMARY KEY,
  twitch_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_twitch_users_login ON twitch_users(login);

CREATE TABLE user_bans (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES twitch_users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_user_bans_user ON user_bans(user_id, active);

CREATE TABLE pokemon (
  id INTEGER PRIMARY KEY,
  dex_number INTEGER NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_it TEXT,
  form_name TEXT,
  is_default_form INTEGER NOT NULL DEFAULT 1,
  types TEXT NOT NULL DEFAULT '[]',
  generation INTEGER,
  capture_rate INTEGER,
  is_legendary INTEGER NOT NULL DEFAULT 0,
  is_mythical INTEGER NOT NULL DEFAULT 0,
  rarity TEXT NOT NULL DEFAULT 'common'
    CHECK (rarity IN ('common','uncommon','rare','epic','legendary','mythical')),
  catch_modifier REAL NOT NULL DEFAULT 1.0 CHECK (catch_modifier > 0),
  spawn_weight REAL NOT NULL DEFAULT 1.0 CHECK (spawn_weight >= 0),
  shiny_enabled INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  image_url TEXT,
  shiny_image_url TEXT,
  image_file TEXT,
  shiny_image_file TEXT,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pokemon_dex ON pokemon(dex_number);
CREATE INDEX idx_pokemon_rarity ON pokemon(rarity, enabled);

CREATE TABLE ball_types (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1.0 CHECK (multiplier >= 0),
  guaranteed INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#e3350d',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE twitch_rewards (
  id INTEGER PRIMARY KEY,
  reward_id TEXT NOT NULL UNIQUE,
  ball_type_id INTEGER REFERENCES ball_types(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  cost INTEGER,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  managed_by_app INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  verify_status TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE stream_sessions (
  id INTEGER PRIMARY KEY,
  broadcast_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_s INTEGER,
  spawns INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  captures INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  participants INTEGER NOT NULL DEFAULT 0,
  shiny_spawns INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT
);
CREATE INDEX idx_stream_sessions_started ON stream_sessions(started_at);
-- Al massimo una sessione aperta per tipo (reale/demo): evita sessioni duplicate.
CREATE UNIQUE INDEX idx_stream_sessions_one_open ON stream_sessions(is_demo) WHERE ended_at IS NULL;

CREATE TABLE spawn_history (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  is_shiny INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  rarity TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual','demo')),
  capture_mode TEXT NOT NULL DEFAULT 'single' CHECK (capture_mode IN ('single','multi')),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','caught','fled','expired','cancelled','interrupted','stream_ended')),
  attempts INTEGER NOT NULL DEFAULT 0,
  captures INTEGER NOT NULL DEFAULT 0,
  caught_by_user_id INTEGER REFERENCES twitch_users(id) ON DELETE SET NULL
);
CREATE INDEX idx_spawn_session ON spawn_history(session_id);
CREATE INDEX idx_spawn_pokemon ON spawn_history(pokemon_id);
-- Un solo spawn attivo alla volta: evita spawn duplicati.
CREATE UNIQUE INDEX idx_spawn_one_active ON spawn_history(status) WHERE status = 'active';

CREATE TABLE user_pokemon (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES twitch_users(id) ON DELETE CASCADE,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  is_shiny INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ball_type_id INTEGER REFERENCES ball_types(id) ON DELETE SET NULL,
  ball_name TEXT,
  session_id INTEGER REFERENCES stream_sessions(id) ON DELETE SET NULL,
  spawn_id INTEGER REFERENCES spawn_history(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'capture' CHECK (source IN ('capture','admin','import')),
  caught_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_user_pokemon_user ON user_pokemon(user_id, is_demo);
CREATE INDEX idx_user_pokemon_pokemon ON user_pokemon(pokemon_id);
-- Un utente non può catturare due volte lo stesso spawn.
CREATE UNIQUE INDEX idx_user_pokemon_spawn ON user_pokemon(user_id, spawn_id) WHERE spawn_id IS NOT NULL;

CREATE TABLE capture_attempts (
  id INTEGER PRIMARY KEY,
  redemption_id TEXT UNIQUE,
  user_id INTEGER NOT NULL REFERENCES twitch_users(id) ON DELETE CASCADE,
  spawn_id INTEGER REFERENCES spawn_history(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES stream_sessions(id) ON DELETE SET NULL,
  ball_type_id INTEGER REFERENCES ball_types(id) ON DELETE SET NULL,
  reward_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  probability REAL,
  roll REAL,
  outcome TEXT NOT NULL CHECK (outcome IN ('caught','failed','rejected')),
  reject_reason TEXT,
  redemption_status TEXT,
  user_pokemon_id INTEGER REFERENCES user_pokemon(id) ON DELETE SET NULL,
  redeemed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_attempts_session ON capture_attempts(session_id);
CREATE INDEX idx_attempts_user ON capture_attempts(user_id);
CREATE INDEX idx_attempts_spawn ON capture_attempts(spawn_id);
CREATE INDEX idx_attempts_created ON capture_attempts(created_at);

CREATE TABLE twitch_events (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  message_timestamp TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  detail TEXT,
  payload TEXT
);
CREATE INDEX idx_twitch_events_received ON twitch_events(received_at);

CREATE TABLE backup_history (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('manual','auto','pre-restore','pre-migration','upload')),
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'ok',
  note TEXT,
  deleted_at TEXT
);

CREATE TABLE state_transitions (
  id INTEGER PRIMARY KEY,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`,
  },
  {
    id: 2,
    name: 'sicurezza_sessioni_e_riconciliazione_ricompense',
    sql: `
-- Sessioni: ultimo utilizzo (scadenza per inattività).
ALTER TABLE admin_sessions ADD COLUMN last_seen_at TEXT;

-- Ricompense: stato di pausa sincronizzato con Twitch ed eventuale errore.
ALTER TABLE twitch_rewards ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE twitch_rewards ADD COLUMN pause_synced_at TEXT;
ALTER TABLE twitch_rewards ADD COLUMN sync_error TEXT;

-- Tentativi: origine (eventsub/recuperato/demo) e aggiornamento dello stato della
-- riscossione su Twitch con tentativi ripetuti in caso di errore.
ALTER TABLE capture_attempts ADD COLUMN source TEXT NOT NULL DEFAULT 'eventsub';
ALTER TABLE capture_attempts ADD COLUMN desired_status TEXT;
ALTER TABLE capture_attempts ADD COLUMN status_error TEXT;
ALTER TABLE capture_attempts ADD COLUMN status_tries INTEGER NOT NULL DEFAULT 0;
UPDATE capture_attempts SET source = 'demo' WHERE is_demo = 1;
CREATE INDEX idx_attempts_pending_status ON capture_attempts(desired_status) WHERE desired_status IS NOT NULL;
`,
  },
  {
    id: 3,
    name: 'overlay_themes',
    sql: `
-- Temi dell'overlay: preset integrati (slug valorizzato) e temi personalizzati.
-- original_config: valori a cui riportare il tema con "Ripristina".
CREATE TABLE overlay_themes (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE,
  name TEXT NOT NULL,
  base TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,
  original_config TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`,
  },
  {
    id: 4,
    name: 'sessioni_manuali_origine_catture_audit',
    sql: `
-- Tipo di sessione: diretta Twitch, sessione manuale avviata dalla dashboard
-- (dati reali, senza Twitch) o DEMO (dati di prova separati).
-- Il vincolo "una sola sessione aperta per is_demo" resta: una sessione
-- manuale e una diretta Twitch non possono essere aperte insieme.
ALTER TABLE stream_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'twitch' CHECK (kind IN ('twitch','manual','demo'));
UPDATE stream_sessions SET kind = 'demo' WHERE is_demo = 1;
ALTER TABLE stream_sessions ADD COLUMN errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stream_sessions ADD COLUMN last_error TEXT;
CREATE INDEX idx_stream_sessions_kind ON stream_sessions(kind, started_at);

-- Origine di ogni esemplare del Pokédex: cattura durante una diretta Twitch,
-- cattura durante una sessione manuale, registrazione dell'amministratore,
-- importazione JSON o DEMO. Le righe esistenti vengono classificate dai campi
-- già presenti (nessun dato viene perso o modificato).
ALTER TABLE user_pokemon ADD COLUMN origin TEXT NOT NULL DEFAULT 'twitch' CHECK (origin IN ('twitch','manual','admin','import','demo'));
UPDATE user_pokemon SET origin = CASE
  WHEN is_demo = 1 THEN 'demo'
  WHEN source = 'admin' THEN 'admin'
  WHEN source = 'import' THEN 'import'
  ELSE 'twitch' END;
ALTER TABLE user_pokemon ADD COLUMN note TEXT;
ALTER TABLE user_pokemon ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_pokemon ADD COLUMN updated_at TEXT;
ALTER TABLE user_pokemon ADD COLUMN updated_by TEXT;
CREATE INDEX idx_user_pokemon_origin ON user_pokemon(origin);

-- Giocatori locali (sessioni manuali senza Twitch): distinti dagli spettatori Twitch.
ALTER TABLE twitch_users ADD COLUMN origin TEXT NOT NULL DEFAULT 'twitch' CHECK (origin IN ('twitch','demo','local'));
UPDATE twitch_users SET origin = 'demo' WHERE is_demo = 1;

-- Registro delle operazioni amministrative (Pokédex, backup, ripristini, sessioni
-- manuali): chi, quando, cosa. Mai segreti o token.
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  admin TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT
);
CREATE INDEX idx_admin_audit_created ON admin_audit(created_at);
CREATE INDEX idx_admin_audit_target ON admin_audit(target_type, target_id);
`,
  },
  {
    id: 5,
    name: 'classifiche_hall_of_fame_recap',
    sql: `
-- Profilo del giocatore: la tabella twitch_users resta l'unica anagrafica
-- (twitch_id = Twitch User ID, oppure "local:<nome>" per i giocatori locali delle
-- sessioni manuali). custom_name è il nome scelto dall'amministratore: se valorizzato
-- sostituisce il nickname Twitch nelle classifiche, senza toccare i dati storici.
ALTER TABLE twitch_users ADD COLUMN custom_name TEXT;
ALTER TABLE twitch_users ADD COLUMN custom_name_at TEXT;
ALTER TABLE twitch_users ADD COLUMN custom_name_by TEXT;

-- Storico dei nomi: nickname Twitch precedenti (kind 'twitch') e rinomine
-- dell'amministratore (kind 'admin').
CREATE TABLE player_aliases (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES twitch_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('twitch','admin')),
  login TEXT,
  display_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  changed_by TEXT
);
CREATE INDEX idx_player_aliases_user ON player_aliases(user_id, last_seen_at);

-- Vista di comodo: il profilo come lo usano le classifiche.
CREATE VIEW players AS
  SELECT id, twitch_id, origin, login, display_name AS twitch_name, custom_name,
         COALESCE(custom_name, display_name) AS name, first_seen_at, last_seen_at
  FROM twitch_users WHERE is_demo = 0;

-- Regole di punteggio versionate: ogni modifica crea una nuova versione, le
-- versioni precedenti non cambiano più (i punti già assegnati restano quelli).
CREATE TABLE leaderboard_rule_versions (
  id INTEGER PRIMARY KEY,
  rules TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT
);
INSERT INTO leaderboard_rule_versions (id, rules, created_by) VALUES (1,
  '{"base":10,"rarity":{"common":0,"uncommon":5,"rare":15,"epic":30,"legendary":50,"mythical":50},"shiny":50}', 'sistema');

-- Un evento per ogni cattura valida di una sessione TWITCH o MANUAL, scritto nella
-- stessa transazione della cattura. capture_attempt_id univoco: la stessa cattura
-- non assegna mai punti due volte. Punti e rarità sono salvati al momento della
-- cattura e non vengono ricalcolati. Una cattura annullata su Twitch (riscatto
-- revocato) viene marcata voided_at, non cancellata.
CREATE TABLE leaderboard_events (
  id INTEGER PRIMARY KEY,
  capture_attempt_id INTEGER NOT NULL UNIQUE REFERENCES capture_attempts(id) ON DELETE CASCADE,
  user_pokemon_id INTEGER UNIQUE REFERENCES user_pokemon(id) ON DELETE SET NULL,
  session_id INTEGER NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('twitch','manual')),
  user_id INTEGER NOT NULL REFERENCES twitch_users(id) ON DELETE CASCADE,
  spawn_id INTEGER REFERENCES spawn_history(id) ON DELETE SET NULL,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  is_shiny INTEGER NOT NULL DEFAULT 0,
  rarity TEXT,
  base_points INTEGER NOT NULL,
  rarity_bonus INTEGER NOT NULL,
  shiny_bonus INTEGER NOT NULL,
  points INTEGER NOT NULL,
  rules_version INTEGER NOT NULL REFERENCES leaderboard_rule_versions(id),
  source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live','backfill')),
  caught_at TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT,
  CHECK (points = base_points + rarity_bonus + shiny_bonus)
);
CREATE INDEX idx_lb_events_session ON leaderboard_events(session_id, user_id) WHERE voided_at IS NULL;
CREATE INDEX idx_lb_events_user ON leaderboard_events(user_id, session_kind) WHERE voided_at IS NULL;
CREATE INDEX idx_lb_events_kind ON leaderboard_events(session_kind, caught_at);
-- Punti e dati della cattura non si modificano: solo l'annullamento è ammesso.
CREATE TRIGGER trg_lb_events_immutable BEFORE UPDATE OF capture_attempt_id, session_id, session_kind, user_id,
  pokemon_id, is_shiny, rarity, base_points, rarity_bonus, shiny_bonus, points, rules_version, caught_at ON leaderboard_events
BEGIN SELECT RAISE(ABORT, 'evento della classifica immutabile'); END;

-- Classifica per sessione e giocatore, calcolata dagli eventi (nessuna seconda copia dei dati).
CREATE VIEW leaderboard_entries AS
  SELECT session_id, session_kind, user_id, COUNT(*) AS captures, SUM(points) AS points,
         SUM(is_shiny) AS shiny, COUNT(DISTINCT pokemon_id) AS species, MAX(caught_at) AS last_capture_at
  FROM leaderboard_events WHERE voided_at IS NULL GROUP BY session_id, user_id;

-- Catture già registrate prima di questa versione (dirette e sessioni manuali, mai
-- DEMO): entrano nelle classifiche con le regole iniziali (versione 1), marcate
-- "backfill". La rarità è quella salvata nello spawn al momento dell'incontro.
INSERT INTO leaderboard_events (capture_attempt_id, user_pokemon_id, session_id, session_kind, user_id, spawn_id, pokemon_id,
  is_shiny, rarity, base_points, rarity_bonus, shiny_bonus, points, rules_version, source, caught_at)
SELECT a.id, a.user_pokemon_id, a.session_id, ss.kind, a.user_id, a.spawn_id, sp.pokemon_id, sp.is_shiny, sp.rarity, 10,
  CASE sp.rarity WHEN 'uncommon' THEN 5 WHEN 'rare' THEN 15 WHEN 'epic' THEN 30 WHEN 'legendary' THEN 50 WHEN 'mythical' THEN 50 ELSE 0 END,
  CASE WHEN sp.is_shiny = 1 THEN 50 ELSE 0 END,
  10 + CASE sp.rarity WHEN 'uncommon' THEN 5 WHEN 'rare' THEN 15 WHEN 'epic' THEN 30 WHEN 'legendary' THEN 50 WHEN 'mythical' THEN 50 ELSE 0 END
     + CASE WHEN sp.is_shiny = 1 THEN 50 ELSE 0 END,
  1, 'backfill', COALESCE(a.redeemed_at, a.created_at)
FROM capture_attempts a
JOIN spawn_history sp ON sp.id = a.spawn_id
JOIN stream_sessions ss ON ss.id = a.session_id
WHERE a.outcome = 'caught' AND a.is_demo = 0 AND ss.is_demo = 0 AND ss.kind IN ('twitch','manual');

-- Risultati congelati: copia definitiva della classifica (ordine, catture, punti,
-- nomi al momento del congelamento). Una sola istantanea attiva per sessione; lo
-- sblocco la marca "unlocked" (con motivazione) senza cancellarla né modificarla.
CREATE TABLE leaderboard_snapshots (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES stream_sessions(id),
  session_kind TEXT NOT NULL CHECK (session_kind IN ('twitch','manual')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unlocked')),
  data TEXT NOT NULL,
  checksum TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  created_via TEXT NOT NULL DEFAULT 'dashboard' CHECK (created_via IN ('dashboard','chat')),
  unlocked_at TEXT,
  unlocked_by TEXT,
  unlock_reason TEXT,
  UNIQUE (session_id, version)
);
CREATE UNIQUE INDEX idx_lb_snapshots_one_active ON leaderboard_snapshots(session_id) WHERE status = 'active';
CREATE TRIGGER trg_lb_snapshots_immutable BEFORE UPDATE OF session_id, session_kind, version, data, checksum, rules_version,
  created_at, created_by, created_via ON leaderboard_snapshots
BEGIN SELECT RAISE(ABORT, 'istantanea congelata immutabile'); END;
CREATE TRIGGER trg_lb_snapshots_relock BEFORE UPDATE OF status ON leaderboard_snapshots WHEN OLD.status = 'unlocked'
BEGIN SELECT RAISE(ABORT, 'istantanea già sbloccata: congela di nuovo per crearne una nuova'); END;
CREATE TRIGGER trg_lb_snapshots_nodelete BEFORE DELETE ON leaderboard_snapshots
BEGIN SELECT RAISE(ABORT, 'le istantanee congelate non si cancellano'); END;

-- Impostazioni delle classifiche (comandi chat, stato della schermata nell'overlay).
CREATE TABLE leaderboard_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Riepilogo persistente di ogni sessione TWITCH o MANUAL, generato alla chiusura.
CREATE TABLE stream_recaps (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE REFERENCES stream_sessions(id) ON DELETE CASCADE,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('twitch','manual')),
  data TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live','snapshot')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  generated_by TEXT
);
CREATE INDEX idx_stream_recaps_kind ON stream_recaps(session_kind, created_at);
`,
  },
];

// Ultima versione di schema conosciuta da questo codice. Un database (o un
// backup) con una versione più alta è stato creato da una versione più recente
// dell'app e non viene aperto né ripristinato: potrebbe essere danneggiato.
export const LATEST_SCHEMA = Math.max(...migrations.map((m) => m.id));

export function schemaTooNewMessage(found, what = 'Il database') {
  return `${what} usa lo schema v${found}, creato da una versione più recente di Live Catch: questa versione supporta fino allo schema v${LATEST_SCHEMA}. `
    + 'Aggiorna l\'app oppure usa un backup compatibile.';
}
