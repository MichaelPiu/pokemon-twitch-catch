# Live Catch — gioco di cattura Pokémon per Twitch (self-hosted su Umbrel OS)

Live Catch è un gioco interattivo per la tua diretta Twitch che gira interamente sul tuo server domestico **Umbrel OS**.

- Quando vai **LIVE**, il gioco parte da solo: a intervalli casuali compare un Pokémon nell'overlay di OBS.
- Gli spettatori lo catturano riscattando le **ricompense dei punti canale** (Poké Ball, Mega Ball, Ultra Ball, Master Ball…).
- Ogni spettatore ha il suo **Pokédex personale**, consultabile in chat con `!pokedex`.
- Quando **termini la diretta**, il motore di gioco si ferma da solo. Dashboard, database, statistiche e backup restano sempre disponibili.
- Un'unica **dashboard amministrativa** (`/admin`) controlla tutto.

> **Non sei pratico di informatica?** Segui la [Guida rapida](docs/GUIDA-RAPIDA.md).

> ⚠️ Progetto amatoriale **non ufficiale**. Pokémon e i relativi nomi e immagini sono marchi e proprietà di Nintendo, Creatures Inc., GAME FREAK inc. e The Pokémon Company. Questo progetto non è affiliato, sponsorizzato né approvato da loro. I dati provengono da [PokéAPI](https://pokeapi.co) e le immagini dal repository [PokeAPI/sprites](https://github.com/PokeAPI/sprites): usale solo per scopi personali e non commerciali. Il repository **non contiene** dati né immagini Pokémon: li scarichi tu al primo avvio.

---

## Indice

1. [Funzionalità](#funzionalità)
2. [Architettura](#architettura)
3. [Requisiti](#requisiti)
4. [Installazione su Umbrel OS](#installazione-su-umbrel-os)
5. [Configurazione Docker](#configurazione-docker)
6. [Primo accesso](#primo-accesso)
7. [Configurazione Twitch](#configurazione-twitch)
8. [Channel Points Rewards](#creazione-delle-channel-points-rewards)
9. [Importazione dei Pokémon](#importazione-dei-pokémon)
10. [Collegamento OBS](#collegamento-obs)
11. [Configurazione della dashboard](#configurazione-della-dashboard)
12. [Comandi chat](#comandi-chat)
13. [Backup](#backup) · [Ripristino](#ripristino) · [Aggiornamento](#aggiornamento)
14. [Risoluzione problemi](#risoluzione-problemi)
15. [Sviluppo e test](#sviluppo-e-test)
16. [Cosa devi autorizzare tu](#cosa-devi-autorizzare-tu)

---

## Funzionalità

| Area | Cosa fa |
|---|---|
| Ciclo di vita | Macchina a stati `OFFLINE → CONNECTING → LIVE ↔ PAUSED → ERROR`. Rileva l'inizio/fine diretta con EventSub (WebSocket) + controllo periodico via API. |
| Spawn | Intervallo min/max, durata, probabilità di spawn, 6 rarità con pesi configurabili, shiny con probabilità indipendente, eventi speciali, filtro per generazione, generazione manuale. |
| Cattura | Probabilità = base rarità × difficoltà Pokémon × moltiplicatore ball × modificatori. Un solo vincitore o cattura multipla. Idempotenza, transazioni, protezione duplicati/ritardi/rimborsi. |
| Pokédex | Per spettatore (ID Twitch univoco): esemplari, doppioni, specie, shiny, storico catture e tentativi, i più rari. |
| Comandi | `!pokedex`, `!pokemon`, `!dex @utente`, `!ultimocatturato`, `!classifica`, `!help` — risposte, alias, cooldown, anti-spam, limite bot configurabili. |
| Overlay OBS | `/overlay` trasparente, aggiornato via WebSocket, animazioni, coda notifiche, colori/posizione/scala configurabili, anteprima in dashboard. |
| Statistiche | Per diretta, giornaliere, settimanali, mensili, complessive; Pokémon più apparsi/catturati/difficili, utenti più attivi, ball più usate, shiny. |
| Dashboard | Unica, con sidebar: Panoramica, Statistiche, Storico dirette, Spettatori & Pokédex, Spawn, Pokémon, Poké Ball, Comandi, Overlay, Twitch, DEMO, Backup & Sistema. |
| Sicurezza | Password scrypt, cambio password obbligatorio, sessioni HttpOnly/SameSite, CSRF, rate limiting, token Twitch cifrati AES-256-GCM, redazione dei segreti nei log. |
| Backup | Giornaliero automatico con rotazione, manuale, download/upload, ripristino guidato con backup di sicurezza, esportazione/importazione JSON. |
| DEMO | Modalità di prova separata (utenti/sessioni marcati DEMO) che non tocca le statistiche reali e non è disponibile durante una diretta. |

## Architettura

```
                 ┌───────────────────────── Container "web" (Node.js 24) ─────────────────────────┐
 Twitch EventSub │  SEMPRE ATTIVI                                   SOLO DURANTE LA LIVE           │
  (WebSocket) ───┼─▶ eventsub/client ─▶ twitch/monitor ──(stati)──▶ game_engine/engine           │
 Twitch Helix  ◀─┼── twitch/helix, oauth, chat, rewards            ├─ spawn/   (timer, selezione)  │
                 │   game_engine/stateMachine                       ├─ capture/ (tentativi)         │
                 │   api/ (REST)  websocket/hub  security/          └─ commands/ (chat)             │
  Browser/OBS ◀──┼── public/ (dashboard /admin, overlay, pagine pubbliche)                         │
                 │   database/ (SQLite + migrazioni)  backup/  stats/  pokemon_data/ (PokéAPI)     │
                 └──────────────────────────── volume persistente /data ──────────────────────────┘
```

**Scelte tecniche** (motivate in [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md)):

- **Backend: Node.js 24 + SQLite integrato (`node:sqlite`)**, un'unica dipendenza esterna (`ws`). Nessun modulo nativo da compilare: l'immagine è piccola e identica su x86 e ARM (Raspberry Pi), dove gira Umbrel.
- **Frontend senza build** (moduli ES nativi + CSS): niente toolchain Node/Vite da mantenere, la dashboard viene servita direttamente dal backend. Lo stack suggerito (FastAPI/React/Vite) è stato valutato e scartato per ridurre parti mobili su un server domestico.
- **SQLite in modalità WAL** invece di PostgreSQL: un solo container, nessun servizio database da gestire, backup consistenti con `VACUUM INTO`, più che sufficiente per il carico di una chat Twitch. Le scritture concorrenti sono serializzate e protette da transazioni e vincoli `UNIQUE` (un solo spawn attivo, una sola sessione aperta, una sola elaborazione per riscossione).
- **EventSub via WebSocket**: nessuna porta del router da aprire, nessuna esposizione su Internet.
- **OAuth Device Code Flow**: l'autorizzazione Twitch funziona anche da rete locale senza HTTPS pubblico.

Struttura del repository:

```
src/
  server.js, app.js, config.js, logger.js
  api/            REST: auth, admin (dashboard), public
  database/       connessione SQLite, transazioni, migrazioni (migrations.js)
  configuration/  valori predefiniti e validazione impostazioni
  security/       hashing password, cifratura segreti, sessioni/CSRF, rate limit
  twitch/         OAuth (device flow), Helix, chat, ricompense, monitor stato diretta
  eventsub/       client EventSub WebSocket (keepalive, reconnect, backoff)
  game_engine/    macchina a stati, motore di gioco, sessioni LIVE
  spawn/          selezione per rarità/shiny, creazione e fine spawn
  capture/        calcolo probabilità e tentativi di cattura
  pokedex/        spettatori, Pokédex, classifica
  commands/       comandi chat
  pokemon_data/   importazione da PokéAPI e cache immagini
  stats/          statistiche
  backup/         backup, rotazione, ripristino, export/import
  websocket/      hub WebSocket (overlay + dashboard)
public/           frontend: admin/ (dashboard), overlay/, pagine pubbliche, assets/
test/             test automatici (node:test)
piu-live-catch/   pacchetto app per Umbrel (umbrel-app.yml + docker-compose.yml)
umbrel-app-store.yml  definizione del Community App Store
Dockerfile, docker-compose.yml, .github/workflows/ci.yml, scripts/, docs/
```

## Requisiti

- Un server con **Umbrel OS** (umbrelOS 1.x su Umbrel Home, Raspberry Pi 4/5 o PC x86), raggiungibile in rete locale.
- Un account **Twitch Affiliate o Partner** (i punti canale non esistono per gli altri account).
- **OBS Studio** (o Streamlabs/altri software con sorgente Browser).
- Connessione Internet sul server (per Twitch e per il primo download dei dati Pokémon).
- Circa 150 MB di spazio (immagine Docker + immagini di tutti i Pokémon).

## Installazione su Umbrel OS

Umbrel installa app di terze parti tramite i **Community App Store**: un repository Git che contiene `umbrel-app-store.yml` e una cartella per ogni app (`umbrel-app.yml` + `docker-compose.yml`). Umbrel **non compila** i Dockerfile: scarica un'immagine già pubblicata su un registry. Questo repository è già strutturato così:

- `umbrel-app-store.yml` → store con id `piu`
- `piu-live-catch/` → app con id `piu-live-catch` (l'id deve iniziare con l'id dello store)
- l'immagine `ghcr.io/michaelpiu/pokemon-twitch-catch` viene costruita da GitHub Actions per `linux/amd64` e `linux/arm64`.

### Metodo A — Community App Store (consigliato)

Prerequisiti una tantum (vedi [Cosa devi autorizzare tu](#cosa-devi-autorizzare-tu)):
1. L'immagine Docker su GitHub Container Registry deve essere **pubblica** (Umbrel non può autenticarsi).
2. Il repository usato come store deve essere **clonabile da Umbrel**, quindi pubblico. Se vuoi tenere privato il codice, crea un secondo repository pubblico che contenga solo `umbrel-app-store.yml` e la cartella `piu-live-catch/` (nessun codice sorgente) e usa quello come store.

Installazione:
1. Apri l'interfaccia di Umbrel (`http://umbrel.local`).
2. Vai in **App Store**, apri il menu **⋯** in alto a destra e scegli **Community App Stores** (la voce può variare leggermente tra versioni di umbrelOS).
3. Incolla l'URL del repository store (es. `https://github.com/MichaelPiu/pokemon-twitch-catch`) e premi **Add**.
4. Apri lo store **Piu**, seleziona **Live Catch** e premi **Install**.
5. Al termine apri l'app: si aprirà `http://umbrel.local:8788/admin`. Le credenziali iniziali (utente `admin` e password generata) sono visibili nella scheda dell'app in Umbrel.

I dati vengono salvati in `~/umbrel/app-data/piu-live-catch/data` e sono inclusi nei backup di Umbrel.

### Metodo B — Installazione manuale via SSH (funziona anche con repository privato)

Questo metodo usa Docker Compose direttamente sul server Umbrel. L'app **non comparirà** nella schermata di Umbrel, ma si riavvia da sola (`restart: unless-stopped`) e conserva i dati.

```bash
ssh umbrel@umbrel.local
```

```bash
git clone https://github.com/MichaelPiu/pokemon-twitch-catch.git ~/livecatch
```

(Per un repository privato GitHub chiede utente e un *Personal Access Token* con permesso di sola lettura sul repository, al posto della password.)

```bash
cd ~/livecatch && sh scripts/install-umbrel-ssh.sh
```

Lo script crea `.env` con una password iniziale casuale (la stampa a schermo), prepara `./data` con i permessi corretti (UID 1000), compila l'immagine sul server e avvia il container. La dashboard sarà su `http://umbrel.local:8788/admin`.

## Configurazione Docker

| Elemento | Valore |
|---|---|
| Porta interna | `8080` |
| Porta in rete locale | `8788` (Umbrel: campo `port` del manifest; metodo B: `HOST_PORT` in `.env`) |
| Volume persistente | `/data` → database (`db/`), immagini (`images/`), backup (`backups/`), log (`logs/`), chiave di cifratura (`secret.key`) |
| Utente | `1000:1000` (non root) |
| Riavvio | `on-failure` (Umbrel) / `unless-stopped` (metodo B) |
| Healthcheck | `GET /health` ogni 30 s |
| Log | file `/data/logs/app.log` con rotazione (5 MB × 3) + log Docker |

Variabili d'ambiente:

| Variabile | Default | Descrizione |
|---|---|---|
| `DATA_DIR` | `/data` | Cartella dati persistente |
| `PORT` | `8080` | Porta HTTP interna |
| `ADMIN_INITIAL_PASSWORD` | — | Password del primo accesso (su Umbrel `${APP_PASSWORD}`). Se assente viene generata e scritta in `/data/initial-admin-password.txt` |
| `APP_SECRET_KEY` | — | Chiave per cifrare i token Twitch. Se assente viene generata in `/data/secret.key` (**conservala nei backup del volume**) |
| `TZ` | `Europe/Rome` | Fuso orario per statistiche giornaliere e orario dei backup |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SECURE_COOKIES` | `false` | `true` solo se esponi la dashboard dietro HTTPS |

L'app **non** espone nulla su Internet: è raggiungibile solo dalla rete locale (e da Tailscale, se lo usi su Umbrel).

## Primo accesso

1. Apri `http://IP-DEL-SERVER:8788/admin`.
2. Accedi con utente `admin` e la password iniziale (Umbrel: credenziali dell'app; metodo B: stampata dallo script / in `.env`).
3. Ti verrà chiesto **obbligatoriamente** di scegliere una nuova password (min. 10 caratteri, lettere e numeri). Tutte le altre sessioni vengono chiuse.

## Configurazione Twitch

Tutto si fa dalla dashboard, sezione **Twitch**, seguendo i passi numerati.

**1. Crea l'applicazione Twitch**
1. Vai su <https://dev.twitch.tv/console/apps> e accedi (serve l'autenticazione a due fattori attiva su Twitch).
2. **Registra la tua applicazione**: nome a piacere, *URL di reindirizzamento OAuth* `http://localhost`, categoria *Chat Bot*, tipo client **Riservato** (*Confidential*).
3. Copia **Client ID** e genera un **Client Secret**; incollali nella dashboard e salva. Il segreto viene cifrato sul server e non viene mai più mostrato.

**2. Collega l'account del canale**
Premi **Collega account del canale**: compare un codice. Apri `https://www.twitch.tv/activate` (anche dal telefono), accedi con l'account del **tuo canale**, inserisci il codice e autorizza. La pagina si aggiorna da sola. Il canale monitorato è quello dell'account autorizzato.

**3. (Facoltativo) Account bot**
Se vuoi che le risposte in chat arrivino da un account separato (es. `MioCanaleBot`), collegalo allo stesso modo. Altrimenti risponde l'account del canale.

**4. Testa** con il pulsante **Testa connessione**: verifica token, API, punti canale ed EventSub.

### Scope OAuth richiesti

| Account | Scope | A cosa serve |
|---|---|---|
| Canale | `channel:read:redemptions` | Ricevere le riscossioni dei punti canale (EventSub) |
| Canale | `channel:manage:redemptions` | Creare/modificare le ricompense, rimborsare o completare le riscossioni |
| Canale | `user:read:chat` | Leggere la chat (EventSub `channel.chat.message`) per i comandi |
| Canale | `user:write:chat` | Rispondere in chat se non usi un bot |
| Bot (facoltativo) | `user:write:chat` | Rispondere in chat come bot |

Gli eventi `stream.online` / `stream.offline` non richiedono scope. Eventi EventSub usati: `stream.online`, `stream.offline`, `channel.channel_points_custom_reward_redemption.add`, `channel.channel_points_custom_reward_redemption.update`, `channel.chat.message`.

I token vengono rinnovati automaticamente e validati ogni ora (come richiesto da Twitch). Se un token viene revocato lo stato diventa **ERROR** e la dashboard chiede di ricollegare l'account.

## Creazione delle Channel Points Rewards

Sezione **Gestione Twitch → 4 · Ricompense punti canale**. Due modi:

- **Crea nuova ricompensa** (consigliato): scegli la Poké Ball e il costo → la ricompensa viene creata sul tuo canale. Essendo creata dall'app, l'app può **rimborsare automaticamente** i punti quando non c'è nessun Pokémon (o la diretta è finita) e segnare come *completate* le riscossioni valide; puoi anche cambiare costo e attivarla/disattivarla dalla dashboard.
- **Collega ricompensa esistente**: per ricompense create a mano su Twitch. Usa **Ricompense esistenti sul canale** per vederle e collegarle con un clic, oppure incolla l'ID (formato `xxxxxxxx-xxxx-…`). Twitch non permette all'app di rimborsarle o modificarle.

Suggerimento costi: Poké Ball 300, Mega Ball 800, Ultra Ball 2000, Master Ball 25000.
Usa **Verifica ID ricompense** per controllare che gli ID salvati esistano ancora.
I tentativi derivano **solo** da riscossioni reali ricevute da Twitch: l'app non simula mai riscossioni in modalità LIVE.

## Importazione dei Pokémon

Sezione **Pokémon → Importa da PokéAPI**. Puoi importare tutte le generazioni o solo alcune (es. `1,2`), con o senza forme alternative (importate disattivate) e immagini normali/shiny. L'operazione richiede qualche minuto per tutte le generazioni. Dati e immagini vengono salvati in `/data`: da quel momento il gioco funziona **senza contattare PokéAPI**. Una nuova importazione aggiorna i dati ma **non** sovrascrive rarità, difficoltà e abilitazioni che hai personalizzato.

Rarità iniziale: Mitico / Leggendario da PokéAPI; per gli altri dal *capture rate* (≥150 Comune, ≥75 Non comune, ≥45 Raro, altrimenti Epico). Tutto modificabile.

## Collegamento OBS

1. In OBS: **Sorgenti → + → Browser**.
2. URL: `http://IP-DEL-SERVER:8788/overlay` (es. `http://192.168.1.50:8788/overlay`). Su Windows usa l'**IP** invece di `umbrel.local`.
3. Larghezza `1920`, altezza `1080` (o quelle impostate in **Overlay**).
4. Spunta *Aggiorna il browser quando la scena diventa attiva*. Lo sfondo è già trasparente.

Quando non sei in diretta l'overlay è vuoto. Per provarlo usa la **Modalità DEMO** oppure i pulsanti di anteprima nella sezione **Overlay**.

## Configurazione della dashboard

Indirizzo unico: `http://IP-DEL-SERVER:8788/admin`. Sezioni:

Interfaccia con tema scuro viola, menu laterale (riducibile a sole icone), barra superiore con stato della connessione Twitch e menu utente.

- **Panoramica**: 6 indicatori (Stato Twitch, Motore di gioco, Partecipanti con nuovi allenatori di oggi, Catture con % di successo, Tentativi, Shiny), Pokémon attualmente in gioco con timer, tipi, rarità e probabilità base, grafico in tempo reale di tentativi/catture/partecipanti (ultimi 30 min, ultima ora o intera diretta), ultime catture, riepilogo della diretta corrente, attività recente, errori.
- **Statistiche**: diretta attuale, giornaliere/settimanali/mensili/complessive con grafici e classifiche.
- **Pokédex e Utenti**: ricerca, Pokédex, doppioni, shiny, storico, aggiunta/rimozione manuale, reset, esclusione dal gioco.
- **Gestione Spawn**: intervalli, durata, probabilità, pesi rarità, probabilità di cattura, shiny, eventi speciali, generazione manuale, storico.
- **Gestione Pokémon**: importazione, ricerca, rarità, difficoltà, peso di apparizione, abilitazione, shiny, statistiche.
- **Poké Ball e Ricompense**: crea, modifica moltiplicatori, cattura garantita, abilita/disabilita, collegamento ai punti canale.
- **Gestione Twitch**, **Comandi Chat**, **Overlay**, **Storico Dirette**, **Backup e Sistema** (backup, log, versione, stato componenti, spazio).
- **Impostazioni**: cambio password, pagine pubbliche, Modalità DEMO.

Pagine pubbliche (disattivabili da *Backup & Sistema*): `/` introduzione, `/pokedex/USERNAME`, `/leaderboard`. Endpoint di stato: `/health`.

## Comandi chat

| Comando | Risposta (personalizzabile) |
|---|---|
| `!pokedex` | `@Mario hai catturato 12 Pokémon e scoperto 8 specie! (1 shiny)` — riconosce automaticamente chi scrive |
| `!pokemon` | Totale Pokémon posseduti |
| `!dex @utente` | Pokédex di un altro spettatore (disattivabile) |
| `!ultimocatturato` | Ultimo Pokémon catturato |
| `!classifica` | Top allenatori |
| `!help` | Elenco comandi |

Prefisso, testi, alias, cooldown globale e per utente, anti-spam e limite di messaggi del bot si configurano in **Comandi chat**. I comandi funzionano **solo durante la diretta**.

## Backup

- **Automatico**: ogni giorno all'ora scelta (default 04:00), conservando gli ultimi N (default 14).
- **Manuale**: *Backup & Sistema → Crea backup ora*.
- File: `/data/backups/livecatch-AAAAMMGG-HHMMSS-tipo.sqlite.gz` (copia consistente del database, compressa). Scaricabili dalla dashboard.
- **Esportazione JSON** di spettatori, collezioni e impostazioni dei Pokémon (leggibile e importabile).
- Per una copia completa del volume (immagini e chiave di cifratura comprese): `sh scripts/backup-volume.sh <cartella-dati> <destinazione>`. Su Umbrel (metodo A) la cartella dell'app è inclusa anche nei backup di Umbrel.

## Ripristino

1. *Backup & Sistema → Backup*: scegli il file e premi **Ripristina** (oppure prima **Carica** un file `.sqlite.gz` scaricato in precedenza).
2. L'app crea automaticamente un backup *pre-restore* dello stato attuale, verifica integrità e appartenenza del file, sostituisce il database e riparte.
3. Il ripristino è bloccato durante una diretta.

Se ripristini su un'installazione nuova, i token Twitch salvati nel backup sono cifrati con la vecchia `secret.key`: ricopia anche quel file oppure ricollega gli account Twitch (2 minuti).

## Aggiornamento

- **Metodo A**: quando viene pubblicata una nuova versione (nuovo tag immagine + `version` aggiornata in `piu-live-catch/umbrel-app.yml`), Umbrel mostra l'aggiornamento nell'App Store. I dati in `app-data` restano intatti.
- **Metodo B**: `cd ~/livecatch && sh scripts/install-umbrel-ssh.sh` (esegue `git pull` e ricompila).

Il database viene migrato automaticamente all'avvio con migrazioni incrementali (`src/database/migrations.js`): non viene mai cancellato. Prima di un aggiornamento importante crea comunque un backup manuale.

## Risoluzione problemi

| Problema | Soluzione |
|---|---|
| Stato **ERROR – not_configured** | Completa i passi 1 e 2 della sezione Twitch. |
| Stato **ERROR – auth_error** | Il token è stato revocato o è scaduto: *Twitch → Ricollega*. |
| Stato **PAUSED** | Connessione a Twitch persa: il gioco è sospeso in sicurezza e riprende da solo appena la diretta viene confermata. Controlla la connessione Internet del server. |
| Vado in live ma il gioco non parte | *Twitch → Testa connessione*. Verifica che sia collegato l'account del canale che trasmette. Il controllo periodico (60 s) rileva la diretta anche se l'evento è andato perso. |
| La sottoscrizione `redemption` risulta *failed* | Il canale non è Affiliate/Partner o manca lo scope: ricollega l'account. |
| I punti non vengono rimborsati | Il rimborso funziona solo per ricompense **create dall'app**. |
| Il bot non risponde | I comandi funzionano solo in LIVE; controlla cooldown/anti-spam; se usi un bot separato, assicurati che non sia bannato nel canale. |
| Nessun Pokémon appare | Importa i Pokémon; verifica che ci siano Pokémon abilitati e che *Spawn automatici attivi* sia acceso. |
| Overlay vuoto in OBS | Usa l'IP del server; prova la Modalità DEMO; verifica che l'URL sia `/overlay`. |
| Ho perso la password admin | Crea un file vuoto chiamato `reset-admin-password` nella cartella dati (Umbrel: `~/umbrel/app-data/piu-live-catch/data/`, metodo B: `~/livecatch/data/`) e riavvia l'app. La nuova password temporanea sarà nel file `initial-admin-password.txt` nella stessa cartella. I dati di gioco non vengono toccati. |
| Log | *Backup & Sistema → Log*, oppure il file `/data/logs/app.log`. |

## Sviluppo e test

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

Requisiti: Node.js ≥ 22.13. I test (`test/`) coprono: spawn, cattura riuscita/fallita, catture simultanee, eventi duplicati e replay, comandi chat, Pokédex, sessioni LIVE, arresto del motore offline, ripartenza automatica LIVE, disconnessione Twitch (PAUSED e ripresa), riavvio server, persistenza, backup/ripristino, sicurezza HTTP. Twitch viene simulato con un server EventSub WebSocket locale e un finto Helix: **solo nei test**.

## Cosa devi autorizzare tu

Alcuni passaggi richiedono i tuoi account e non possono essere completati dallo sviluppatore:

1. **Twitch**: creare l'applicazione su dev.twitch.tv e autorizzare l'account del canale (e l'eventuale bot) con il codice di attivazione.
2. **Affiliate/Partner**: necessario per i punti canale.
3. **GitHub Container Registry**: dopo la prima build di GitHub Actions, rendere **pubblico** il pacchetto `pokemon-twitch-catch` (GitHub → profilo → *Packages* → pacchetto → *Package settings* → *Change visibility*), altrimenti Umbrel non può scaricarlo.
4. **Store Umbrel**: rendere pubblico il repository (oppure creare un repository store pubblico separato, vedi Metodo A).
5. Facoltativo: per massima riproducibilità, sostituire nel `docker-compose.yml` dell'app il tag con il digest `@sha256:…` mostrato nel riepilogo della GitHub Action.
