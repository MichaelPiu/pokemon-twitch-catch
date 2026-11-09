# Changelog

## 1.0.0-rc.1 — candidata alla produzione

### Sicurezza
- **Proxy fidati** (`TRUSTED_PROXIES`): `X-Forwarded-For`/`X-Forwarded-Proto` considerati solo se il peer è un proxy autorizzato (IP, CIDR, `loopback`, `docker-gateway`, nome host). L'IP del client è l'ultimo indirizzo non fidato. Corregge il bypass del limite di login con `X-Forwarded-For` falsificato. `TRUST_PROXY` rimossa.
- Limite di login **per account** (30 errori/15 min) oltre a quello per IP.
- **WebSocket admin**: `Origin` obbligatorio e uguale all'host della dashboard (o in `ALLOWED_ORIGINS`), host ammesso, sessione valida. L'overlay resta pubblico.
- Richieste admin di modifica con `Origin` estraneo o `Sec-Fetch-Site: cross-site` rifiutate anche con cookie e CSRF validi.
- **Sessioni** legate a User-Agent e (configurabile) IP del login, scadenza per inattività (12 h di default), cookie `Secure` automatico dietro proxy HTTPS fidato.
- **Hostname dedicato** opzionale per la dashboard (`ADMIN_HOSTS` o *Impostazioni → Sicurezza*): area admin con risposta 421 sugli altri host, nessun cookie su `umbrel.local`, chiusura delle altre sessioni all'attivazione, rimosso dal recupero password.

### Channel Points
- **Pausa automatica** su Twitch delle ricompense create dall'app quando il gioco non è attivo, riattivazione in LIVE, con ritentativi in caso di errore.
- **Riconciliazione** dei riscatti `UNFULFILLED`: alla connessione EventSub, all'avvio, periodicamente e su richiesta. Elaborazione con l'orario reale e senza duplicati.
- Stato su Twitch salvato prima della chiamata e **ritentato** (massimo 6 tentativi; 404 definitivo); errori visibili in dashboard.
- Eventi EventSub tardivi registrati come `stale` e recuperati dalla riconciliazione.
- Ricompensa del gioco senza Poké Ball valida: rifiutata e rimborsata (`reward_unmapped`) invece di essere ignorata.
- Documentati i limiti Twitch per le ricompense collegate a mano.

### Docker, Umbrel, CI
- Immagine base `node:24-alpine` fissata per digest; GitHub Actions fissate per commit SHA.
- Controllo all'avvio della scrivibilità di `/data` con messaggio chiaro; HEALTHCHECK con `--start-interval`.
- CI: test reale di avvio del container per amd64 e arm64 (`scripts/container-smoke.sh`), linter ufficiale di Umbrel, verifica dell'accesso anonimo all'immagine.
- **Backup automatico `pre-migration`** prima di aggiornare lo schema del database (migrazione 2).
- Repository pubblico separato per l'App Store (`MichaelPiu/piu-umbrel-app-store`), generato con `scripts/publish-store.sh`; manifest con link pubblici e icona raggiungibile.

### Test
- 56 test esistenti mantenuti. Nuovi: `test/security.test.js` (18) e `test/rewards.test.js` (9).

## 0.2.1
- Correzioni emerse dal collaudo nel browser.

## 0.2.0
- Nuova dashboard (tema viola, sidebar, indicatori, grafico in tempo reale).

## 0.1.0
- Prima versione.
