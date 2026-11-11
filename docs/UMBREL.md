# Live Catch su Umbrel OS — installazione, pubblicazione e verifiche

## Stato delle verifiche (1.0.0, pubblicata il 10 novembre 2026)

| Verifica | Stato | Dove |
|---|---|---|
| Test automatici (logica, API, sicurezza, migrazioni, backup e ripristino, Channel Points, classifiche, audio, Twitch simulato) | **Verificata**: 266/266 in locale su Node 24.22.2 e Node 26.13.0, e nella CI di GitHub (Node 24) per `main` e per il tag `v1.0.0` (run 42875437029) | `npm test`, job CI *Test automatici* |
| Aggiornamento rc.3 → 1.0.0 (schema v3 → v5) | Verificato **in locale** con un database creato dal codice della rc.3 (catture via Twitch simulato, credenziali cifrate, impostazioni personalizzate): backup `pre-migration` identico all'originale, nessun dato, cattura o impostazione persi, credenziali leggibili, pagine HTTP 200, su Node 24 e 26. Non su Umbrel | — |
| Backup e ripristino con `secret.key` diversa | Verificato **in locale**: backup locale e di rete della 1.0.0 ripristinati su un'installazione nuova, HTTP 200, Twitch scollegato con avviso, credenziali cifrate intatte, catture e impostazioni conservate, modalità manuale funzionante | `test/credentials-key.test.js` |
| Dashboard, Overlay Designer e audio dell'overlay nel browser | Verificata nel Chromium del browser integrato (non OBS) | — |
| Avvio reale del container amd64 e arm64 (healthcheck, `/health`, API protette, login, CSRF/Origin, backup, UID 1000, persistenza, arresto pulito) | **Verificata nella CI del tag `v1.0.0`** (run 42875437029; arm64 in emulazione QEMU). È un test in container, **non** un'installazione su Umbrel | job CI *Avvio reale del container* |
| Linter ufficiale di Umbrel | **Nessun errore** in locale e nella CI (unico avviso atteso: immagine senza digest nel pacchetto di sviluppo); nessun problema nello store con `--check-images` | job CI, Action dello store |
| 1. Disponibilità pubblica dell'immagine | **Verificata il 10 novembre 2026** senza credenziali: token anonimo di pull HTTP 200 | `scripts/check-ghcr-anonymous.mjs` |
| 2. Manifest e digest della 1.0.0 | **Verificati**: `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.0@sha256:6f03f10cf2bcea6558d2baa7ea0d24068cc865eb8c8c1684e3a61d5c72808055`; `linux/amd64` `sha256:56d3bb00843781200e5f551cab2cf804a4d6ed0f3821ee4294be11c6217ae9ac`, `linux/arm64` `sha256:487eb91ff40b9eae743e158488aa98c9951857ae69fa6c34a8a3522289361c32`. Stesso digest nel log della CI, nel controllo anonimo bloccante e nello store. Da un Mac, senza credenziali, scaricati tutti gli 11 layer di ciascuna architettura con sha256 verificati; elencati i file: solo `/app/package.json`, `src`, `public`, `scripts` e le dipendenze, `/data` vuota, nessun file audio, zip, database, chiave o test | job CI *Pubblicazione* |
| 3. Verifica automatica dello store | **Superata**: Action dello store (run 42876442200), linter ufficiale con `--check-images`, icona HTTP 200 | Action dello store |
| Repository dello store | **Pubblicato** con la 1.0.0 (commit dello store `004e5ff`): clone anonimo riuscito, versione `1.0.0`, immagine fissata per tag e digest | <https://github.com/MichaelPiu/piu-umbrel-app-store> |
| 4. Installazione e aggiornamento su un vero Umbrel | **Non verificati**: servono il tuo dispositivo e la procedura [Aggiornare l'app esistente alla 1.0.0](#aggiornare-lapp-esistente-alla-100-dati-conservati) | — |
| 5. Twitch reale (OAuth, EventSub, chat, ricompense, rimborsi, `!leaderboard`) | **Non verificata** | — |
| 5. Overlay e audio dentro OBS | **Non verificati** | — |

Le righe numerate tengono separati cinque livelli: (1) l'immagine è pubblica, (2) manifest e digest sono corretti, (3) lo store supera la verifica automatica, (4) l'app si installa e si aggiorna davvero su un Umbrel, (5) funziona con Twitch e OBS reali. Per la 1.0.0 sono verificati i primi tre.

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

Prerequisito: immagine GHCR scaricabile senza autenticazione. **Verificato il 10 novembre 2026** per la versione oggi nello store (1.0.0): pacchetto pubblico, manifest e architetture amd64/arm64 scaricabili senza credenziali, Action dello store superata. L'installazione vera e propria su un Umbrel **non è ancora stata provata**.

1. Umbrel → **App Store** → **⋯** → **Community App Stores** → `https://github.com/MichaelPiu/piu-umbrel-app-store` → **Add**.
2. Store **Piu** → **Live Catch** → **Install**.
3. Apri `http://umbrel.local:8788/admin`, accedi con utente `admin` e la password mostrata da Umbrel e scegli la tua password.
4. Consigliato: [hostname dedicato](#hostname-dedicato-passo-per-passo).

Dati: `~/umbrel/app-data/piu-live-catch/data` (database, immagini, backup, log, `secret.key`), inclusi nei backup di Umbrel.

## Aggiornare dalla 1.0.0 alla 1.0.1 (versione di test)

La 1.0.1 aggiunge solo i messaggi automatici in chat. **Nessuna migrazione**: lo schema resta v5, il formato dei backup non cambia e i messaggi restano spenti finché non li attivi.

> ⚠️ **Non disinstallare** l'app per aggiornarla: su Umbrel la disinstallazione cancella anche `app-data`.

1. Dalla dashboard: *Backup & Sistema → Crea backup ora* e scarica il file sul PC (consigliato).
2. Se c'è una diretta in corso, aspetta che finisca (l'aggiornamento riavvia l'app).
3. Umbrel → **App Store** → store **Piu** → **Live Catch**: compare **Update** con la versione `1.0.1`. Se non compare, attendi qualche minuto (Umbrel rilegge gli store della community periodicamente) e riapri l'App Store. Premi **Update**.
4. Verifica: `http://umbrel.local:8788/health` → `"status":"ok"`; *Backup & Sistema* → versione **1.0.1**, **schema DB v5**; Pokédex, classifiche, audio, backup e Twitch come prima; nel menu compare **Messaggi Twitch**.
5. Collaudo dei messaggi: [Messaggi Twitch](#messaggi-twitch-dalla-101-versione-di-test).

Ritorno alla 1.0.0: stesso schema, quindi nessun ripristino necessario; la 1.0.0 ignora le impostazioni dei messaggi (restano salvate). Vedi [Tornare a una versione precedente](#tornare-a-una-versione-precedente).

## Aggiornare l'app esistente alla 1.0.0 (dati conservati)

Vale per chi ha già installato Live Catch dallo store (rc.1, rc.2 o rc.3). I dati restano in `~/umbrel/app-data/piu-live-catch/data` e **non** vengono toccati dall'aggiornamento: l'app nuova li riapre e migra il database allo schema v5.

> ⚠️ **Non disinstallare** l'app per aggiornarla: su Umbrel la disinstallazione cancella anche `app-data`, quindi database, `secret.key` e backup locali.

1. **Prima dell'aggiornamento**, dalla dashboard: *Backup & Sistema → Crea backup ora*, poi scarica il file sul PC. Se vuoi una copia completa (anche immagini, log e `secret.key`), via SSH:
   ```bash
   sudo tar -czf ~/livecatch-prima-della-1.0.0.tar.gz -C ~/umbrel/app-data/piu-live-catch data
   ```
2. Se c'è una diretta in corso, aspetta che finisca (l'aggiornamento riavvia l'app).
3. Umbrel → **App Store** → store **Piu** → **Live Catch**: compare **Update** con la versione `1.0.0` (Umbrel rilegge gli store della community periodicamente; se non compare ancora, attendi qualche minuto e riapri l'App Store). Premi **Update**.
4. Al primo avvio la 1.0.0 crea il backup `…-pre-migration.sqlite.gz` e migra il database. Verifica:
   - `http://umbrel.local:8788/health` → `"status":"ok"`;
   - *Backup & Sistema*: versione **1.0.0**, **schema DB v5**, backup `pre-migration` nell'elenco;
   - Pokédex, giocatori, statistiche e impostazioni come prima; le catture esistenti compaiono in *Classifiche → Hall of Fame* come *storiche*;
   - Twitch resta collegato (stessa `secret.key`): *Twitch → Testa connessione*.
5. **OBS**: la sorgente resta `http://IP-UMBREL:8788/overlay`. Nelle proprietà della sorgente premi **Aggiorna la cache della pagina corrente** (carica il codice nuovo) e attiva **Controlla l'audio tramite OBS**. Non aggiungere altre sorgenti.
6. **Audio** (facoltativo): copia i tuoi file in `~/umbrel/app-data/piu-live-catch/data/audio/` (vedi [Audio OBS](#audio-obs-dalla-100)), poi *Audio OBS → Aggiorna* e *Prova suono spawn*.
7. **Cartella di rete** (facoltativo, umbrelOS 2.x): impostazioni dell'app in Umbrel → *Cartella dei backup*, poi *Backup & Sistema → Backup di rete → Verifica connessione*.

Se qualcosa non va: *Backup & Sistema → Backup* → ripristina il file `pre-migration` (torna ai dati di prima dell'aggiornamento) e segnala il problema; per tornare alla rc.3 vedi [Tornare a una versione precedente](#tornare-a-una-versione-precedente).

## Cartella di rete per i backup (dalla 1.0.0)

Il manifest `piu-live-catch/umbrel-app.yml` dichiara una cartella scelta dall'utente (`folderAccess`, id `backup-folder`) montata in scrittura nel servizio `web` in `/backups-network` (`BACKUP_TARGET_ROOT`).

1. umbrelOS 2.x → **File** → **Rete**: aggiungi la condivisione del NAS (SMB) oppure collega un disco esterno.
2. Impostazioni dell'app Live Catch → *Cartella dei backup* → scegli la cartella.
3. Dashboard → *Backup & Sistema → Backup di rete* → **Verifica connessione**, poi attiva i backup automatici.

Limiti:
- la chiave `folderAccess` è supportata da umbrelOS 2.x (usata da altre app dello store ufficiale); il linter fissato nella CI la ignora senza errori. **Il comportamento reale su un Umbrel non è stato verificato**;
- su umbrelOS 1.x la chiave non esiste: la sezione indica "cartella non montata" e i backup locali in `/data/backups` continuano a funzionare;
- l'app non monta condivisioni e non conosce le credenziali di rete: se la condivisione cade, i backup falliscono con un errore chiaro e vengono ritentati, senza bloccare il gioco.

Per il metodo B (SSH/Docker) monta la condivisione sull'host e usa il volume commentato in `docker-compose.yml` (`- /mnt/nas/livecatch:/backups-network`).

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
2. *Backup e Sistema*: versione installata `1.0.0`, **schema DB v5**, crea un backup manuale. Aggiornando da una versione precedente deve esserci anche il backup `…-pre-migration.sqlite.gz`.
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

### Classifiche (dalla 1.0.0)


1. Aggiornando da rc.3 deve esserci il backup `…-pre-migration.sqlite.gz`. Le catture già esistenti compaiono in *Classifiche → Hall of Fame*.
2. Sessione manuale con OBS: lancia qualche Poké Ball, poi *Classifiche → Mostra classifica*, *Podio*, *Mostra vincitore*: la sorgente `/overlay` si aggiorna senza ricaricarla e mostra **SESSIONE MANUALE**.
3. Ferma la sessione: la schermata resta in OBS (CLASSIFICA FINALE) finché non premi *Nascondi*; il riepilogo compare in *Riepiloghi*.
4. Riavvia l'app da Umbrel con una classifica visibile: deve ricomparire da sola nell'overlay.
5. Diretta di prova: `!leaderboard` da moderatore e da broadcaster, `!leaderboard freeze` solo da broadcaster; da uno spettatore normale nessun effetto.
6. *Congela risultati*, poi un'altra cattura: la classifica non cambia; *Sblocca* chiede la motivazione.
7. Crea un backup di rete e ripristinalo: classifiche e risultati congelati tornano come nel backup.

### Audio OBS (dalla 1.0.0)

1. Copia i tuoi file audio (MP3, OGG o WAV) in `~/umbrel/app-data/piu-live-catch/data/audio/`, per esempio dal Mac:
   ```bash
   scp -r "Cartella dei miei suoni" umbrel@umbrel.local:umbrel/app-data/piu-live-catch/data/audio/
   ```
   Se la cartella non è scrivibile dall'utente `umbrel`, usa `sudo` sul server e poi `sudo chown -R 1000:1000 ~/umbrel/app-data/piu-live-catch/data/audio`.
2. *Audio OBS*: i file compaiono nell'elenco; controlla la musica di cattura e la lista dei suoni di spawn.
3. OBS: **nessuna nuova sorgente**. Nella sorgente Browser dell'overlay già esistente (`http://IP-UMBREL:8788/overlay`) attiva *Controlla l'audio tramite OBS*. La dashboard deve indicare *1 overlay OBS con audio collegato*.
4. *Prova suono spawn* e *Prova musica cattura*: devono suonare in OBS e non nel browser della dashboard.
5. Sessione manuale: *Genera Pokémon* → un suono; lancio riuscito → la musica di cattura; lancio fallito → niente.
6. Chiudi OBS, genera qualche spawn, riapri OBS: nessun suono arretrato.
7. Durante un suono cambia schermata dell'overlay (classifica, tema): il suono continua e non riparte. Apri `…/overlay` in un browser e l'anteprima nell'Overlay Designer: nessun suono.
8. Riavvia l'app: le impostazioni audio restano.
9. Diretta di prova: un riscatto riuscito suona una volta sola.

I file audio restano nella cartella dati dopo gli aggiornamenti, ma non sono nei backup dell'app: tienine una copia a parte.

### Messaggi Twitch (dalla 1.0.1, versione di test)

Nessuna migrazione del database e nessuna nuova autorizzazione Twitch: si usa il bot già collegato. Dopo l'aggiornamento i messaggi restano **spenti**.

1. *Gestione Twitch*: il bot deve risultare collegato. *Messaggi Twitch*: il riquadro in alto deve dire *Pronto: i messaggi partono con l'account del bot*.
2. Scegli un messaggio e premi **Prova in chat**: deve comparire una volta nella chat del canale, scritto dal bot.
3. Attiva *Messaggi automatici attivi* e salva. Sessione manuale: *Genera Pokémon* → un messaggio di spawn; lancio riuscito → un messaggio di cattura (circa 2 secondi dopo); lancio fallito → niente.
4. Diretta di prova: un riscatto riuscito produce un solo messaggio di cattura con il nome Twitch di chi ha riscattato; un riscatto rimborsato subito non viene annunciato.
5. Scollega la rete o ferma Twitch (EventSub non collegato): il riquadro passa a *non partono*, il gioco continua e al ritorno non arrivano messaggi arretrati.
6. Riavvia l'app: le impostazioni restano.

## Tornare a una versione precedente

La procedura completa è nel README (*Aggiornamento → Tornare a una versione precedente*). In breve, per Umbrel:
- i dati sono in `~/umbrel/app-data/piu-live-catch/data/`, i backup in `…/data/backups/` (anche quello `pre-migration` creato all'aggiornamento);
- l'App Store installa solo la versione pubblicata nello store: per tornare alla rc.2 va ripubblicata nello store con il suo digest;
- la rc.2 si avvia sul database v3 senza perdere dati (overlay con l'aspetto precedente all'aggiornamento); per lo stato esatto di prima dell'aggiornamento ripristina il backup `pre-migration`.

Non ancora provato su un Umbrel reale.

## Pubblicazione di una versione

Vedi README → *Pubblicazione di una nuova versione*. In breve: tag `vX.Y.Z` → CI (test, container amd64/arm64, linter Umbrel, push GHCR, controllo anonimo bloccante di manifest, digest e architetture) → `scripts/publish-store.sh <store> sha256:<digest>` → push dello store, la cui Action esegue il linter ufficiale con `--check-images`.
