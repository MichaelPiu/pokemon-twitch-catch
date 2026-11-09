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
];
