# Architettura tecnica

## Servizi sempre attivi vs motore di gioco

Il container non viene mai fermato. Al suo interno:

| Sempre attivi | Solo in LIVE (o DEMO) |
|---|---|
| API REST, dashboard, pagine pubbliche | Timer di spawn e scadenza |
| Database SQLite | Spawn attivi |
| Autenticazione | Elaborazione dei tentativi (le riscossioni offline vengono registrate come *rifiutate* e, se possibile, rimborsate) |
| Monitor Twitch (EventSub + polling) | Comandi chat di gioco |
| Ricezione e registrazione eventi | Eventi di gioco verso l'overlay |
| Backup automatico, WebSocket dashboard | Statistiche della sessione |

Il motore (`src/game_engine/engine.js`) ha tre modalità: `null` (fermo), `live`, `demo`, più il flag `suspended`. Viene acceso e spento **solo** dal monitor Twitch (`src/twitch/monitor.js`) in reazione alle transizioni della macchina a stati.

## Macchina a stati (`src/game_engine/stateMachine.js`)

```
            ┌──────────── not_configured / auth_error ───────────┐
            ▼                                                    │
         ERROR ──(credenziali ok)──▶ CONNECTING ──(API: offline)──▶ OFFLINE
            ▲                            │                         │  ▲
            │                    (API: live + EventSub ok)   stream.online / poll live
            │                            ▼                         ▼  │ stream.offline / 2 poll offline
            └──────────────────────────  LIVE ◀──(riconnesso + live confermata)── PAUSED
                                          │                                       ▲
                                          └──── EventSub disconnesso ─────────────┘
```

Transizioni ammesse: `OFFLINE→{CONNECTING,LIVE,ERROR}`, `CONNECTING→{OFFLINE,LIVE,ERROR}`, `LIVE→{PAUSED,OFFLINE,ERROR}`, `PAUSED→{LIVE,OFFLINE,ERROR}`, `ERROR→{CONNECTING,OFFLINE}`. Ogni transizione è registrata nella tabella `state_transitions`.

Effetti sul motore:
- **→ LIVE**: crea la sessione oppure riprende quella aperta se il `broadcast_id` coincide (dopo disconnessioni o riavvii); se è una diretta diversa chiude la precedente. Avvia il timer di spawn.
- **→ PAUSED / CONNECTING / ERROR**: sospende in sicurezza: timer fermati, spawn in corso chiuso come `interrupted`, overlay inattivo, **sessione lasciata aperta**.
- **→ OFFLINE**: ferma i timer, chiude lo spawn come `stream_ended`, ricalcola e chiude la sessione, pulisce l'overlay.

Protezioni:
- Fine diretta dal polling solo dopo **2 controlli consecutivi** (configurabile) e mai nei 3 minuti successivi a `stream.online` (l'API `/streams` può essere in ritardo).
- Errori di rete del polling non cambiano lo stato; solo errori di autenticazione portano a `ERROR`.
- Con EventSub disconnesso non si torna in LIVE (non arriverebbero le riscossioni).
- Al riavvio del server gli spawn rimasti `active` vengono chiusi e la sessione viene ripresa o chiusa in base allo stato reale del canale.

## EventSub WebSocket (`src/eventsub/client.js`)

- `session_welcome` → creazione delle sottoscrizioni via Helix entro 10 s.
- Watchdog keepalive (`keepalive_timeout_seconds + 5 s`): se scade, la connessione è considerata persa.
- `session_reconnect` → apertura del nuovo URL, chiusura della vecchia connessione dopo il welcome (sottoscrizioni mantenute da Twitch).
- Chiusura/errore → riconnessione con backoff esponenziale con jitter (1 s → 60 s).

## Idempotenza e concorrenza

- `twitch_events.message_id UNIQUE`: ogni messaggio EventSub elaborato una sola volta; messaggi più vecchi di 10 minuti scartati (anti-replay).
- `capture_attempts.redemption_id UNIQUE`: la stessa riscossione non genera mai due tentativi, anche se Twitch la reinvia con un altro message_id.
- Ogni tentativo è una transazione `BEGIN IMMEDIATE`. In modalità *un solo vincitore* la cattura esegue `UPDATE spawn_history SET status='caught' WHERE id=? AND status='active'`: solo chi modifica la riga vince.
- Indice univoco parziale `spawn_history(status) WHERE status='active'`: al massimo uno spawn attivo.
- Indice univoco parziale `stream_sessions(is_demo) WHERE ended_at IS NULL`: al massimo una sessione aperta (reale) e una demo.
- `user_pokemon(user_id, spawn_id)` univoco: in modalità multipla ognuno cattura lo stesso spawn una sola volta.

## Formula di cattura (`src/capture/capture.js`)

```
se ball garantita e Master Ball abilitata → 1
p = base[rarità] × difficoltà_pokemon × moltiplicatore_ball × modificatore_globale
    × (shiny ? modificatore_shiny : 1) × (evento ? modificatore_evento : 1)
p = clamp(p, probabilità_minima, probabilità_massima)
catturato se random() < p        (random crittograficamente sicuro)
```

Rifiuti possibili (`reject_reason`): `offline`, `paused`, `no_spawn`, `late`, `expired`, `user_limit`, `already_caught`, `banned`, `ball_disabled`, `demo_mode`, `live_mode`.

## Database (`src/database/migrations.js`)

Tabelle principali: `twitch_users`, `pokemon`, `user_pokemon`, `spawn_history`, `capture_attempts`, `twitch_rewards`, `twitch_events`, `stream_sessions`, `game_settings`, `admin_settings`, `command_settings`, `overlay_settings`, `user_bans`, `backup_history`, più `ball_types`, `admin_users`, `admin_sessions`, `state_transitions`, `schema_migrations`.

Ogni riga di gioco ha il flag `is_demo`: tutte le statistiche filtrano `is_demo = 0`. Ogni spawn e tentativo è legato a `session_id`.

Migrazioni: array ordinato e immutabile; all'avvio vengono applicate solo quelle mancanti, ciascuna in una transazione. Per modificare lo schema si aggiunge sempre una nuova migrazione.

## Sicurezza

- Password: scrypt (N=16384, r=8, p=1, salt 16 byte), confronto a tempo costante.
- Sessioni: token casuale 256 bit nel cookie `HttpOnly; SameSite=Strict`, salvato come hash SHA-256; scadenza 7 giorni.
- CSRF: token per sessione obbligatorio nell'header `X-CSRF-Token` per tutte le richieste non GET.
- Rate limit: 600 richieste/minuto per IP sulle API, 10 tentativi di login ogni 15 minuti.
- Segreti Twitch: AES-256-GCM con chiave in `/data/secret.key` (o `APP_SECRET_KEY`); mai restituiti al frontend.
- Log: redazione automatica di token, segreti, password e header Authorization.
- Header: CSP restrittiva, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options` (l'overlay è incorporabile, la dashboard no).
- Nessuna porta esposta su Internet: EventSub usa una connessione in uscita.

## Perché non FastAPI/React/PostgreSQL

Lo stack suggerito è valido, ma su un server domestico ogni componente in più è qualcosa che può rompersi durante un aggiornamento. Con Node.js 24 il database SQLite è integrato nel runtime e la dashboard non richiede build: l'immagine contiene runtime + codice + una libreria (`ws`). Il codice resta modulare (una cartella per dominio) e la migrazione verso un frontend con build o PostgreSQL resta possibile senza toccare la logica di gioco.
