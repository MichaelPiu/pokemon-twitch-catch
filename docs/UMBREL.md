# Live Catch su Umbrel OS — installazione, pubblicazione e verifiche

## Stato delle verifiche (1.0.0-rc.3, Release Candidate pubblicata il 10 novembre 2026)

| Verifica | Stato | Dove |
|---|---|---|
| Test automatici (logica, API, sicurezza, migrazioni, backup e ripristino, Channel Points ed errori temporanei con Twitch simulato) | **Verificata**: 180/180 in locale su Node 24.22.2 e Node 26.13.0, e nella CI di GitHub (Node 24) per la PR, per `main` e per il tag `v1.0.0-rc.3` | `npm test`, job CI *Test automatici* |
| Rollback rc.3 → rc.2 e ritorno, backup tra versioni di Node | Verificata **in locale** con script (nessun dato perso), non su Umbrel | README → *Tornare a una versione precedente* |
| Dashboard e Overlay Designer nel browser | Verificata con test automatizzati nel Chromium del browser integrato (non OBS) | — |
| Avvio reale del container amd64 e arm64: healthcheck, `/health`, pagine e API admin protette, login e cambio password, CSRF/Origin, backup, UID 1000 e processo non privilegiato, persistenza dopo il riavvio, password assenti dai log, arresto pulito, volume non scrivibile | **Verificata nella CI del tag `v1.0.0-rc.3`** (run 42776475968, runner Ubuntu; arm64 in emulazione QEMU). È un test in container, **non** un'installazione su Umbrel | job CI *Avvio reale del container*, `scripts/container-smoke.sh` |
| Linter ufficiale di Umbrel sul pacchetto | **Verificata per la rc.3**: nessun errore nella CI di sviluppo (unico avviso atteso: l'immagine senza digest, che è fissato nello store) e nessun problema nello store con `--check-images` | job CI *Linter ufficiale Umbrel*, Action dello store |
| 1. Disponibilità pubblica dell'immagine | **Verificata il 10 novembre 2026** senza credenziali: pacchetto GHCR **pubblico** (impostazione separata dal repository, anch'esso pubblico), token anonimo di pull HTTP 200 | `scripts/check-ghcr-anonymous.mjs` |
| 2. Manifest e digest della rc.3 | **Verificati**: `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.0-rc.3@sha256:5b1fb376086df52b883cac684ae939c0451f1a92695c8599a8c1cc79b5dbb114`, indice multi-arch HTTP 200 con `linux/amd64` e `linux/arm64`. Lo stesso digest compare nel log della CI, nel controllo anonimo bloccante del job (superato) e nel manifest dello store. Da un Mac, senza credenziali, sono stati scaricati per intero tutti gli 11 layer di ciascuna architettura con sha256 verificati (equivale ai dati di un `docker pull`, senza l'estrazione in Docker) | job CI *Pubblicazione*, `scripts/check-ghcr-anonymous.mjs` |
| 3. Verifica automatica dello store | **Superata** per la rc.3: Action dello store (run 42776917007) con linter ufficiale e `--check-images` senza problemi, icona HTTP 200; lo stesso linter, eseguito anche in locale prima della pubblicazione, non ha trovato problemi | Action dello store |
| Repository dello store | **Pubblicato** con la rc.3 (commit dello store `f317726`): clone anonimo riuscito, `umbrel-app.yml` (versione `1.0.0-rc.3`) e `docker-compose.yml` (immagine fissata per tag e digest) leggibili senza credenziali | <https://github.com/MichaelPiu/piu-umbrel-app-store> |
| Controllo anonimo bloccante nella CI | **Eseguito e superato** in GitHub Actions sul tag `main` (run 42776071957) e sul tag `1.0.0-rc.3` (run 42776475968) | job CI *Pubblicazione*, `test/ghcr-anonymous-check.test.js` |
| 4. Installazione reale su Umbrel (rc.3) | **Non verificata**: nessuna versione è mai stata installata su un vero Umbrel da questo store. Serve il tuo dispositivo, vedi [Collaudo](#collaudo-consigliato-sul-tuo-umbrel) | — |
| Aggiornamento rc.2 → rc.3 su un vero Umbrel (migrazione allo schema v3, backup `pre-migration`, temi) | **Non verificato** (serve il tuo server); provato solo in locale, vedi sopra | — |
| 5. Twitch reale (OAuth, EventSub, chat, ricompense, rimborsi) | **Non verificata** (serve il tuo consenso e il tuo canale) | — |
| 5. Overlay dentro OBS | **Non verificata** | — |

Le righe numerate tengono separati cinque livelli che non vanno confusi: (1) l'immagine è pubblica, (2) manifest e digest sono corretti, (3) lo store supera la verifica automatica, (4) l'app si installa davvero su un Umbrel, (5) funziona con Twitch e OBS reali. Per la rc.3 sono verificati i primi tre; il quarto e il quinto richiedono il tuo Umbrel e il tuo canale.

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

Prerequisito: immagine GHCR scaricabile senza autenticazione. **Verificato il 10 novembre 2026** per la versione oggi nello store (1.0.0-rc.3): pacchetto pubblico, manifest e architetture amd64/arm64 scaricabili senza credenziali, Action dello store superata. L'installazione vera e propria su un Umbrel **non è ancora stata provata**.

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
