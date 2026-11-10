# Live Catch su Umbrel OS — installazione, pubblicazione e verifiche

## Stato delle verifiche (1.0.0-rc.3, preparata in locale, non ancora pubblicata)

| Verifica | Stato | Dove |
|---|---|---|
| Test automatici (logica, API, sicurezza, migrazioni, backup, Channel Points ed errori temporanei con Twitch simulato) | Verificata **in locale**: 180/180 su Node 24.22.2 e su Node 26.13.0 (156 dell'app + 24 del controllo anonimo GHCR). Nella CI di GitHub **non ancora eseguita** per la rc.3 | `npm test`, job CI *Test automatici* |
| Rollback rc.3 → rc.2 e ritorno, backup tra versioni di Node | Verificata **in locale** con script (nessun dato perso), non su Umbrel | README → *Tornare a una versione precedente* |
| Dashboard e Overlay Designer nel browser | Verificata con test automatizzati nel Chromium del browser integrato (non OBS) | — |
| Avvio reale del container amd64 e arm64: healthcheck, UID 1000, volume, persistenza dopo il riavvio, arresto pulito, password assenti dai log, volume non scrivibile | **Non ancora verificata per la rc.3**. Ultima verifica: CI del tag `v1.0.0-rc.2` (run 42641098115, runner Ubuntu; arm64 in emulazione QEMU) | job CI *Avvio reale del container*, `scripts/container-smoke.sh` |
| Linter ufficiale di Umbrel sul pacchetto | **Non ancora eseguito per la rc.3**. Ultima verifica (CI del tag `v1.0.0-rc.2`): nessun errore; nel repository di sviluppo l'unico avviso è l'immagine senza digest, che è invece fissato nello store | job CI *Linter ufficiale Umbrel* |
| Immagine multi-arch pubblicata | **rc.3 da generare**: `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.0-rc.3` non è ancora stata costruita né pubblicata (il tag su GHCR risponde 404); il digest sarà scritto da `scripts/publish-store.sh` dopo la CI del rilascio. Ultima pubblicazione: `1.0.0-rc.2@sha256:346ee3bcc5025ce7a40508fbe3ceb0805af541c803fc3dfc501e05a22525f9aa` (CI del tag `v1.0.0-rc.2`) | job CI *Pubblicazione* |
| 1. Disponibilità pubblica dell'immagine | **Verificata il 10 novembre 2026** con richieste anonime (nessuna credenziale): pacchetto GHCR **pubblico**, token anonimo di pull HTTP 200, pagina pubblica del pacchetto HTTP 200. Il repository GitHub di sviluppo è anch'esso pubblico, ma la visibilità del pacchetto è un'impostazione separata | `scripts/check-ghcr-anonymous.mjs` |
| 2. Manifest e digest della rc.2 | **Verificati il 10 novembre 2026**, senza credenziali: indice multi-arch `1.0.0-rc.2` HTTP 200 con digest `sha256:346ee3bc…f9aa`, identico al log della CI e al manifest dello store; immagini `linux/amd64` e `linux/arm64` HTTP 200, configurazioni con l'architettura corretta, primo KB di un layer per ciascuna HTTP 206. **Non** è un `docker pull` completo: Docker non era disponibile nell'ambiente di verifica | `scripts/check-ghcr-anonymous.mjs` |
| 3. Verifica automatica dello store | **Superata il 10 novembre 2026**: Action dello store rilanciata a mano sul contenuto rc.2 (run 42773183607), linter ufficiale con `--check-images` senza errori, icona HTTP 200. Le run del 9 novembre per rc.1 e rc.2 erano fallite con HTTP 401, quando il pacchetto era ancora privato | Action dello store |
| Repository dello store: clone anonimo, manifest e icona raggiungibili | Verificata il 10 novembre 2026 per il contenuto pubblicato con la rc.2 (commit dello store `4097c8b`): `umbrel-app.yml` e `docker-compose.yml` letti senza credenziali, icona HTTP 200. Il contenuto della rc.3 **non è ancora pubblicato** nello store | <https://github.com/MichaelPiu/piu-umbrel-app-store> |
| Controllo anonimo bloccante nella CI | Nuovo: dopo il push il job *Pubblicazione* fallisce se il pull anonimo, il manifest del tag, il digest o una delle due architetture non sono verificabili. Provato in locale (test automatici con un registry simulato e richieste reali a GHCR), **non ancora eseguito in GitHub Actions** | job CI *Pubblicazione*, `test/ghcr-anonymous-check.test.js` |
| 4. Installazione reale su Umbrel (rc.3) | **Non verificata**: la rc.3 non è pubblicata e non è mai stata installata su Umbrel. Nessuna versione risulta installata con successo da questo store su un vero Umbrel | — |
| Aggiornamento rc.2 → rc.3 su un vero Umbrel (migrazione allo schema v3, backup `pre-migration`, temi) | **Non verificato** (serve il tuo server); provato solo in locale, vedi sopra | — |
| 5. Twitch reale (OAuth, EventSub, chat, ricompense, rimborsi) | **Non verificata** (serve il tuo consenso e il tuo canale) | — |
| 5. Overlay dentro OBS | **Non verificata** | — |

Le righe numerate tengono separati cinque livelli che non vanno confusi: (1) l'immagine è pubblica, (2) manifest e digest sono corretti, (3) lo store supera la verifica automatica, (4) l'app si installa davvero su un Umbrel, (5) funziona con Twitch e OBS reali. Oggi sono verificati solo i primi tre, e solo per la rc.2.

## Come funziona il proxy di Umbrel (verificato sul codice sorgente)

Fonte: `getumbrel/umbrel`, `packages/umbreld/source/modules/app-gateway/app-gateway.ts` e `lan-ingress/lan-ingress.ts` (umbrelOS 2.x, novembre 2026).

- Su umbrelOS 2.x il container `app_proxy` non esiste più: la sezione `app_proxy` del `docker-compose.yml` viene letta da **umbreld**, che apre la porta dell'app (8788) sull'host e inoltra al container `piu-live-catch_web_1:8080`.
- Richieste HTTP:
  - `X-Forwarded-For` viene **sostituito** con l'IP reale del browser; vengono impostati anche `X-Forwarded-Proto` e `X-Forwarded-Host`;
  - `Host` non viene riscritto (`changeOrigin: false`);
  - i cookie di Umbrel vengono rimossi prima dell'inoltro.
- WebSocket: inoltrati senza riscrivere gli header `X-Forwarded-*`. Per questo l'app non li usa per il WebSocket.
- Il gateway gira sull'host, quindi il container lo vede arrivare dal **gateway della rete Docker**. Da qui `TRUSTED_PROXIES: docker-gateway`.
- `PROXY_AUTH_ADD: "false"`: Umbrel non chiede il proprio login, quindi l'overlay è raggiungibile da OBS. L'app protegge `/admin` e tutte le API admin da sola.
- Su umbrelOS 1.x esiste ancora il sidecar `app_proxy`: per questo `TRUSTED_PROXIES` contiene anche `piu-live-catch_app_proxy_1`, risolto via DNS. Su 2.x quel nome non esiste e viene ignorato.

Rischio residuo noto: un'app installata con `network_mode: host` sullo stesso Umbrel si collega al container dallo stesso indirizzo del gateway e potrebbe falsificare `X-Forwarded-For`. Al massimo potrebbe usare il limite di login di un altro IP: resta comunque il limite per account (30 errori ogni 15 minuti).

## Installazione (Metodo A, App Store)

Prerequisito: immagine GHCR scaricabile senza autenticazione. **Verificato il 10 novembre 2026** per la versione oggi nello store (rc.2): pacchetto pubblico, manifest e architetture amd64/arm64 scaricabili senza credenziali, Action dello store superata. L'installazione vera e propria su un Umbrel **non è ancora stata provata**.

1. Umbrel → **App Store** → **⋯** → **Community App Stores** → `https://github.com/MichaelPiu/piu-umbrel-app-store` → **Add**.
2. Store **Piu** → **Live Catch** → **Install**.
3. Apri `http://umbrel.local:8788/admin`, accedi con utente `admin` e la password mostrata da Umbrel e scegli la tua password.
4. Consigliato: [hostname dedicato](#hostname-dedicato-passo-per-passo).

Dati: `~/umbrel/app-data/piu-live-catch/data` (database, immagini, backup, log, `secret.key`), inclusi nei backup di Umbrel.

## Hostname dedicato passo per passo

**Perché.** Su Umbrel tutte le app condividono l'indirizzo `umbrel.local` (cambiano solo le porte). I browser non separano i cookie per porta, quindi senza un nome dedicato il cookie della dashboard arriva anche alle altre app. Con un nome dedicato la dashboard vive su un indirizzo tutto suo.

**Cosa cambia e cosa no**
- Cambia solo l'indirizzo della dashboard (`/admin` e `/api/admin/*`).
- Overlay (`/overlay`), WebSocket dell'overlay e pagine pubbliche funzionano su qualunque indirizzo: **OBS non va riconfigurato**.
- La porta resta **8788**: il nome sostituisce solo `umbrel.local` o l'IP.

### 1. IP fisso per Umbrel

Il nome deve puntare sempre allo stesso IP.
1. Trova l'IP del server: dal PC esegui `ping umbrel.local`, oppure via SSH esegui `hostname -I`, oppure guarda l'elenco dei dispositivi del router.
2. Sul router crea una **prenotazione DHCP** (chiamata anche "IP statico" o "DHCP reservation") per quel dispositivo.

Negli esempi l'IP è `192.168.1.50`.

### 2. Scegli il nome

- **Consigliati**:
  - `livecatch.lan`;
  - `livecatch.home.arpa` (il suffisso ufficiale per le reti domestiche, RFC 8375).
- **Da evitare**:
  - nomi in `.local`: sono riservati a mDNS e si confondono con `umbrel.local`; su macOS rallentano la risoluzione;
  - `.dev`, `.app`, `.page` e altri domini pubblici: i browser forzano HTTPS e la pagina non si apre;
  - `localhost`;
  - un nome di dominio reale che non possiedi.
- Il nome può contenere solo lettere, numeri, trattini e punti.

### 3. Fai puntare il nome all'IP

**Opzione A, per tutta la rete di casa (consigliata se hai Pi-hole o AdGuard):**
- **Pi-hole**: *Local DNS → DNS Records*: dominio `livecatch.lan`, IP `192.168.1.50` → **Add**.
- **AdGuard Home**: *Filtri → Riscritture DNS → Aggiungi*: `livecatch.lan` → `192.168.1.50`.
- **Router**: molti router (FRITZ!Box, OpenWrt, UniFi, pfSense…) hanno una voce del tipo "DNS locale", "Host statici" o "DNS host override". Il nome della voce cambia da modello a modello.

Se Pi-hole o AdGuard sono installati **sullo stesso Umbrel**, funziona lo stesso: devono però essere il DNS dei tuoi dispositivi.

**Opzione B, solo sul PC da cui usi la dashboard:**

- **macOS / Linux**, in Terminale:

  ```bash
  sudo sh -c 'echo "192.168.1.50 livecatch.lan" >> /etc/hosts'
  ```

  Solo su macOS, svuota poi la cache DNS:

  ```bash
  sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
  ```

- **Windows**:
  1. Apri il *Blocco note* come amministratore.
  2. Apri `C:\Windows\System32\drivers\etc\hosts`.
  3. Aggiungi in fondo la riga `192.168.1.50 livecatch.lan` e salva.
  4. Da un prompt dei comandi esegui `ipconfig /flushdns`.

- **Telefono o tablet**: il file `hosts` non è modificabile, quindi serve l'opzione A. In alternativa usa la dashboard solo dal PC.

Verifica: `ping livecatch.lan` deve rispondere da `192.168.1.50`.

### 4. Attiva il nome nella dashboard

1. Apri **`http://livecatch.lan:8788/admin`**, **non** `umbrel.local`, e accedi.
2. *Impostazioni → Sicurezza dell'accesso*: in **Hostname dedicati** scrivi `livecatch.lan`. Puoi inserirne più di uno, separati da virgola, per esempio anche l'IP `192.168.1.50`.
3. **Salva**:
   - il salvataggio viene rifiutato se il nome che stai usando non è nell'elenco, così non resti chiuso fuori;
   - le altre sessioni aperte vengono chiuse.
4. Aggiungi `http://livecatch.lan:8788/admin` ai preferiti.

L'icona dell'app nella schermata di Umbrel continua ad aprire `umbrel.local:8788`. Lì vedrai solo la pagina *Indirizzo della dashboard* (HTTP 421) con il link al nuovo indirizzo, senza alcun cookie.

### 5. Verifica

1. `http://umbrel.local:8788/admin` mostra la pagina con il link e **non** chiede il login.
2. `http://umbrel.local:8788/overlay` funziona ancora.
3. In *Impostazioni → Sicurezza*, "Il tuo IP visto dal server" è l'IP del tuo PC, non un `172.x`/`10.x`.
4. Facoltativo: negli strumenti per sviluppatori del browser (*Application/Archiviazione → Cookie*) il cookie della dashboard compare solo per `livecatch.lan`.

Che il gateway di Umbrel inoltri le richieste senza cambiare l'host (necessario perché `livecatch.lan` funzioni) è stato verificato **sul codice sorgente** di umbrelOS (`changeOrigin: false`). Su un Umbrel reale va ancora verificato: è il punto 4 del [collaudo](#collaudo-consigliato-sul-tuo-umbrel).

### Metodo B (SSH)

Puoi impostarlo anche da file. In `~/livecatch/.env`:

```bash
ADMIN_HOSTS=livecatch.lan
```

Poi esegui `docker compose up -d`. Così l'impostazione nella dashboard è bloccata.

### Tornare indietro

- **Se accedi ancora**: svuota il campo *Hostname dedicati* e salva.
- **Se sei rimasto chiuso fuori** (nome non più risolto, IP cambiato):
  1. via SSH esegui `touch ~/umbrel/app-data/piu-live-catch/data/reset-admin-password`;
  2. riavvia l'app da Umbrel.

  Il reset rimuove l'hostname dedicato e crea una nuova password temporanea in `initial-admin-password.txt`, nella stessa cartella. I dati di gioco non vengono toccati.

### Limite residuo

Il nome dedicato punta allo stesso IP di Umbrel, quindi anche le altre app sono raggiungibili su `livecatch.lan:<porta>`. Un'app malevola potrebbe portare il browser su quell'indirizzo per ricevere il cookie. Per questo la sessione resta legata a browser e IP del login: **non disattivare** *Sessione valida solo dall'indirizzo IP del login*. Un isolamento completo richiederebbe HTTPS con un certificato dedicato, non gestito da Umbrel per le app di terze parti.

## Collaudo consigliato sul tuo Umbrel

1. Installazione: l'app si apre, `http://umbrel.local:8788/health` risponde `"status":"ok"`.
2. *Backup e Sistema*: versione installata `1.0.0-rc.3`, **schema DB v3**, crea un backup manuale. Aggiornando da una rc.2 deve esserci anche il backup `…-pre-migration.sqlite.gz`.
3. Riavvia l'app da Umbrel: i dati restano, il login con la tua password funziona.
4. *Impostazioni → Sicurezza*: "Il tuo IP visto dal server" deve essere l'IP del tuo PC, **non** un 10.x/172.x. Se vedi l'indirizzo del gateway, i proxy fidati non sono riconosciuti: segnalalo.
5. DEMO con OBS (overlay da `http://IP-UMBREL:8788/overlay`).
6. Twitch: collegamento, *Testa connessione*, creazione delle 4 ricompense; da offline devono risultare **⏸ in pausa** su Twitch.
7. Diretta di prova (anche non pubblicizzata):
   - le ricompense si riattivano;
   - un riscatto genera il lancio;
   - `!pokedex` risponde;
   - a fine diretta le ricompense tornano in pausa.
8. Overlay Designer con OBS: cambia tema a gioco fermo, la sorgente si aggiorna senza ricaricarla; una simulazione su OBS mostra il badge "SIMULAZIONE"; in diretta il simulatore resta nell'anteprima privata.
9. Rollback (facoltativo, su un'installazione di prova): segui README → *Tornare a una versione precedente*. Con la rc.2 i dati devono restare tutti e l'overlay tornare all'aspetto precedente.

## Tornare a una versione precedente

La procedura completa è nel README (*Aggiornamento → Tornare a una versione precedente*). In breve, per Umbrel:
- i dati sono in `~/umbrel/app-data/piu-live-catch/data/`, i backup in `…/data/backups/` (anche quello `pre-migration` creato all'aggiornamento);
- l'App Store installa solo la versione pubblicata nello store: per tornare alla rc.2 va ripubblicata nello store con il suo digest;
- la rc.2 si avvia sul database v3 senza perdere dati (overlay con l'aspetto precedente all'aggiornamento); per lo stato esatto di prima dell'aggiornamento ripristina il backup `pre-migration`.

Non ancora provato su un Umbrel reale.

## Pubblicazione di una versione

Vedi README → *Pubblicazione di una nuova versione*. In breve: tag `vX.Y.Z` → CI (test, container amd64/arm64, linter Umbrel, push GHCR, controllo anonimo bloccante di manifest, digest e architetture) → `scripts/publish-store.sh <store> sha256:<digest>` → push dello store, la cui Action esegue il linter ufficiale con `--check-images`.
