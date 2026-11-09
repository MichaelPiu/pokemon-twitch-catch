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
14. [Backup](#backup) · [Ripristino](#ripristino) · [Aggiornamento](#aggiornamento)
15. [Risoluzione problemi](#risoluzione-problemi)
16. [Sviluppo e test](#sviluppo-e-test)
17. [Pubblicazione di una nuova versione](#pubblicazione-di-una-nuova-versione)
18. [Cosa devi autorizzare tu](#cosa-devi-autorizzare-tu)

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
| Volume persistente | `/data` → database (`db/`), immagini (`images/`), backup (`backups/`), log (`logs/`), chiave di cifratura (`secret.key`) |
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

Il database viene migrato automaticamente all'avvio con migrazioni incrementali (`src/database/migrations.js`): non viene mai cancellato. **Prima di applicare una migrazione l'app crea da sola un backup `pre-migration`** in `/data/backups`, ripristinabile dalla dashboard.

## Risoluzione problemi

| Problema | Soluzione |
|---|---|
| Stato **ERROR – not_configured** | Completa i passi 1 e 2 della sezione Twitch. |
| Stato **ERROR – auth_error** | Il token del canale è stato revocato o non si rinnova: *Twitch → Account del canale → Ricollega*. Finché non lo fai, metti in pausa a mano le ricompense indicate nell'avviso. Al ricollegamento l'app le mette in pausa e rimborsa i riscatti in coda. |
| Avviso "Token del bot non più valido" | Il gioco continua e risponde l'account del canale. *Twitch → Account bot → Ricollega*. |
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
3. Prepara lo store pubblico con il digest e pubblicalo:

```bash
scripts/publish-store.sh ../piu-umbrel-app-store sha256:<digest>
```

4. Nel repository dello store, commit e push. La sua GitHub Action esegue il linter ufficiale con `--check-images`: controlla che l'immagine sia fissata per digest, **scaricabile senza autenticazione** e pubblicata per amd64 e arm64, e che l'icona sia raggiungibile.

## Cosa devi autorizzare tu

Alcuni passaggi richiedono i tuoi account o una tua decisione e non sono stati eseguiti dallo sviluppatore:

1. **Immagine Docker pubblica**: il pacchetto GHCR `pokemon-twitch-catch` deve restare **pubblico** perché Umbrel lo scarica senza credenziali (GitHub → *Packages* → `pokemon-twitch-catch` → *Package settings* → *Change visibility*). Codice e immagine sono pubblici per scelta del proprietario.
2. **Twitch**: creare l'applicazione su dev.twitch.tv e autorizzare l'account del canale (e l'eventuale bot) con il codice di attivazione.
3. **Affiliate/Partner**: necessario per i punti canale.
4. **Hostname dedicato** (consigliato): record DNS locale o file `hosts`, vedi [Sicurezza dell'accesso](#sicurezza-dellaccesso).
5. **Collaudo reale**: installazione sul tuo Umbrel, diretta di prova (anche non pubblicizzata) e prova dell'overlay in OBS. Finché non li fai, Twitch reale, Umbrel reale e OBS restano **non verificati**: vedi [docs/UMBREL.md](docs/UMBREL.md).
