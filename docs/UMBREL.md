# Live Catch su Umbrel OS — installazione, pubblicazione e verifiche

## Stato delle verifiche (1.0.0-rc.1)

| Verifica | Stato | Dove |
|---|---|---|
| Test automatici (logica, API, sicurezza, Channel Points con Twitch simulato) | Verificata: 83/83 in locale e nella CI (Node 24) | `npm test`, job CI *Test automatici* |
| Avvio reale del container amd64 e arm64: healthcheck, UID 1000, volume, persistenza dopo il riavvio, arresto pulito, password assenti dai log, volume non scrivibile | Verificata nella CI di GitHub, run del tag `v1.0.0-rc.1` (runner Ubuntu; arm64 in emulazione QEMU) | job CI *Avvio reale del container*, `scripts/container-smoke.sh` |
| Linter ufficiale di Umbrel sul pacchetto | Verificato: nessun errore. Nel repository di sviluppo l'unico avviso è l'immagine senza digest, che è invece fissato nello store | job CI *Linter ufficiale Umbrel* |
| Immagine multi-arch pubblicata | Verificata: `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.0-rc.1@sha256:9daaabff4e05c50f04268153c28046965db31ce04b39034e0851be2aa49637f1` | job CI *Pubblicazione* |
| Store pubblico: clone anonimo, manifest e icona raggiungibili | Verificata (HTTP 200, `git clone` senza credenziali) | <https://github.com/MichaelPiu/piu-umbrel-app-store> |
| Immagine scaricabile senza autenticazione | **Bloccata**: il pacchetto GHCR è privato (decisione del proprietario). La richiesta anonima riceve HTTP 401 e l'Action dello store fallisce **solo** su questa verifica | passo finale del job *Pubblicazione*, Action dello store (da rilanciare dopo aver reso pubblico il pacchetto) |
| Installazione da App Store su un vero Umbrel | **Non verificata** (serve il tuo server) | — |
| Twitch reale (OAuth, EventSub, chat, ricompense, rimborsi) | **Non verificata** (serve il tuo consenso e il tuo canale) | — |
| Overlay dentro OBS | **Non verificata** | — |

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

Prerequisito: immagine GHCR pubblica (vedi README → *Cosa devi autorizzare tu*).

1. Umbrel → **App Store** → **⋯** → **Community App Stores** → `https://github.com/MichaelPiu/piu-umbrel-app-store` → **Add**.
2. Store **Piu** → **Live Catch** → **Install**.
3. Apri `http://umbrel.local:8788/admin`, accedi con utente `admin` e la password mostrata da Umbrel e scegli la tua password.
4. Consigliato: hostname dedicato (README → *Sicurezza dell'accesso*).

Dati: `~/umbrel/app-data/piu-live-catch/data` (database, immagini, backup, log, `secret.key`), inclusi nei backup di Umbrel.

## Collaudo consigliato sul tuo Umbrel

1. Installazione: l'app si apre, `http://umbrel.local:8788/health` risponde `"status":"ok"`.
2. *Backup e Sistema*: versione `1.0.0-rc.1`, schema DB v2, crea un backup manuale.
3. Riavvia l'app da Umbrel: i dati restano, il login con la tua password funziona.
4. *Impostazioni → Sicurezza*: "Il tuo IP visto dal server" deve essere l'IP del tuo PC, **non** un 10.x/172.x. Se vedi l'indirizzo del gateway, i proxy fidati non sono riconosciuti: segnalalo.
5. DEMO con OBS (overlay da `http://IP-UMBREL:8788/overlay`).
6. Twitch: collegamento, *Testa connessione*, creazione delle 4 ricompense; da offline devono risultare **⏸ in pausa** su Twitch.
7. Diretta di prova (anche non pubblicizzata):
   - le ricompense si riattivano;
   - un riscatto genera il lancio;
   - `!pokedex` risponde;
   - a fine diretta le ricompense tornano in pausa.

## Pubblicazione di una versione

Vedi README → *Pubblicazione di una nuova versione*. In breve: tag `vX.Y.Z` → CI (test, container amd64/arm64, linter Umbrel, push GHCR) → `scripts/publish-store.sh <store> sha256:<digest>` → push dello store, la cui Action esegue il linter ufficiale con `--check-images`.
