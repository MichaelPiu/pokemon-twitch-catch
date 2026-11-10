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
7. [Sicurezza dell'accesso](#sicurezza-dellaccesso)
8. [Configurazione Twitch](#configurazione-twitch)
9. [Channel Points Rewards](#creazione-delle-channel-points-rewards)
10. [Importazione dei Pokémon](#importazione-dei-pokémon)
11. [Collegamento OBS](#collegamento-obs)
12. [Configurazione della dashboard](#configurazione-della-dashboard)
13. [Comandi chat](#comandi-chat)
14. [Modalità manuale](#modalità-manuale-gioco-senza-twitch) · [Modifica del Pokédex](#modifica-manuale-del-pokédex) · [Classifiche, Hall of Fame e Stream Recap](#classifiche-hall-of-fame-e-stream-recap) · [Effetti sonori per OBS](#effetti-sonori-per-obs)
15. [Backup](#backup) · [Ripristino](#ripristino) · [Aggiornamento](#aggiornamento)
16. [Risoluzione problemi](#risoluzione-problemi)
17. [Sviluppo e test](#sviluppo-e-test)
18. [Pubblicazione di una nuova versione](#pubblicazione-di-una-nuova-versione)
19. [Cosa devi autorizzare tu](#cosa-devi-autorizzare-tu)

Dettagli specifici per Umbrel (pubblicazione, verifiche, stato dei test): [docs/UMBREL.md](docs/UMBREL.md). Modifiche per versione: [CHANGELOG.md](CHANGELOG.md).

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
| Dashboard | Unica, con sidebar: Panoramica, Controllo gioco, Classifiche, Statistiche, Storico dirette, Spettatori & Pokédex, Modifica Pokédex, Spawn, Pokémon, Poké Ball, Comandi, Overlay, Twitch, DEMO, Backup & Sistema. |
| Sicurezza | Password scrypt, cambio password obbligatorio, sessioni HttpOnly/SameSite, CSRF, rate limiting, token Twitch cifrati AES-256-GCM, redazione dei segreti nei log. |
| Backup | Giornaliero automatico con rotazione, manuale, download/upload, ripristino guidato con backup di sicurezza, esportazione/importazione JSON. |
| Modalità manuale | Avvia il vero motore di gioco dalla dashboard con il canale OFFLINE (prove, OBS, giochi in locale): dati reali marcati MANUAL, sessioni distinte da quelle Twitch, la diretta ha sempre la priorità. |
| Modifica Pokédex | Ricerca, filtri, correzione, registrazione e rimozione di esemplari con anteprima delle differenze, controllo dei conflitti e registro delle modifiche. |
| Backup di rete | Backup automatici su una cartella di rete montata (NFS/SMB tramite Umbrel o volume Docker) con manifest e checksum, verifica della connessione, ritentativi, rotazione e ripristino guidato. |
| Classifiche | Classifica catture e classifica punti per ogni sessione (Twitch o manuale), aggiornate in tempo reale; podio, vincitore, riepilogo e Hall of Fame nell'overlay OBS, visibili finché non li nascondi; risultati congelabili; comando `!leaderboard` per broadcaster e moderatori. |
| Effetti sonori | Un suono casuale a ogni spawn e la musica di conferma a ogni cattura riuscita, riprodotti dalla stessa Browser Source dell'overlay (`/overlay`), solo dentro OBS; file audio tuoi, nella cartella dati. |
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

- Un server con **Umbrel OS** (umbrelOS 1.x o 2.x su Umbrel Home, Raspberry Pi 4/5 o PC x86), raggiungibile in rete locale.
- Un account **Twitch Affiliate o Partner** (i punti canale non esistono per gli altri account).
- **OBS Studio** (o Streamlabs/altri software con sorgente Browser).
- Connessione Internet sul server (per Twitch e per il primo download dei dati Pokémon).
- Circa 150 MB di spazio (immagine Docker + immagini di tutti i Pokémon).

## Installazione su Umbrel OS

Umbrel installa app di terze parti tramite i **Community App Store**: un repository Git che contiene `umbrel-app-store.yml` e una cartella per ogni app (`umbrel-app.yml` + `docker-compose.yml`). Umbrel **non compila** i Dockerfile: scarica un'immagine già pubblicata su un registry.

- **Repository dello store (pubblico, nessun codice sorgente)**: <https://github.com/MichaelPiu/piu-umbrel-app-store> — store `piu`, app `piu-live-catch`.
- **Repository di sviluppo (questo, pubblico)**: <https://github.com/MichaelPiu/pokemon-twitch-catch>, contiene il codice e la "sorgente" del pacchetto (`umbrel-app-store.yml`, `piu-live-catch/`, `store/`). Lo store pubblico si genera con `scripts/publish-store.sh`.
- **Immagine**: `ghcr.io/michaelpiu/pokemon-twitch-catch`, costruita da GitHub Actions per `linux/amd64` e `linux/arm64` e, nello store, fissata per tag **e** digest.

### Metodo A — Community App Store (consigliato)

Prerequisito: l'immagine Docker su GitHub Container Registry deve essere **pubblica**, perché Umbrel la scarica senza credenziali (lo controlla l'Action dello store a ogni modifica).

> **Stato attuale (10 novembre 2026): pubblicata la Release Candidate 1.0.0-rc.3.**
> - **immagine pubblica**: il repository GitHub e il pacchetto GHCR sono pubblici (sono due impostazioni separate); il token anonimo di pull risponde HTTP 200;
> - **manifest e digest**: `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.0-rc.3@sha256:5b1fb376086df52b883cac684ae939c0451f1a92695c8599a8c1cc79b5dbb114`, indice multi-arch con `linux/amd64` e `linux/arm64`; stesso digest nel log della CI, nel controllo anonimo bloccante e nello store. Tutti i layer di entrambe le architetture sono stati scaricati senza credenziali e verificati;
> - **verifica dello store**: lo store contiene la rc.3 e la sua Action (linter ufficiale con `--check-images`) è superata;
> - **non ancora verificati**: l'installazione reale su un Umbrel e l'uso con Twitch e OBS reali.

Installazione:
1. Apri l'interfaccia di Umbrel (`http://umbrel.local`).
2. Vai in **App Store**, apri il menu **⋯** in alto a destra e scegli **Community App Stores** (la voce può variare leggermente tra versioni di umbrelOS).
3. Incolla `https://github.com/MichaelPiu/piu-umbrel-app-store` e premi **Add**.
4. Apri lo store **Piu**, seleziona **Live Catch** e premi **Install**.
5. Al termine apri l'app: si aprirà `http://umbrel.local:8788/admin`. Le credenziali iniziali (utente `admin` e password generata) sono visibili nella scheda dell'app in Umbrel.

I dati vengono salvati in `~/umbrel/app-data/piu-live-catch/data` e sono inclusi nei backup di Umbrel.

### Metodo B — Installazione manuale via SSH (compila l'immagine sul server)

Questo metodo usa Docker Compose direttamente sul server Umbrel. L'app **non comparirà** nella schermata di Umbrel, ma si riavvia da sola (`restart: unless-stopped`) e conserva i dati.

```bash
ssh umbrel@umbrel.local
```

```bash
git clone https://github.com/MichaelPiu/pokemon-twitch-catch.git ~/livecatch
```

```bash
cd ~/livecatch && sh scripts/install-umbrel-ssh.sh
```

Lo script crea `.env` con una password iniziale casuale (la stampa a schermo), prepara `./data` con i permessi corretti (UID 1000), compila l'immagine sul server e avvia il container. La dashboard sarà su `http://umbrel.local:8788/admin`.

## Configurazione Docker

| Elemento | Valore |
|---|---|
| Porta interna | `8080` |
| Porta in rete locale | `8788` (Umbrel: campo `port` del manifest; metodo B: `HOST_PORT` in `.env`) |
| Volume persistente | `/data` → database (`db/`), immagini (`images/`), backup (`backups/`), log (`logs/`), chiave di cifratura (`secret.key`), file audio per OBS (`audio/`) |
| Utente | `1000:1000` (non root) |
| Riavvio | `on-failure` (Umbrel) / `unless-stopped` (metodo B) |
| Healthcheck | `GET /health` ogni 30 s (ogni 3 s durante l'avvio); risponde 200 anche quando Twitch è offline o in errore, così il container non viene riavviato a vuoto |
| Avvio | se `/data` non è scrivibile dall'utente 1000 il container si ferma subito con un messaggio chiaro |
| Immagine base | `node:24-alpine` fissata per digest nel `Dockerfile` (aggiornabile con `scripts/update-base-digest.sh`) |
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
| `SECURE_COOKIES` | `false` | Forza il cookie `Secure`. Non serve dietro un proxy fidato che inoltra `X-Forwarded-Proto: https`: viene rilevato da solo |
| `TRUSTED_PROXIES` | vuoto | Proxy autorizzati a inoltrare l'IP del browser (`X-Forwarded-For`). Vuoto = accesso diretto, header ignorati. Su Umbrel il pacchetto imposta `docker-gateway,piu-live-catch_app_proxy_1`. Voci ammesse: IP, rete CIDR, `loopback`, `docker-gateway`, nome host |
| `ADMIN_HOSTS` | vuoto | Hostname dedicati alla dashboard (es. `livecatch.lan`). Ha la precedenza sull'impostazione della dashboard |
| `ALLOWED_ORIGINS` | vuoto | Origini aggiuntive ammesse per la dashboard (es. `https://livecatch.example.lan` dietro un reverse proxy HTTPS) |
| `WS_OVERLAY_MAX_CONNECTIONS` | `100` | Connessioni WebSocket dell'overlay (OBS, anteprime) accettate in totale. Oltre il limite la connessione riceve 503 e l'overlay riprova da solo |
| `WS_OVERLAY_MAX_PER_IP` | `30` | Connessioni dell'overlay accettate da uno stesso indirizzo IP (basta per una sorgente Browser per ogni scena di OBS). Dietro il proxy di Umbrel l'IP è quello del browser solo se `TRUSTED_PROXIES` è corretto |
| `TWITCH_HTTP_TIMEOUT_MS` | `10000` | Tempo massimo di una chiamata alle API di Twitch |
| `TWITCH_HTTP_RETRIES` | `2` | Ritentativi automatici sugli errori temporanei di Twitch (rete, timeout, HTTP 429 e 5xx) |

La vecchia variabile `TRUST_PROXY` non esiste più (con la 0.x gli header inoltrati erano considerati sempre affidabili): se è impostata viene ignorata con un avviso nei log.

L'app **non** espone nulla su Internet: è raggiungibile solo dalla rete locale (e da Tailscale, se lo usi su Umbrel).

## Primo accesso

1. Apri `http://IP-DEL-SERVER:8788/admin`.
2. Accedi con utente `admin` e la password iniziale (Umbrel: credenziali dell'app; metodo B: stampata dallo script / in `.env`).
3. Ti verrà chiesto **obbligatoriamente** di scegliere una nuova password (min. 10 caratteri, lettere e numeri). Tutte le altre sessioni vengono chiuse.

## Sicurezza dell'accesso

**Cosa fa l'app da sola**

- **IP reale e limite ai tentativi di login**: gli header `X-Forwarded-For` / `X-Forwarded-Proto` vengono considerati solo se la connessione arriva da un proxy elencato in `TRUSTED_PROXIES`. In quel caso si usa l'ultimo indirizzo aggiunto dal proxy, mai i valori scritti dal browser. Oltre al limite per IP (10 tentativi in 15 minuti) c'è un limite per account (30 errori in 15 minuti, qualunque sia l'IP).
- **Origin e Host**: il WebSocket della dashboard (`/ws/admin`) accetta la connessione solo se l'`Origin` del browser coincide con l'host della dashboard (o con `ALLOWED_ORIGINS`) e se l'host è ammesso. Le richieste che modificano dati da un'altra origine vengono rifiutate anche con cookie e token CSRF validi. L'overlay (`/overlay`, `/ws/overlay`) resta pubblico e funziona da OBS.
- **Sessioni**: il cookie `HttpOnly`, `SameSite=Strict` vale solo per il browser (User-Agent) e, per impostazione predefinita, per l'indirizzo IP da cui hai fatto il login. Si chiude dopo 12 ore di inattività (configurabile) e comunque dopo 7 giorni. Diventa `Secure` da solo quando la dashboard è aperta in HTTPS tramite un proxy fidato.

**Il limite che solo tu puoi chiudere: i cookie non sono isolati per porta.** Su Umbrel tutte le app stanno su `umbrel.local` (porte diverse) e il browser invia i cookie di `umbrel.local` a **ogni** app. Un'app malevola installata sullo stesso Umbrel riceverebbe quindi il cookie della dashboard. Il vincolo a IP + browser lo rende inutilizzabile da un altro indirizzo. Con un **hostname dedicato** il cookie creato su `livecatch.lan` non viene mai inviato a `umbrel.local`. Resta un limite: un'app malevola potrebbe portare il browser su `livecatch.lan:<sua porta>` per ricevere il cookie. In quel caso il vincolo a IP + browser lo rende comunque inutilizzabile, quindi tieni attiva l'opzione *Sessione valida solo dall'indirizzo IP del login*.

### Hostname dedicato (consigliato)

In breve:

1. Assegna al server Umbrel un **IP fisso** (prenotazione DHCP sul router).
2. Crea un nome (es. `livecatch.lan`) che punti a quell'IP:
   - con un record DNS locale sul router, Pi-hole o AdGuard;
   - oppure nel file `hosts` del PC.
3. Apri `http://livecatch.lan:8788/admin` e accedi.
4. *Impostazioni → Sicurezza dell'accesso → Hostname dedicati*: scrivi `livecatch.lan` e salva. L'app accetta il salvataggio solo se stai già usando quel nome, così non resti chiuso fuori.

Da quel momento:
- `umbrel.local:8788/admin` (anche dall'icona dell'app in Umbrel) mostra solo il link al nuovo indirizzo e non crea cookie;
- overlay e pagine pubbliche funzionano su qualsiasi indirizzo, quindi OBS non va riconfigurato.

Guida completa con i comandi per macOS, Windows, router e Pi-hole, i nomi da evitare, le verifiche e il ripristino: [docs/UMBREL.md → Hostname dedicato](docs/UMBREL.md#hostname-dedicato-passo-per-passo).

Con il Metodo B puoi anche impostarlo da file: `ADMIN_HOSTS=livecatch.lan` in `.env`, poi `docker compose up -d`. In questo caso l'impostazione della dashboard è bloccata.

Se resti chiuso fuori, il file `reset-admin-password` (vedi [Risoluzione problemi](#risoluzione-problemi)) reimposta la password **e** rimuove l'hostname dedicato.

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
| Canale | `channel:read:redemptions` | Leggere ricompense e riscatti. È già incluso in `channel:manage:redemptions`, che Twitch accetta al suo posto per gli eventi dei riscatti: è richiesto per compatibilità ma non è indispensabile |
| Canale | `channel:manage:redemptions` | Creare e modificare le ricompense (anche la pausa), leggere i riscatti in coda, rimborsarli o completarli (*Update Redemption Status*) |
| Canale | `user:read:chat` | Leggere la chat (EventSub `channel.chat.message`, con il canale come utente che legge) |
| Canale | `user:write:chat` | Rispondere in chat se non usi un bot, o se il token del bot viene revocato |
| Bot (facoltativo) | `user:write:chat` | Rispondere in chat come bot (*Send Chat Message* con token utente) |

Verifica sulla documentazione ufficiale Twitch (novembre 2026): gli scope corrispondono ai requisiti degli endpoint e degli eventi usati. Le informazioni provengono da `dev.twitch.tv` tramite i risultati di ricerca: le pagine non si aprono direttamente dalla rete di sviluppo, che rifiuta il loro certificato TLS. Fonti:
- [Scope](https://dev.twitch.tv/docs/authentication/scopes/)
- [API Reference](https://dev.twitch.tv/docs/api/reference)
- [Tipi di sottoscrizione EventSub](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)

Non sono richiesti `user:bot` / `channel:bot`: servono solo per il badge "Chat Bot" con token applicazione, che l'app non usa.

Gli eventi `stream.online` / `stream.offline` non richiedono scope. Eventi EventSub usati: `stream.online`, `stream.offline`, `channel.channel_points_custom_reward_redemption.add`, `channel.channel_points_custom_reward_redemption.update`, `channel.chat.message`.

I token vengono rinnovati automaticamente e validati ogni ora (come richiesto da Twitch).

**Token revocato** (app scollegata da Twitch, password cambiata, rinnovo rifiutato):

- **Account del canale**:
  - lo stato diventa **ERROR** subito, alla revoca delle sottoscrizioni EventSub, o al controllo periodico successivo;
  - il gioco smette di accettare lanci;
  - la dashboard mostra un avviso con le ricompense che **potrebbero restare riscattabili** su Twitch, perché senza un token valido non è possibile metterle in pausa: per sicurezza mettile in pausa a mano dal Creator Dashboard di Twitch;
  - i riscatti fatti nel frattempo restano in coda (i punti non sono persi): i tentativi di rimborso non si esauriscono e, quando premi **Ricollega**, l'app mette in pausa le ricompense e rimborsa tutti i riscatti rimasti in coda;
  - se il rinnovo torna a funzionare da solo, l'app ricollega EventSub e ricrea le sottoscrizioni.
- **Bot**: il gioco continua. Le risposte passano all'account del canale finché non ricolleghi il bot.

## Creazione delle Channel Points Rewards

Sezione **Gestione Twitch → 4 · Ricompense punti canale**. Due modi:

- **Crea nuova ricompensa** (consigliato): scegli la Poké Ball e il costo → la ricompensa viene creata sul tuo canale. Essendo creata dall'app, l'app può **rimborsare automaticamente** i punti quando non c'è nessun Pokémon (o la diretta è finita) e segnare come *completate* le riscossioni valide; puoi anche cambiare costo e attivarla/disattivarla dalla dashboard.
- **Collega ricompensa esistente**: per ricompense create a mano su Twitch. Usa **Ricompense esistenti sul canale** per vederle e collegarle con un clic, oppure incolla l'ID (formato `xxxxxxxx-xxxx-…`). Twitch non permette all'app di rimborsarle o modificarle.

Suggerimento costi: Poké Ball 300, Mega Ball 800, Ultra Ball 2000, Master Ball 25000.

### Quando il gioco non è attivo: pausa automatica e recupero dei riscatti

Per evitare che gli spettatori spendano punti a vuoto:

- **Pausa automatica** (attiva di default): le ricompense **create dall'app** vengono messe in pausa su Twitch quando il gioco non accetta lanci (canale offline, connessione con Twitch persa, errore) e riattivate quando torni LIVE. Una pausa o riattivazione non riuscita viene registrata e ritentata al controllo successivo (ogni 60 s).
- **Riscatti ricevuti mentre il gioco non è attivo**: vengono rifiutati e, per le ricompense dell'app, **rimborsati** (stato `CANCELED`).
- **Recupero dopo una disconnessione**: i riscatti fatti mentre l'app non riceveva eventi non arrivano più via EventSub. Alla riconnessione, all'avvio e ogni 5 minuti l'app legge da Twitch i riscatti ancora **in coda** (`UNFULFILLED`) delle ricompense create dall'app e li elabora con l'orario reale del riscatto. Se il Pokémon c'era ancora il lancio vale normalmente; se era già fuggito, o lo spawn è stato interrotto dalla disconnessione, i punti vengono rimborsati. Un riscatto non viene mai elaborato due volte: se arriva sia dal recupero sia da EventSub, vale una volta sola.
- **Eventi tardivi**: le notifiche EventSub più vecchie di 10 minuti vengono scartate (protezione dai replay), ma registrate tra gli eventi come `stale`. Se il riscatto è ancora in coda, lo recupera la riconciliazione.
- **Errori**: se il rimborso o la conferma su Twitch falliscono (rete, Twitch non disponibile) lo stato da applicare viene salvato e ritentato fino a 6 volte. Se Twitch risponde che la riscossione non è più in coda (gestita a mano) non si ritenta. Tutto è visibile in *Gestione Twitch → 5 · Riscatti e recupero*, con il pulsante **Recupera riscatti ora**.
- **Ricompensa del gioco senza Poké Ball valida** (es. Poké Ball eliminata): il riscatto viene rifiutato e rimborsato invece di essere ignorato.

### Limiti delle ricompense collegate a mano

Twitch consente di modificare le ricompense e di leggere o aggiornare i loro riscatti **solo all'applicazione che le ha create** (stesso Client ID). Per una ricompensa creata a mano su Twitch e solo collegata all'app:

- ❌ niente pausa automatica fuori dalla diretta: mettila in pausa tu su Twitch, oppure sostituiscila con una creata dall'app;
- ❌ niente rimborso automatico dei lanci non validi: i punti restano spesi e la riscossione resta nella coda delle richieste del canale, dove puoi rimborsarla a mano;
- ❌ niente recupero dei riscatti persi durante una disconnessione.

Per questo è consigliato creare le ricompense dalla dashboard.
Usa **Verifica ID ricompense** per controllare che gli ID salvati esistano ancora.
I tentativi derivano **solo** da riscossioni reali ricevute da Twitch: l'app non simula mai riscossioni in modalità LIVE.

## Importazione dei Pokémon

Sezione **Pokémon → Importa da PokéAPI**. Puoi importare tutte le generazioni o solo alcune (es. `1,2`), con o senza forme alternative (importate disattivate) e immagini normali/shiny. L'operazione richiede qualche minuto per tutte le generazioni. Dati e immagini vengono salvati in `/data`: da quel momento il gioco funziona **senza contattare PokéAPI**. Una nuova importazione aggiorna i dati ma **non** sovrascrive rarità, difficoltà e abilitazioni che hai personalizzato.

Rarità iniziale: Mitico / Leggendario da PokéAPI; per gli altri dal *capture rate* (≥150 Comune, ≥75 Non comune, ≥45 Raro, altrimenti Epico). Tutto modificabile.

## Collegamento OBS

1. In OBS: **Sorgenti → + → Browser**.
2. URL: `http://IP-DEL-SERVER:8788/overlay` (es. `http://192.168.1.50:8788/overlay`). Su Windows usa l'**IP** invece di `umbrel.local`.
3. Larghezza `1920` e altezza `1080`, oppure `1280` × `720`. L'overlay disegna tutto su una tela 1920×1080 e la scala alla dimensione della sorgente, quindi l'aspetto è identico.
4. Spunta *Aggiorna il browser quando la scena diventa attiva*. Lo sfondo è già trasparente.
5. **Effetti sonori**: spunta *Controlla l'audio tramite OBS*. La stessa sorgente riproduce anche i suoni di spawn e cattura: non serve una seconda sorgente (vedi [Effetti sonori per OBS](#effetti-sonori-per-obs)).

**Dopo un aggiornamento dell'app**: OBS conserva in cache i file della pagina. Apri le proprietà della sorgente Browser e premi **Aggiorna la cache della pagina corrente** (oppure rimuovi e ricrea la sorgente). Senza questo passaggio la sorgente può continuare a usare il codice precedente fino al riavvio di OBS. Il cambio di tema invece non richiede mai di ricaricare.

**Requisiti del browser della sorgente.** La sorgente Browser di OBS usa Chromium (CEF). L'overlay usa:
- `color-mix()`, che richiede Chromium 111 o successivo;
- `backdrop-filter` (temi Clean Glass e Holographic);
- `@property`, le variabili CSS e `clip-path`.

Con un Chromium più vecchio alcuni effetti (sfumature, vetro smerigliato) possono mancare o apparire diversi; le informazioni di gioco restano leggibili. Le versioni di Chromium incluse nelle singole versioni di OBS **non sono state verificate** in questo progetto: controlla la tua versione di OBS (*Aiuto → Informazioni*) e prova l'anteprima con un tema prima della diretta.

Quando non sei in diretta l'overlay è vuoto. Per provarlo usa la **Modalità DEMO** oppure il simulatore dell'**Overlay Designer**.

### Overlay Designer (temi)

Sezione **Overlay Designer** della dashboard. Contiene **9 temi integrati**, ognuno con una disposizione propria e non una semplice variazione di colore:

| Tema | Stile |
|---|---|
| Classico | L'aspetto delle versioni precedenti: card centrata con bordo del colore della rarità. È il tema attivo dopo l'aggiornamento, così la diretta non cambia aspetto |
| Minimal Dark | Barra orizzontale compatta: immagine a sinistra, linea del tempo sottile |
| Clean Glass | Vetro smerigliato, con il Pokémon che fluttua sopra la card |
| Neon HUD | Interfaccia sci-fi: angoli tagliati, staffe di mira, timer circolare al neon, linee di scansione |
| Minimal Light | Stile editoriale chiaro: titolo serif, filetti, timer numerico |
| Cyber Pulse | Pannello inclinato, nome con effetto glitch, bordo pulsante, grande conto alla rovescia |
| Holographic | Carta collezionabile con bordo iridescente e riflesso olografico |
| Cinematic | Sottopancia panoramico a tutta larghezza; le notifiche appaiono come sottotitoli |
| Gradient Motion | Gradienti in movimento, forme morbide, entrate elastiche |

**Cosa puoi fare:**
- **Gestire i temi**: selezionarli, duplicarli, modificarli, salvarli, ripristinare i valori originali, creare temi personalizzati partendo da uno stile grafico, importarli ed esportarli in JSON. I preset integrati non si possono eliminare ma si possono ripristinare.
- **Modificare**:
  - colori, compreso lo sfondo con la sua opacità;
  - font e dimensioni del testo, spessore, maiuscolo, spaziatura;
  - bordi, angoli, ombre e bagliore;
  - posizione (9 posizioni) con margini, larghezza del pannello, dimensione dell'immagine e scala;
  - entrata, uscita e velocità delle animazioni, e quanti eventi possono restare in coda prima che le animazioni vengano saltate;
  - durata delle notifiche e quante ne restano visibili insieme;
  - elementi mostrati e stile del timer (barra, anello, numeri);
  - intensità degli effetti.
- **Anteprima in tempo reale**: è la stessa pagina `/overlay` che usa OBS, alla risoluzione scelta (1920×1080 o 1280×720) e con lo sfondo che preferisci. Ogni modifica si vede subito, senza ricaricare e senza salvare.
- **Cambio tema senza riavvio**: **▶ Usa su OBS** invia il tema all'overlay via WebSocket; anche il salvataggio del tema attivo aggiorna OBS subito.
- **Font**:
  - le famiglie proposte sono font di sistema, senza download esterni;
  - un font personalizzato deve essere installato sul **PC che esegue OBS**;
  - il nome del font personalizzato può contenere lettere (anche accentate), cifre, spazi, trattini e punti, fino a 60 caratteri; apostrofi, virgolette, virgole e punti e virgola non sono ammessi;
  - l'anteprima nel browser della dashboard può mostrare un font diverso se lì non è installato.
- **Prestazioni**: con **intensità effetti 0** non ci sono animazioni continue. Quando nessun Pokémon è visibile l'overlay non esegue animazioni.
- **Molti riscatti ravvicinati**: lanci, catture e fughe passano da una coda con un limite configurabile (*Animazioni → Eventi in coda prima di saltare le animazioni*, predefinito 6).
  - Quando la coda è piena a metà le animazioni diventano 3 volte più rapide.
  - Quando la coda è piena le animazioni vengono saltate.
  - Esiti, tentativi e catture restano sempre esatti: nessun evento reale viene perso.
  - Se le notifiche in attesa superano il massimo, si scartano per prime le meno importanti; le catture reali restano.
  - Il cambio di tema non aspetta la coda: viene applicato subito, e il contatore dei tentativi resta quello corretto.
- **Leggibilità**: le scritte piccole hanno una dimensione minima di 14 px e le notifiche di 18 px, sulla tela 1920×1080 (a 1280×720 diventano circa 9 e 12 px). Il testo dei preset ha un contrasto di almeno 4,5:1 sul proprio pannello, anche sopra una scena di gioco chiara.
- **Modifiche contemporanee**: se lo stesso tema viene salvato da un'altra scheda o da un'altra persona dopo che lo hai aperto, il salvataggio non sovrascrive nulla. Il Designer chiede se **ricaricare** la versione salvata o **sovrascriverla** consapevolmente.
- **Formato JSON** (`livecatch-overlay-theme`, versione 1):
  - massimo 64 KB;
  - ogni valore viene validato: colori solo `#hex`, `rgb()`, `rgba()` o `transparent`; numeri riportati negli intervalli consentiti; campi sconosciuti scartati;
  - l'importazione crea sempre un **nuovo** tema personalizzato e mostra cosa è stato corretto.

**Simulatore** (pulsanti sotto l'anteprima):
- **Eventi disponibili**: spawn, shiny, leggendario, lancio fallito, cattura, fuga, scadenza, notifica di prova, sequenza completa, pulizia.
- **Isolamento**: gli eventi simulati non passano dal motore di gioco e **non scrivono nulla nel database**. Pokédex, statistiche, classifiche, catture e storico delle dirette non cambiano (verificato da test automatici). Il simulatore legge soltanto l'elenco dei Pokémon, per mostrare nomi e immagini veri.
- **Anteprima privata o overlay pubblico**:
  - Normalmente le simulazioni compaiono **solo nell'anteprima privata** del Designer, che funziona sempre, anche durante una diretta.
  - Con *Invia anche all'overlay pubblico (OBS)* gli eventi arrivano anche alle sorgenti OBS collegate, con il badge **SIMULAZIONE**.
  - L'invio all'overlay pubblico è consentito solo a gioco fermo (OFFLINE, senza DEMO). In LIVE, in PAUSED e in DEMO l'opzione è disattivata, e così in ERROR o CONNECTING quando Twitch ha segnalato il canale in diretta. Il server rifiuta la richiesta (HTTP 409) anche se l'API viene chiamata direttamente.
  - Ogni invio all'overlay pubblico è registrato nel log (*Backup e Sistema → Log*).
- **Pulizia automatica**:
  - Quando parte la diretta o la DEMO, gli elementi simulati ancora visibili vengono tolti subito dall'overlay, insieme a eventuali sequenze in corso.
  - Spawn e notifiche reali non vengono toccati.
  - Lo stesso vale se OBS si ricollega durante il passaggio: alla riconnessione riceve solo lo stato reale.

## Configurazione della dashboard

Indirizzo unico: `http://IP-DEL-SERVER:8788/admin`. Sezioni:

Interfaccia con tema scuro viola, menu laterale (riducibile a sole icone), barra superiore con stato della connessione Twitch e menu utente.

- **Panoramica**: 6 indicatori (Stato Twitch, Motore di gioco, Partecipanti con nuovi allenatori di oggi, Catture con % di successo, Tentativi, Shiny), Pokémon attualmente in gioco con timer, tipi, rarità e probabilità base, grafico in tempo reale di tentativi/catture/partecipanti (ultimi 30 min, ultima ora o intera diretta), ultime catture, riepilogo della diretta corrente, attività recente, errori.
- **Statistiche**: diretta attuale, giornaliere/settimanali/mensili/complessive con grafici e classifiche.
- **Pokédex e Utenti**: ricerca, Pokédex, doppioni, shiny, storico, aggiunta/rimozione manuale, reset, esclusione dal gioco.
- **Gestione Spawn**: intervalli, durata, probabilità, pesi rarità, probabilità di cattura, shiny, eventi speciali, generazione manuale, storico.
- **Gestione Pokémon**: importazione, ricerca, rarità, difficoltà, peso di apparizione, abilitazione, shiny, statistiche.
- **Poké Ball e Ricompense**: crea, modifica moltiplicatori, cattura garantita, abilita/disabilita, collegamento ai punti canale.
- **Gestione Twitch**, **Comandi Chat**, **Overlay Designer** (vedi [Overlay Designer](#overlay-designer-temi)), **Storico Dirette**, **Backup e Sistema** (backup, log, versione, stato componenti, spazio).
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
| `!leaderboard [hide\|freeze\|winner]` | Riservato a broadcaster e moderatori: mostra o nasconde la classifica nell'overlay, congela i risultati (solo broadcaster), mostra il vincitore. Vedi [Classifiche](#classifiche-hall-of-fame-e-stream-recap). |

Prefisso, testi, alias, cooldown globale e per utente, anti-spam e limite di messaggi del bot si configurano in **Comandi chat**. I comandi funzionano **solo durante la diretta**.

## Modalità manuale (gioco senza Twitch)

Sezione **Controllo gioco** della dashboard.

- **AUTOMATICA** (normale): il gioco parte e si ferma con la diretta Twitch.
- **MANUALE**: *Avvia gioco manualmente* accende lo stesso motore della diretta (spawn, probabilità, rarità, shiny, Pokédex, statistiche, overlay) con il canale **OFFLINE**. Lo stato Twitch non viene finto: nessuna sottoscrizione EventSub, nessun riscatto reale, nessun messaggio in chat.
- Durante la sessione la barra in alto mostra **SESSIONE MANUALE**; la pagina mostra tempo trascorso, incontri, catture, lanci ed errori. Da lì si genera un incontro e si lancia una Poké Ball per un *giocatore locale* (account separato, prefisso `local:`, mai confuso con un utente Twitch) o per uno spettatore già registrato.
- *Ferma gioco* chiude la sessione: catture e statistiche già registrate restano.
- **Priorità a Twitch**: se il canale va in diretta mentre è attiva una sessione manuale, la sessione manuale viene chiusa (motivo `twitch_live`, registrato nel log e nel registro delle modifiche), parte la sessione Twitch e la dashboard mostra un avviso. Nessun dato viene perso. Non si può avviare una sessione manuale mentre il canale è LIVE o in pausa, né durante una DEMO.
- Se l'app si riavvia con una sessione manuale aperta, la sessione viene chiusa come interrotta (`restart`) con i dati registrati fino a quel momento.
- **Prova di OBS senza andare in diretta**: avvia la sessione manuale, apri la sorgente `/overlay` in OBS e premi *Genera incontro ora*: l'overlay mostra spawn, lanci e catture reali.
- **Storico dirette**: ogni sessione ha un tipo (`TWITCH`, `MANUAL`, `DEMO`) con inizio, fine, conteggi ed errori; il filtro permette di vedere solo un tipo. Le statistiche reali comprendono Twitch e manuale; la DEMO resta esclusa.

## Modifica manuale del Pokédex

Sezione **Modifica Pokédex** (solo amministratore).

- Ricerca dello spettatore e dei Pokémon per nome o numero; filtri: catturati, visti, mancanti, shiny, corretti, aggiunti dall'admin, MANUAL, TWITCH.
- Per ogni esemplare si possono correggere forma (stessa specie), shiny, Poké Ball, data di cattura e note; si può registrare un esemplare mancante (rifiutato se esiste già, salvo *esemplare aggiuntivo* esplicito) o rimuoverlo con conferma.
- Prima di salvare viene mostrata la **tabella delle differenze** (prima → dopo); *Annulla* scarta le modifiche.
- **Origine sempre visibile**: TWITCH, MANUAL, ADMIN, IMPORT, DEMO. Una correzione non cambia l'origine (un esemplare catturato in diretta resta TWITCH, marcato ✎ *corretto*); gli esemplari registrati a mano sono ADMIN. Lo storico dei tentativi e delle sessioni non viene mai modificato: le correzioni toccano solo la collezione.
- **Sicurezza dei dati**: ogni modifica è in una transazione, i valori sono validati, e un numero di revisione impedisce di sovrascrivere modifiche fatte nel frattempo da un'altra scheda o da una cattura (errore 409, ricarica e riprova). Ogni operazione finisce nel **registro delle modifiche** (chi, quando, cosa, valori prima e dopo).

## Classifiche, Hall of Fame e Stream Recap

Sezione **Classifiche** della dashboard. *Funzionalità della versione in sviluppo, non pubblicata.*

### Da dove arrivano i dati

- Ogni **cattura riuscita** del motore di gioco in una sessione **TWITCH** o **MANUAL** scrive un *evento di classifica* (tabella `leaderboard_events`). L'evento nasce nella stessa transazione della cattura. Le classifiche si calcolano solo da questi eventi, non dal contenuto del Pokédex.
- **Esclusi sempre**:
  - sessioni DEMO;
  - esemplari registrati o corretti a mano nel Pokédex;
  - importazioni JSON;
  - tentativi falliti o rifiutati.
- **Catture annullate**: se un riscatto viene revocato su Twitch e l'opzione *Revoca la cattura se annullata* è attiva, la cattura esce dalle classifiche live. L'evento resta nel database, marcato come annullato.
- **Nessun doppio conteggio**: ogni evento è legato al tentativo di cattura da un vincolo univoco. Un riscatto ripetuto da Twitch o un evento duplicato non assegnano punti due volte.
- **Una classifica per sessione**: le catture di una sessione manuale contano solo lì, quelle di una diretta solo nella diretta. La Hall of Fame le somma, con filtro Twitch / Manuale / Tutte.

### Le due classifiche e i punteggi

- **Classifica catture**: numero di Pokémon catturati nella sessione. Ogni cattura vale 1, qualunque sia la rarità.
- **Classifica punti**: `punti base + bonus rarità + bonus shiny`. Valori iniziali:

| Evento | Punti |
|---|---:|
| Cattura (punti base) | 10 |
| Comune | +0 |
| Non comune | +5 |
| Raro | +15 |
| Molto raro (rarità *Epico*) | +30 |
| Leggendario | +50 |
| Mitico | +50 |
| Shiny | +50 |

- **Rarità**: conta quella del Pokémon al momento dell'incontro, salvata nello spawn. Un Pokémon senza rarità riconosciuta riceve solo i punti base.
- **Modifica dei valori**: in **Classifiche → Punteggi e comandi**. Ogni modifica crea una **nuova versione delle regole**, che vale per le catture successive.
- **Punti già assegnati**: ogni evento conserva punti base, bonus, rarità e versione delle regole usate. Non viene mai ricalcolato: un trigger del database impedisce di modificarlo.
- **Parità**:
  - nella classifica catture decide il punteggio;
  - nella classifica punti decide il numero di catture;
  - poi passa avanti chi ci è arrivato prima.

### Giocatori

- **Spettatori Twitch**: sono identificati dal **Twitch User ID**; il nickname è solo il nome visualizzato.
  - Chi cambia nickname resta lo stesso giocatore, con le stesse statistiche; il nome precedente finisce nello **storico dei nomi**.
  - Un altro account con lo stesso nome è un giocatore diverso.
- **Giocatori locali** (sessioni manuali): hanno un ID locale stabile (`local:<nome>`), separato dagli account Twitch. Nessun Twitch ID viene inventato e i due profili non vengono mai uniti automaticamente.
- **Sezione Giocatori**:
  - ricerca, anche per nickname precedente o Twitch User ID;
  - profilo con statistiche Twitch, manuali e totali, sessioni, ultime catture con il dettaglio dei punti, storico dei nomi;
  - **nome visualizzato** modificabile: lasciando il campo vuoto torna il nickname Twitch.
- **Rinomina**: viene registrata nel registro delle operazioni. Non modifica catture, eventi o risultati già congelati.

### Controlli della dashboard

Si sceglie la sessione da mostrare: quella corrente o una precedente, con filtro Twitch/Manuale e filtro per giocatore.

Per ogni giocatore la tabella mostra:
- posizione, catture e punti;
- shiny e specie diverse;
- Pokémon più raro.

Per la sessione mostra:
- sessione di origine;
- stato della classifica: LIVE, CONGELATA o FINALE;
- partecipanti, data e ora.

| Pulsante | Funzione |
|---|---|
| Classifica punti / catture | Sceglie quale classifica mostrare (dashboard e overlay) |
| Mostra classifica | Top 10 nell'overlay |
| Podio | Primi tre con il loro Pokémon simbolo (il più raro catturato) |
| Mostra vincitore | Schermata del vincitore con animazione |
| Riepilogo sessione | Statistiche finali nell'overlay |
| Nascondi classifica | Toglie la schermata dall'overlay |
| Congela risultati / Sblocca risultati | Vedi sotto |
| Aggiorna | Ricalcola e reinvia all'overlay (i risultati congelati non cambiano) |
| Anteprima overlay | Mostra la schermata in un'anteprima privata, senza pubblicarla in OBS |

**La schermata resta visibile finché non premi Nascondi** (o scrivi `!leaderboard hide`). Non sparisce:
- dopo un certo tempo;
- a fine diretta;
- al riavvio dell'app (lo stato è salvato nel database).

**La sessione mostrata è sempre indicata in modo esplicito**:
- "Sessione corrente" senza una sessione in corso viene rifiutata, mai sostituita da una sessione precedente;
- l'inizio di una nuova diretta non sostituisce di nascosto una classifica finale già in onda.

### Congelamento dei risultati

- **Congela risultati** salva un'**istantanea definitiva**: ordine, catture, punti, nomi in quel momento, checksum SHA-256.
- **Dopo il congelamento**:
  - la classifica della sessione non si aggiorna più automaticamente, anche dopo la fine della sessione;
  - le catture successive vengono comunque registrate, e la dashboard indica quante sono;
  - il riepilogo usa i risultati congelati.
- **Nessuna sovrascrittura**: finché l'istantanea è attiva, congelare di nuovo viene rifiutato. Prima bisogna sbloccarla.
- **Sblocca risultati** richiede conferma e **motivazione**. Il registro delle operazioni salva chi, quando, perché e cosa è cambiato rispetto all'istantanea.
- **Storico delle istantanee**: quella sbloccata resta salvata; un nuovo congelamento ne crea una nuova versione. Il database impedisce di modificarle o cancellarle.

### Comando `!leaderboard`

| Comando | Chi | Azione |
|---|---|---|
| `!leaderboard` | Broadcaster e moderatori autorizzati | Mostra la classifica della diretta |
| `!leaderboard hide` | Broadcaster e moderatori autorizzati | Nasconde la classifica |
| `!leaderboard freeze` | Solo broadcaster | Congela i risultati |
| `!leaderboard winner` | Broadcaster e moderatori autorizzati | Mostra il vincitore |

- **Verifica del ruolo**: il server usa i dati dell'evento Twitch (ID di chi scrive e badge del canale), **mai il nickname**.
- **Impostazioni** in **Punteggi e comandi**:
  - escludere i moderatori;
  - limitarli a un elenco di Twitch User ID;
  - disattivare le risposte in chat (brevi, una riga).
- **Chi non è autorizzato** viene ignorato senza risposta e registrato nel log. Il rifiuto non consuma il cooldown del comando.
- **Registro**: ogni azione eseguita finisce nel registro delle operazioni come `twitch:<login>`, via chat.
- **Cooldown, alias e attivazione** si configurano in **Comandi chat**.
- **Solo durante una diretta Twitch**: nelle sessioni manuali si usa la dashboard. La prova del comando dalla dashboard non esegue azioni.

### Overlay OBS

- **Nessuna nuova sorgente**: le schermate appaiono nella stessa sorgente `/overlay`, sopra il gioco, con i colori e il carattere del tema attivo.
- **Aggiornamento** via WebSocket, senza ricaricare la Browser Source.
- **Etichette**: **DIRETTA TWITCH** o **SESSIONE MANUALE**, e **LIVE**, **RISULTATI CONGELATI** o **CLASSIFICA FINALE**.
- **Schermate**:
  - classifica Top 10 (catture o punti);
  - podio;
  - vincitore;
  - riepilogo della sessione;
  - Hall of Fame.

### Hall of Fame

Classifica permanente, separata da quelle delle singole sessioni.

- **Contenuto**:
  - top giocatori per punti e per catture;
  - catture totali e shiny;
  - sessioni partecipate;
  - Pokémon più rari.
- **Filtro**: Twitch / Manuale / Tutte.
- **Nell'overlay**: con *Mostra Hall of Fame*.
- **Solo catture competitive**: niente DEMO, registrazioni manuali o importazioni.

### Stream Recap

Alla chiusura di ogni sessione Twitch o manuale viene salvato un riepilogo con:
- durata e partecipanti;
- Pokémon incontrati e catturati, percentuale di cattura, shiny;
- Pokémon più rari e più catturato;
- vincitori delle due classifiche e Top 10.

È consultabile in **Classifiche → Riepiloghi** anche con Twitch scollegato. I riepiloghi delle sessioni manuali sono marcati MANUALE.

Per una sessione ancora in corso, o chiusa prima di questa versione, viene mostrato un riepilogo provvisorio, non salvato. *Rigenera* lo ricalcola su richiesta e l'operazione finisce nel registro operazioni.

### Differenze tra sessioni Twitch e manuali

| | Diretta Twitch | Sessione manuale |
|---|---|---|
| Classifica della sessione | Sì | Sì (separata) |
| Giocatori | Spettatori (Twitch User ID) | Giocatori locali o spettatori già registrati |
| Comando `!leaderboard` | Sì | No: si usa la dashboard |
| Riepilogo | Sì | Sì, marcato MANUALE |
| Hall of Fame | Filtro *Twitch* | Filtro *Manuale* |

### Aggiornamento del database e predisposizioni

- **Migrazione 5**: aggiunge tabelle e colonne senza modificare i dati esistenti. Le catture registrate prima dell'aggiornamento (dirette e sessioni manuali, mai DEMO) entrano nelle classifiche con le regole iniziali e sono marcate *storiche*.
- **Backup**: le nuove tabelle sono incluse in tutti i backup, locali e di rete, e tornano allo stato del backup con il ripristino.
- **Predisposizioni per le fasi successive**:
  - il servizio classifiche emette un evento a ogni cattura valida: è il punto di aggancio per **achievement** e **obiettivi comunitari**;
  - le regole di punteggio sono versionate, così si potranno introdurre **eventi speciali** temporanei con ritorno automatico alle regole normali.
- **Non ancora implementati**: achievement, obiettivi ed eventi speciali.

## Effetti sonori per OBS

Sezione **Audio OBS** della dashboard. *Funzionalità della versione in sviluppo, non pubblicata.*

- **Spawn**: a ogni nuovo Pokémon suona un effetto scelto a caso dalla lista (mai lo stesso due volte di fila, se la lista ha almeno due file), oppure sempre lo stesso file.
- **Cattura confermata**: quando il motore registra una cattura riuscita suona la musica di conferma, una sola volta.
- **Una sola sorgente in OBS**: i suoni li riproduce l'overlay `/overlay`, la stessa Browser Source che mostra la grafica. Non serve aggiungere altre sorgenti, URL o pagine.
- **Solo dentro OBS**: l'overlay suona solo quando gira nella Browser Source di OBS. Aperto in un browser normale o nell'anteprima della dashboard resta muto; la dashboard non riproduce mai audio, nemmeno con il pulsante *Prova*.

### I file audio

I file **non** fanno parte dell'app né dell'immagine Docker: li aggiungi tu nella cartella dati.

| Installazione | Cartella |
|---|---|
| Umbrel (App Store) | `~/umbrel/app-data/piu-live-catch/data/audio/` |
| Docker Compose (metodo B) | `./data/audio/` |
| Nel container | `/data/audio/` |

Per esempio, da un Mac verso Umbrel:

```bash
scp -r "Cartella dei miei suoni" umbrel@umbrel.local:umbrel/app-data/piu-live-catch/data/audio/
```

- **Formati**: MP3, OGG (`.ogg`, `.oga`) e WAV. Sottocartelle ammesse fino a 3 livelli; al massimo 500 file da 50 MB l'uno.
- **Sicurezza**:
  - l'app serve solo i file trovati in quella cartella, identificati da un codice e non dal percorso, quindi non è possibile chiedere altri file del server;
  - collegamenti simbolici e file nascosti vengono ignorati;
  - non esiste un caricamento dalla dashboard;
  - i file non vengono mai modificati, rinominati o cancellati.
- **Persistenza**: la cartella sta nel volume dei dati, quindi resta dopo riavvii e aggiornamenti. I backup dell'app contengono il database (e quindi le impostazioni audio), **non** i file audio: conservane una copia a parte.
- I file aggiunti compaiono nella dashboard senza riavviare (*Aggiorna*).

### Riconoscimento automatico e scelta manuale

Finché non scegli tu, l'app riconosce i file dal nome:
- **Musica di cattura**: il primo file il cui nome contiene *Caught a Pokémon*, *cattura* o *capture*.
- **Suoni di spawn**: i jingle brevi il cui nome contiene *Obtained a Key Item*, *Obtained an Item*, *Level Up*, *Pokémon Healed*, *Evolved*, *Pokédex Evaluation*, *spawn* o *appear*.

In **Audio OBS → File audio disponibili** spunti i file da usare per lo spawn e premi *Salva lista spawn*; nelle *Impostazioni* scegli la musica di cattura. *Torna alla selezione automatica* ripristina il riconoscimento per nome.

| Impostazione | Default | Note |
|---|---|---|
| Audio attivo | Sì | Interruttore generale |
| Suono allo spawn | Sì | |
| Musica alla cattura | Sì | |
| Suoni anche in DEMO | No | Senza questa opzione la modalità DEMO resta silenziosa |
| Volume | 70 | 0–100, si somma al volume della sorgente nel mixer di OBS |
| Durata massima | 10 s | Oltre questa durata il suono sfuma (0 = brano intero): utile se scegli un brano lungo |
| Suono di spawn | Casuale | Casuale dalla lista, oppure sempre lo stesso file |

Le impostazioni sono salvate nel database e restano dopo riavvio, aggiornamento e ripristino di un backup. Ogni modifica finisce nel registro operazioni.

### Configurare OBS

Basta la sorgente **Browser** dell'overlay che già usi, `http://IP-UMBREL:8788/overlay` (vedi [Collegamento OBS](#collegamento-obs)). Nelle sue proprietà:

1. Attiva **Controlla l'audio tramite OBS**: la sorgente compare nel mixer e puoi regolarne volume e monitoraggio.
2. Lascia **disattivato** *Chiudi la sorgente quando non è visibile*: altrimenti, quando la scena non è in onda, la pagina viene chiusa e i suoni di quel periodo vanno persi. *Aggiorna il browser quando la scena diventa attiva* può restare attivo: dopo il ricaricamento la pagina non riproduce suoni arretrati.

Nessuna seconda sorgente: grafica e suoni arrivano dalla stessa pagina, ciascuno sul proprio canale WebSocket (`/ws/overlay` per la grafica, `/ws/audio` per i suoni). I cambi di tema, la rotazione delle classifiche e gli altri aggiornamenti grafici non interrompono un suono in corso e non lo fanno ripartire. La pagina si riconnette da sola: non serve ricaricarla.

**Dove suona**:

| Overlay aperto… | Audio |
|---|---|
| nella Browser Source di OBS (riconosciuta automaticamente) | sì |
| in un browser normale, per esempio con *Apri overlay* | no (per provarlo: `…/overlay?audio=1`) |
| nell'anteprima della dashboard (Overlay Designer, classifiche) | mai |
| in OBS con `…/overlay?audio=0` | no (audio disattivato solo per quella sorgente) |

Solo le pagine che suonano si collegano al canale audio, quindi il contatore della dashboard indica esattamente gli overlay OBS in ascolto.

**Autoplay**: di norma la Browser Source di OBS riproduce l'audio senza bisogno di un clic (non ancora verificato su OBS reale con questa versione). Se nella diagnostica compare *bloccato*:
- in OBS: clic destro sulla sorgente → **Interagisci** → clic su **🔊 Sblocca audio** (visibile con `?debug=1`);
- in un browser: apri `…/overlay?audio=1&debug=1` e premi **🔊 Sblocca audio**.

### Prova

1. **Audio OBS** deve indicare *1 overlay OBS con audio collegato*.
2. Premi **▶ Prova suono spawn** e **▶ Prova musica cattura**, oppure **▶ Prova in OBS** accanto a un file: il suono parte in OBS (non nella dashboard). Senza sorgenti collegate la dashboard lo segnala.
3. Per vedere cosa succede imposta temporaneamente l'URL della sorgente a `http://IP-UMBREL:8788/overlay?debug=1`: sopra la grafica compare un riquadro con stato della connessione audio, impostazioni, ultimi suoni con l'esito (*riprodotto*, *duplicato*, *troppo vecchio*, *bloccato*, *errore*) e il pulsante *Sblocca audio*. Poi torna a `…/overlay`.
4. Prova reale: una sessione manuale, *Genera Pokémon* e un lancio riuscito.

### Quando suona e quando no

- **Spawn**: un evento per ogni nuovo Pokémon, identificato dallo spawn. Non suona quando lo stesso Pokémon viene solo ridisegnato, quando l'overlay viene aggiornato, cambia schermata o si riconnette, durante la DEMO (salvo opzione), per importazioni o modifiche del Pokédex.
- **Cattura**: un evento per ogni cattura riuscita, identificato dal tentativo, solo dopo che il motore l'ha registrata. Non suona per lanci falliti, tentativi rifiutati (nessun Pokémon in campo, limiti, ball disattivata), riscatti Twitch duplicati o catture già annullate.
- **Sessioni**: funziona allo stesso modo nelle dirette Twitch e nelle sessioni manuali.
- **Nessun doppione**: ogni evento ha un identificativo univoco; il server lo invia una sola volta e l'overlay lo riproduce una sola volta, anche se arriva di nuovo.
- **Nessun evento vecchio**: alla connessione l'overlay riceve solo impostazioni e ora del server, mai eventi passati. Un evento arrivato con più di 10 secondi di ritardo (secondo l'orologio del server) viene scartato.
- **OBS spento o sorgente chiusa**: il gioco continua normalmente; i suoni di quel periodo vanno persi e non vengono recuperati alla riconnessione.
- **Errori**: un file mancante, un formato non supportato o la riproduzione bloccata vengono mostrati nella diagnostica; un errore audio non blocca mai spawn, catture, Twitch o la modalità manuale.

**Cattura annullata dopo il suono**: se un riscatto viene rimborsato *dopo* la cattura, la musica è già partita e non può essere ritirata; la cattura esce comunque da Pokédex e classifiche come sempre.

## Backup

- **Automatico**: ogni giorno all'ora scelta (default 04:00), conservando gli ultimi N (default 14).
- **Manuale**: *Backup & Sistema → Crea backup ora*.
- File: `/data/backups/livecatch-AAAAMMGG-HHMMSS-tipo.sqlite.gz` (copia consistente del database, compressa). Scaricabili dalla dashboard.
- **Esportazione JSON** di spettatori, collezioni e impostazioni dei Pokémon (leggibile e importabile).
- **Backup di rete** (*Backup & Sistema → Backup di rete*), vedi sotto.
- Per una copia completa del volume (immagini e chiave di cifratura comprese): `sh scripts/backup-volume.sh <cartella-dati> <destinazione>`. Su Umbrel (metodo A) la cartella dell'app è inclusa anche nei backup di Umbrel.

### Backup di rete

I backup automatici possono essere scritti in una **cartella di rete** (NAS via NFS/SMB) o su un disco esterno. L'app non monta condivisioni da sola, non usa comandi di shell e non chiede credenziali di rete: la cartella deve essere **montata nel container** in `/backups-network` (variabile `BACKUP_TARGET_ROOT`).

- **Umbrel (metodo A, umbrelOS 2.x)**: aggiungi la condivisione in *File → Rete*, poi nelle impostazioni dell'app Live Catch scegli la *Cartella dei backup* (chiave `folderAccess` del manifest). Su umbrelOS 1.x questa scelta non esiste: la sezione mostra "cartella non montata" e i backup di rete restano disattivati.
- **Docker / metodo B**: monta la condivisione sull'host e togli il commento al volume `- /mnt/nas/livecatch:/backups-network` in `docker-compose.yml`. La cartella deve essere scrivibile dall'utente 1000.

Nella dashboard:
1. **Verifica connessione**: controlla che la cartella esista, sia leggibile e scrivibile (crea e cancella un file temporaneo `.livecatch-write-test-…`), e mostra lo spazio libero. Non tocca altri file.
2. **Impostazioni**: sottocartella (default `livecatch`, mai fuori dalla cartella montata), backup automatici sì/no, frequenza (ogni ora, ogni 6 o 12 ore, giornaliera, settimanale), ora, numero di backup da conservare, backup prima di ogni aggiornamento.
3. **Stato**: ultimo tentativo, ultimo backup riuscito, ultimo errore, prossimo ritentativo.

Come funziona:
- Copia consistente dell'intero database con `VACUUM INTO` (funziona con il gioco in corso), compressa e accompagnata da un **manifest** `.manifest.json` con versione dell'app, schema, data, contenuto e checksum SHA-256.
- Scrittura atomica: file temporaneo, verifica, rinomina; il manifest viene scritto per ultimo, quindi un backup senza manifest valido non viene mai considerato completo.
- **Nessun segreto in chiaro**: sessioni di accesso escluse; credenziali Twitch solo cifrate; la chiave di cifratura `secret.key` **non** è inclusa (va conservata a parte, vedi `scripts/backup-volume.sh`). Le immagini caricate e i file audio (`/data/audio`) non sono inclusi.
- I backup automatici vengono saltati se il database non è cambiato dall'ultimo backup.
- **Errori di rete**: ogni operazione ha un tempo massimo (`BACKUP_TIMEOUT_MS`, default 30 s), quindi una condivisione irraggiungibile non blocca il gioco; i ritentativi avvengono dopo 5, 10, 20… minuti fino a un massimo di 6 ore.
- **Rotazione**: elimina solo i file `livecatch-*.sqlite.gz` creati dall'app (con il loro manifest), mai file sconosciuti, e non elimina mai l'ultimo backup valido.

## Ripristino

1. *Backup & Sistema → Backup*: scegli il file e premi **Ripristina** (oppure prima **Carica** un file `.sqlite.gz` scaricato in precedenza).
2. L'app verifica integrità, appartenenza e versione dello schema del file, crea automaticamente un backup *pre-restore* dello stato attuale, sostituisce il database e riparte.
3. Il ripristino è bloccato durante una diretta.
4. Un backup creato da una versione più recente dell'app viene rifiutato prima di qualsiasi modifica (anche al caricamento del file).

**Ripristino da un backup di rete** (*Backup di rete → Ripristina*), procedura guidata:
1. verifica di checksum, integrità SQLite, schema e versione: un file corrotto o creato da una versione più recente viene rifiutato con un messaggio chiaro e nulla viene modificato;
2. riepilogo del contenuto (spettatori, catture, sessioni, data, versione);
3. conferma esplicita scrivendo `RIPRISTINA`;
4. backup di sicurezza `pre-restore` dello stato attuale, arresto del motore di gioco (una sessione manuale viene chiusa con motivo `restore`), chiusura del database con checkpoint del WAL, sostituzione e verifica di integrità;
5. se qualcosa va storto il database precedente viene rimesso al suo posto automaticamente.

Il ripristino conserva la sessione di accesso corrente e le impostazioni dei backup di rete; è bloccato durante una diretta ed è registrato nel registro delle modifiche.

Se ripristini su un'installazione nuova (Umbrel reinstallato, disco cambiato, altro server), le credenziali Twitch del backup sono cifrate con la vecchia `secret.key`, che per sicurezza non è nei backup:
- il ripristino riesce e i dati di gioco tornano tutti;
- Twitch risulta **scollegato**, con l'avviso *credenziali non leggibili con la chiave di questa installazione* in Panoramica e nella pagina Twitch;
- dashboard e modalità manuale funzionano normalmente;
- per le dirette, in *Gestione Twitch* reinserisci il Client Secret e collega di nuovo gli account (2 minuti). Le vecchie credenziali cifrate restano nel database finché il nuovo collegamento non riesce; poi vengono sostituite.

In alternativa, prima di avviare l'app ricopia la vecchia `secret.key` nella cartella dati: le credenziali tornano leggibili senza ricollegare nulla.

### Precauzioni per non perdere i dati

- Tieni attivi sia i backup locali (`/data/backups`) sia quelli di rete: proteggono da guasti diversi.
- Conserva a parte una copia di `secret.key` (`scripts/backup-volume.sh`): senza quella, dopo un ripristino su un'altra installazione, gli account Twitch vanno ricollegati.
- Prima di un aggiornamento crea un backup manuale e scaricalo; l'app crea comunque il backup `pre-migration` e, con l'opzione attiva, il backup di rete `pre-update`.
- Non copiare a mano il file del database con l'app in esecuzione (WAL): usa i backup della dashboard.
- Dopo aver configurato la cartella di rete, premi **Verifica** su un backup almeno una volta: controlla checksum e integrità senza modificare nulla.

## Aggiornamento

- **Metodo A**: quando viene pubblicata una nuova versione (nuovo tag immagine + `version` aggiornata in `piu-live-catch/umbrel-app.yml`), Umbrel mostra l'aggiornamento nell'App Store. I dati in `app-data` restano intatti.
- **Metodo B**: `cd ~/livecatch && sh scripts/install-umbrel-ssh.sh` (esegue `git pull` e ricompila).

Il database viene migrato automaticamente all'avvio con migrazioni incrementali (`src/database/migrations.js`): non viene mai cancellato. **Prima di applicare una migrazione l'app crea da sola un backup `pre-migration`** in `/data/backups`, ripristinabile dalla dashboard.

Versioni dello schema del database:

| Versione dell'app | Schema |
|---|---|
| 1.0.0-rc.1, 1.0.0-rc.2 | v2 |
| 1.0.0-rc.3 (Overlay Themes) | v3: tabella `overlay_themes` |
| versione in sviluppo (modalità manuale, backup di rete, modifica Pokédex) — **non pubblicata** | v4: tipo di sessione, origine degli esemplari, tabella `admin_audit` |
| versione in sviluppo (classifiche, Hall of Fame, Stream Recap) — **non pubblicata** | v5: eventi e istantanee delle classifiche, regole di punteggio versionate, riepiloghi, storico dei nomi |

Un'app non apre mai un database (o un backup) con uno schema più recente di quello che conosce: l'avvio o il ripristino vengono rifiutati con un messaggio chiaro e **senza modificare nulla**. Fanno eccezione le versioni fino alla 1.0.0-rc.2, che non hanno questo controllo (vedi sotto).

### Tornare a una versione precedente (rollback)

**Dallo schema v5 alla 1.0.0-rc.3.** Stessa procedura del caso v4 qui sotto: la migrazione 5 aggiunge solo tabelle, colonne e viste, ma la rc.3 rifiuta un database v5 come uno v4. *Non ancora provato su un Umbrel reale.*

**Dallo schema v4 alla 1.0.0-rc.3.** La migrazione 4 aggiunge solo colonne e una tabella, ma la rc.3 rifiuta di avviarsi su un database v4 (controllo dello schema). Per tornare alla rc.3 bisogna rimettere il backup `…-pre-migration.sqlite.gz` creato all'aggiornamento: a app ferma, decomprimilo in `data/db/livecatch.sqlite` (dopo aver spostato altrove il database attuale e i file `-wal`/`-shm`), poi avvia la rc.3. Le modifiche fatte dopo l'aggiornamento restano nel database spostato. *Procedura non ancora provata su un Umbrel reale.*

Esempio: dalla 1.0.0-rc.3 (schema v3) alla 1.0.0-rc.2 (schema v2). Prima di tutto crea un backup manuale (*Backup & Sistema → Crea backup ora*) e scaricalo.

Ci sono due modi. Il primo è consigliato.

**1. Rollback semplice: solo la versione dell'app, nessuna perdita di dati.**
La rc.2 si avvia anche sul database v3 e non lo modifica nella struttura:
- spettatori, catture, sessioni, statistiche, ricompense e impostazioni restano tutti, anche quelli registrati dopo l'aggiornamento;
- l'overlay torna all'aspetto che aveva **prima** dell'aggiornamento: la rc.2 non conosce i temi del Designer e usa le vecchie impostazioni dell'overlay;
- i temi restano salvati nel database: tornando alla rc.3, Designer e tema attivo ricompaiono come li avevi lasciati.

**2. Rollback esatto: lo stato di prima dell'aggiornamento.**
Dopo essere tornato alla rc.2 (come sopra), in *Backup & Sistema → Backup* ripristina il file `livecatch-…-pre-migration.sqlite.gz` creato al momento dell'aggiornamento. Il database torna allo schema v2 e a com'era quel giorno: **le catture e le modifiche fatte dopo l'aggiornamento non ci sono più nel database attivo**. Non vanno perse: il ripristino crea prima il backup `pre-restore` dello stato attuale, che puoi ripristinare a sua volta per tornare indietro.

Come cambiare versione:
- **Metodo B (SSH)**:
  ```bash
  cd ~/livecatch && git fetch --tags && git checkout v1.0.0-rc.2 && sudo docker compose up -d --build
  ```
  Per tornare all'ultima versione: `git checkout main && sh scripts/install-umbrel-ssh.sh`.
- **Metodo A (App Store)**: l'App Store di Umbrel installa solo la versione pubblicata nello store. Per tornare alla rc.2 bisogna ripubblicare nello store il manifest e l'immagine della rc.2 (`scripts/publish-store.sh` con il digest della rc.2) e aggiornare l'app da Umbrel. *Questa procedura non è ancora stata provata su un Umbrel reale.*

Verifica eseguita in locale (non su Umbrel): con il codice rc.2 e quello della rc.3 sulla stessa cartella dati, entrambi i modi conservano tutti i dati come descritto sopra.

## Risoluzione problemi

| Problema | Soluzione |
|---|---|
| Stato **ERROR – not_configured** | Completa i passi 1 e 2 della sezione Twitch. |
| Stato **ERROR – auth_error** | Il token del canale è stato revocato o non si rinnova: *Twitch → Account del canale → Ricollega*. Finché non lo fai, metti in pausa a mano le ricompense indicate nell'avviso. Al ricollegamento l'app le mette in pausa e rimborsa i riscatti in coda. |
| Avviso "Token del bot non più valido" | Il gioco continua e risponde l'account del canale. *Twitch → Account bot → Ricollega*. |
| Avviso "Problema temporaneo di Twitch … il gioco continua" | Twitch non ha risposto (rete, timeout, HTTP 429 o 5xx). **Non** è una revoca: il gioco resta attivo, nessuna ricompensa viene messa in pausa e l'app riprova da sola; l'avviso sparisce alla prima risposta corretta. Se resta per molti minuti controlla la connessione Internet del server. |
| Stato **PAUSED** | Connessione a Twitch persa: il gioco è sospeso in sicurezza e riprende da solo appena la diretta viene confermata. Controlla la connessione Internet del server. |
| Vado in live ma il gioco non parte | *Twitch → Testa connessione*. Verifica che sia collegato l'account del canale che trasmette. Il controllo periodico (60 s) rileva la diretta anche se l'evento è andato perso. |
| La sottoscrizione `redemption` risulta *failed* | Il canale non è Affiliate/Partner o manca lo scope: ricollega l'account. |
| I punti non vengono rimborsati | Il rimborso funziona solo per ricompense **create dall'app** (vedi [Limiti delle ricompense collegate a mano](#limiti-delle-ricompense-collegate-a-mano)). Per quelle dell'app controlla *Twitch → 5 · Riscatti e recupero*. |
| La dashboard mostra "Indirizzo della dashboard" (HTTP 421) | È attivo l'hostname dedicato: usa il link mostrato. |
| Vengo disconnesso spesso | La sessione è legata all'IP: se il tuo dispositivo cambia spesso indirizzo, disattiva *Sessione valida solo dall'indirizzo IP del login* in *Impostazioni → Sicurezza*. |
| Ricompensa con "⚠" nella colonna *Su Twitch* | La pausa/riattivazione non è riuscita: viene ritentata da sola; puoi forzarla con **Sincronizza pausa ricompense**. |
| Il container non parte: "la cartella dati … non è scrivibile" | Il volume deve appartenere a 1000:1000: `sudo chown -R 1000:1000 <cartella-dati>`. |
| Il bot non risponde | I comandi funzionano solo in LIVE; controlla cooldown/anti-spam; se usi un bot separato, assicurati che non sia bannato nel canale. |
| Nessun Pokémon appare | Importa i Pokémon; verifica che ci siano Pokémon abilitati e che *Spawn automatici attivi* sia acceso. |
| Overlay vuoto in OBS | Usa l'IP del server; prova la Modalità DEMO; verifica che l'URL sia `/overlay`. |
| Dopo l'aggiornamento l'overlay in OBS si comporta come prima | Proprietà della sorgente Browser → **Aggiorna la cache della pagina corrente**. |
| Il simulatore non invia all'overlay pubblico | È consentito solo a gioco fermo: in LIVE, PAUSED o DEMO, e in ERROR o CONNECTING quando Twitch segnala il canale in diretta, le simulazioni restano nell'anteprima privata. |
| Ripristino rifiutato: "Il backup usa lo schema vN, creato da una versione più recente" | Il backup viene da una versione più nuova dell'app: aggiorna Live Catch prima di ripristinarlo. Il database attuale non è stato toccato. |
| Il container non parte: "Il database usa lo schema vN … più recente" | Stai eseguendo una versione dell'app più vecchia del database (ritorno indietro senza ripristino). Reinstalla la versione più recente oppure segui [Tornare a una versione precedente](#tornare-a-una-versione-precedente-rollback). Il database non viene modificato. |
| Overlay irraggiungibile, nel log "Connessione overlay rifiutata: limite raggiunto" | Troppe sorgenti/pagine overlay aperte (o un client che apre connessioni senza fine). Chiudi le anteprime inutilizzate oppure alza `WS_OVERLAY_MAX_PER_IP` / `WS_OVERLAY_MAX_CONNECTIONS`. |
| Ho perso la password admin | Crea un file vuoto chiamato `reset-admin-password` nella cartella dati (Umbrel: `~/umbrel/app-data/piu-live-catch/data/`, metodo B: `~/livecatch/data/`) e riavvia l'app. La nuova password temporanea sarà nel file `initial-admin-password.txt` nella stessa cartella. I dati di gioco non vengono toccati. |
| Nessun suono in OBS | *Audio OBS* deve indicare un overlay OBS collegato (la normale sorgente `…/overlay`, senza `?audio=0`). Imposta temporaneamente `…/overlay?debug=1`: se un suono risulta *bloccato*, premi *Sblocca audio* (in OBS: Interagisci); se risulta *errore*, controlla formato e file. Verifica anche il volume della sorgente nel mixer di OBS. Vedi [Effetti sonori per OBS](#effetti-sonori-per-obs). |
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

Requisiti: Node.js ≥ 22.13. I test (`test/`) coprono:

- **Gioco**: spawn, catture riuscite e fallite, catture simultanee, comandi chat, Pokédex.
- **Ciclo di vita**: sessioni LIVE, arresto del motore offline, ripartenza automatica LIVE, disconnessione Twitch (PAUSED e ripresa).
- **Robustezza**: eventi duplicati e replay, riavvio server, persistenza, backup/ripristino, aggiornamento da un database v1 con backup `pre-migration`.
- **Sicurezza** (`test/security.test.js`):
  - proxy fidati e `X-Forwarded-For` falsificati;
  - limite di login per IP e per account;
  - Origin e Host del WebSocket admin;
  - richieste da altre origini;
  - sessioni legate a browser e IP, scadenza per inattività;
  - hostname dedicato e recupero accesso.
- **Channel Points** (`test/rewards.test.js`):
  - pausa e riattivazione delle ricompense, con errori ritentati;
  - recupero dei riscatti in sospeso dopo la riconnessione EventSub, senza duplicati;
  - eventi tardivi, ritentativi, ricompense non elaborabili;
  - limiti delle ricompense collegate.
- **Errori temporanei di Twitch** (`test/twitch-resilience.test.js`):
  - 429 con `Retry-After`, 5xx, timeout e rete assente durante una diretta: nessuna revoca, nessuna pausa, nessun rimborso;
  - token davvero revocato (rinnovo rifiutato con 400): procedura di revoca;
  - recupero automatico e rinnovo del token deduplicato.
- **Robustezza aggiuntiva** (`test/hardening.test.js`): cookie malformati (HTTP e WebSocket), backup e database con schema più recente, limiti di classifica e connessioni overlay, statistiche dopo un riscatto annullato, revisione dei temi, backup automatico e fuso orario, validazione dell'importazione JSON.
- **Effetti sonori** (`test/audio.test.js`): scelta casuale dalla lista, nessuna ripetizione consecutiva, un evento per spawn e uno per cattura confermata, niente suoni per lanci falliti, rifiutati, duplicati o annullati, DEMO esclusa, interruttori, deduplicazione ed eventi vecchi scartati nell'overlay, una sola Browser Source `/overlay` per grafica e suoni (anche durante cambi di schermata e riconnessioni), audio solo in OBS e mai nell'anteprima della dashboard o in un browser normale, autoplay bloccato e pulsante *Sblocca audio*, dirette Twitch e sessioni manuali, OBS scollegato ed errori audio senza effetti sul gioco, persistenza delle impostazioni, whitelist dei file (niente percorsi arbitrari o collegamenti simbolici), nessun audio nella dashboard.
- **Ripristino con un'altra `secret.key`** (`test/credentials-key.test.js`): backup di rete e locale ripristinati su un'installazione nuova (HTTP 200), Panoramica, Twitch e Sistema funzionanti, modalità manuale, avviso Twitch scollegato, credenziali cifrate originali intatte fino al nuovo collegamento, ricollegamento e reinserimento del Client Secret.
- **Classifiche** (`test/leaderboard.test.js`): classifiche catture e punti, bonus rarità e shiny, punteggi immutabili e regole versionate, identità Twitch (User ID, cambio nickname) e locale, separazione Twitch/MANUAL, esclusione DEMO e modifiche del Pokédex, nessun doppio conteggio, catture annullate, `!leaderboard` autorizzato e rifiutato, attivazione da dashboard e da comando, nascondi, persistenza dopo il riavvio, congelamento, sblocco, istantanee immutabili, rinomina, aggiornamento WebSocket, overlay (DOM di prova), classifica finale persistente, Hall of Fame, Stream Recap, backup e ripristino, migrazione dallo schema v4.
- **Overlay Themes** (`test/overlay-themes.test.js`, `test/overlay-stability.test.js`):
  - preset, validazione, importazione ed esportazione, persistenza e migrazione;
  - simulatore isolato e bloccato sull'overlay pubblico in LIVE, PAUSED e DEMO;
  - pulizia degli elementi simulati all'avvio della diretta;
  - coda delle animazioni con oltre 100 eventi e cambio tema immediato;
  - modifiche contemporanee dello stesso tema.
  - Il vero `overlay.js` gira in un DOM minimo (`test/dom-shim.js`). Il rendering grafico reale va comunque provato in un browser e in OBS.

Twitch viene simulato con un server EventSub WebSocket locale e un finto Helix: **solo nei test**.

**Test del container** (`scripts/container-smoke.sh`): eseguito dalla CI su ogni push, per `linux/amd64` e `linux/arm64`.

- Avvia l'immagine come su Umbrel (UID 1000, volume `/data`, password da variabile).
- Attende lo stato `healthy` e verifica `/health`, pagine, API protette, login, cambio password, CSRF/Origin e backup.
- Controlla proprietà dei file, persistenza dopo `docker restart`, arresto pulito, assenza delle password nei log e messaggio chiaro con volume non scrivibile.

Se hai Docker puoi eseguirlo anche in locale:

```bash
docker build -t livecatch:smoke . && scripts/container-smoke.sh livecatch:smoke
```

La CI esegue anche il **linter ufficiale di Umbrel** (`getumbrel/umbrel-apps`, commit fissato) sul pacchetto `piu-live-catch/`.

## Pubblicazione di una nuova versione

1. Aggiorna `version` in `package.json` e in `piu-live-catch/umbrel-app.yml`, il tag immagine in `piu-live-catch/docker-compose.yml` e `releaseNotes`.
2. Commit, poi tag `vX.Y.Z` e push: la CI esegue test, test del container (amd64 + arm64) e linter Umbrel, poi pubblica l'immagine multi-arch su GHCR. Il digest compare nel riepilogo della GitHub Action.
   Subito dopo il push la CI verifica **senza credenziali**, come Umbrel, che l'immagine sia davvero scaricabile (`scripts/check-ghcr-anonymous.mjs`): token anonimo, manifest del tag appena pubblicato, digest uguale a quello della build, presenza e download di `linux/amd64` e `linux/arm64`. Se uno di questi controlli fallisce (401, 403, 404, digest diverso o malformato, architettura mancante, errore di rete o timeout) **il job fallisce**: non usare un digest preso da una run rossa. Lo stesso controllo si può eseguire a mano:

   ```bash
   node scripts/check-ghcr-anonymous.mjs --repository michaelpiu/pokemon-twitch-catch --tag X.Y.Z --expect-digest sha256:<digest>
   ```
3. Prepara lo store pubblico con il digest e pubblicalo:

```bash
scripts/publish-store.sh ../piu-umbrel-app-store sha256:<digest>
```

4. Nel repository dello store, commit e push. La sua GitHub Action esegue il linter ufficiale con `--check-images`: controlla che l'immagine sia fissata per digest, **scaricabile senza autenticazione** e pubblicata per amd64 e arm64, e che l'icona sia raggiungibile.

## Cosa devi autorizzare tu

Alcuni passaggi richiedono i tuoi account o una tua decisione e non sono stati eseguiti dallo sviluppatore:

1. **Immagine Docker scaricabile senza credenziali** (fatto): Umbrel scarica l'immagine GHCR `pokemon-twitch-catch` senza autenticazione, quindi il pacchetto deve essere **pubblico** (GitHub → *Packages* → `pokemon-twitch-catch` → *Package settings* → *Change visibility*).
   - Il **repository GitHub** di sviluppo è pubblico.
   - Il **pacchetto GHCR** è pubblico: il 10 novembre 2026 token anonimo, manifest della rc.3 e immagini amd64/arm64 hanno risposto HTTP 200 senza credenziali, e l'Action dello store è stata superata.
   - Resta da provare l'installazione vera su Umbrel (punto 5).
2. **Twitch**: creare l'applicazione su dev.twitch.tv e autorizzare l'account del canale (e l'eventuale bot) con il codice di attivazione.
3. **Affiliate/Partner**: necessario per i punti canale.
4. **Hostname dedicato** (consigliato): record DNS locale o file `hosts`, vedi [Sicurezza dell'accesso](#sicurezza-dellaccesso).
5. **Collaudo reale**: installazione sul tuo Umbrel, diretta di prova (anche non pubblicizzata) e prova dell'overlay in OBS. Finché non li fai, Twitch reale, Umbrel reale e OBS restano **non verificati**: vedi [docs/UMBREL.md](docs/UMBREL.md).
