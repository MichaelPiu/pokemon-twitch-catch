# Changelog

## Non pubblicato

### Overlay rotante, Statistiche Community ed Eventi automatici

#### Novità
- **Overlay rotante** nella stessa Browser Source `/overlay`: classifica (Top 10 con cambi di posizione animati), ultime catture, shiny, obiettivi della community e Pokémon del giorno, Statistiche Community, evento in corso. Ordine, schermate attive, durata per schermata con minimo e massimo, transizione, posizione, blocco manuale, schermata successiva e anteprima dalla nuova sezione *Overlay rotante*. Schermate senza dati saltate; rotazione decisa dal server con un solo timer (stesso stato per tutte le sorgenti OBS, anche dopo riconnessioni e riavvii); aggiornamenti in tempo reale sul WebSocket esistente; i cambi di schermata non toccano il canale audio.
- **Statistiche Community** (nuova sezione): Pokémon più catturato e Top 10, spettatore più fortunato con metrica configurabile e spiegata, Pokémon più raro, allenatore con più catture e con più shiny, tipo più catturato, totali, record di catture in una sessione, sessione con più Leggendari; periodi sessione corrente, ultima diretta, 7 giorni, 30 giorni, storico; parità sempre indicate.
- **Eventi automatici** (nuova sezione): Evento Leggendario (per tempo o per catture), Bonus Shiny (programmato o manuale), Pokémon del giorno, Evento Community con obiettivo, barra di avanzamento, premio grafico e nuovo obiettivo. Giorni e orari, durate, frequenze e moltiplicatori configurabili; avvio e arresto manuali; stato e storico con il risultato di ogni evento; eventi nello Stream Recap.
- **Annunci in chat** degli eventi come nuovi messaggi della sezione *Messaggi Twitch* (gruppo *Eventi automatici*), con le stesse regole antispam e senza code per dopo.

#### Sicurezza del gioco
- Tutto spento per impostazione predefinita. I bonus valgono solo per la scelta dei Pokémon che appaiono (rarità e shiny), sono letti a ogni spawn e cessano con l'evento: probabilità di cattura, impostazioni salvate e regole di punteggio non cambiano mai. Un solo evento con bonus alla volta. Twitch offline o gioco fermo: evento terminato o sospeso secondo la regola scelta, mai con bonus attivi. Sessioni manuali solo se abilitate, DEMO mai.

#### Aggiornamento
- Nessuna migrazione: schema v5 invariato. Impostazioni in `admin_settings` (`autoEvents`, `autoEventsState`, `communityStats`) e `overlay_settings` (`rotation`), incluse nei backup. Ritorno alla 1.0.1 possibile senza ripristino (le chiavi nuove vengono ignorate).
- Il motore espone un punto di estensione per il bonus degli eventi (`spawnModifier`) e il riepilogo uno per gli eventi della sessione (`recapExtras`); senza eventi attivi il comportamento è identico alla 1.0.1.

#### Test
- `test/engagement.test.js`: 20 test.

## 1.0.1 — messaggi automatici in chat (versione di test)

Prerelease di test sopra la 1.0.0 stabile: tag `v1.0.1`, immagine `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.1`.

### Aggiornamento dalla 1.0.0
- Nessuna migrazione: lo schema del database resta v5 e il formato dei backup non cambia. Le impostazioni dei messaggi stanno in `admin_settings.chatMessages`, incluse nei backup.
- Dopo l'aggiornamento i messaggi in chat sono spenti; si attivano dalla sezione *Messaggi Twitch*.
- Ritorno alla 1.0.0: possibile senza perdita di dati (stesso schema); la 1.0.0 ignora le impostazioni dei messaggi, che ritornano disponibili reinstallando la 1.0.1.
- CI: il tag Docker `latest` non viene più spostato dai rilasci (si usano solo tag di versione e `sha-…`).

### Messaggi automatici in chat (sezione "Messaggi Twitch")

#### Novità
- Il bot annuncia in chat lo spawn di un Pokémon e le catture riuscite, con testi modificabili e variabili (`{pokemon}`, `{pokemon_lower}`, `{pokemon_upper}`, `{rarity}`, `{shiny}`, `{level}`, `{user}`). `{level}` resta vuoto: il gioco non ha livelli.
- Eventi aggiuntivi già supportati dal motore: spawn shiny, cattura shiny, cattura leggendaria o mitica (sostituiscono il messaggio generico), inizio e fine sessione (diretta o sessione manuale). Primo posto in classifica, record personale ed evoluzione compaiono come *non disponibile*.
- Nuova sezione della dashboard: attivazione generale e per evento, messaggi personalizzati (aggiungi, duplica, modifica, elimina, attiva/disattiva), messaggio fisso o casuale da un gruppo, intervallo minimo per tipo, limite al minuto, anteprima con valori d'esempio, invio di prova con conferma, ultimi messaggi con l'esito.
- Invio tramite il `ChatSender` esistente con l'account del bot: nessuna seconda connessione a Twitch e nessuna nuova autorizzazione. Con un bot collegato non si usa mai il token del canale; senza bot, solo su consenso esplicito.
- Antispam: un messaggio per spawn e per cattura, intervallo minimo per tipo, limite al minuto, coda corta, messaggi vecchi scartati, pausa dopo un 429. Twitch offline o bot non utilizzabile: messaggi scartati, mai accodati.
- Sicurezza: sostituzione delle variabili lato server con dati del database (nome dall'identità Twitch registrata), testo semplice su una riga senza caratteri di controllo né `/` iniziali, modifiche solo per l'amministratore (sessione e CSRF) e registrate nel registro operazioni, nessun token nei log.
- Il motore emette un nuovo evento interno `session` (inizio sessione); nessun cambiamento al gioco.

#### Invariato
- Probabilità di cattura, motore di gioco, Channel Points, classifiche, overlay OBS, audio, comandi chat, schema del database (impostazioni in `admin_settings.chatMessages`), formato dei backup. Dopo l'aggiornamento i messaggi sono spenti.

#### Test
- `test/chat-messages.test.js`: 23 test.

## 1.0.0 — prima versione stabile

Pubblicata il 10 novembre 2026: tag `v1.0.0`, immagine `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.0@sha256:6f03f10cf2bcea6558d2baa7ea0d24068cc865eb8c8c1684e3a61d5c72808055` (`linux/amd64`, `linux/arm64`), store Umbrel aggiornato (commit dello store `004e5ff`).

### Aggiornamento dalla 1.0.0-rc.3
- Il database passa dallo schema v3 al v5 (migrazioni 4 e 5). Prima della migrazione l'app crea da sola il backup `…-pre-migration.sqlite.gz`. Dati, catture, giocatori, temi, impostazioni e credenziali Twitch restano invariati; le catture esistenti entrano nelle classifiche come *storiche*.
- In OBS non serve una nuova sorgente: gli effetti sonori li riproduce la sorgente `/overlay` già configurata (attiva *Controlla l'audio tramite OBS*). I file audio si copiano a mano in `data/audio`.
- Verifiche prima della pubblicazione: 266/266 test su Node 24.22.2 e 26.13.0; aggiornamento da un database creato con il codice della rc.3 (backup `pre-migration` identico all'originale, nessun dato o impostazione persi); backup locale e di rete ripristinati su un'installazione con `secret.key` diversa (HTTP 200, Twitch scollegato con avviso, credenziali cifrate intatte). **Non verificati**: installazione e aggiornamento su un vero Umbrel, Twitch reale, overlay e audio dentro OBS.

### Effetti sonori per OBS


#### Novità
- Suono a ogni nuovo spawn (casuale dalla lista senza ripetere l'ultimo, oppure fisso) e musica di conferma a ogni cattura riuscita.
- **Una sola Browser Source**: i suoni li riproduce l'overlay principale `/overlay`, la stessa sorgente della grafica (HTML5 Audio, riconnessione automatica, diagnostica con `?debug=1`, pulsante *Sblocca audio*). Nessuna pagina `/overlay/audio` e nessuna seconda sorgente in OBS.
- L'audio parte solo nella Browser Source di OBS (riconosciuta da `window.obsstudio`) o con `?audio=1`; `?audio=0` lo disattiva. Anteprima della dashboard (`?preview=1`, iframe) e browser normale restano muti e non si collegano al canale audio.
- Canale WebSocket dedicato `/ws/audio`, consumato dall'overlay accanto a `/ws/overlay`: gli aggiornamenti grafici (snapshot, temi, classifiche) non interrompono né ripetono i suoni; la dashboard non riceve né riproduce audio.
- Sezione **Audio OBS** della dashboard: attivazione generale, spawn e cattura, volume, durata massima con dissolvenza, DEMO facoltativa, modalità casuale o fissa, scelta dei file, elenco dei file disponibili, prova in OBS, numero di overlay OBS collegati.
- File audio dell'utente nella cartella dati `/data/audio` (mai nel repository o nell'immagine): whitelist costruita leggendo la cartella (MP3, OGG, WAV; niente collegamenti simbolici, file nascosti o percorsi arbitrari; ID opaco nell'URL). Riconoscimento automatico per nome, anche con lettere accentate scomposte.
- Eventi legati al motore di gioco (eventi `spawn` e `attempt` già esistenti): un ID univoco per spawn e per tentativo, deduplicazione nel server e nell'overlay, nessun evento passato dopo una riconnessione, eventi in ritardo oltre 10 s scartati secondo l'ora del server. Nessun suono per lanci falliti o rifiutati, riscatti duplicati, catture già annullate, DEMO (salvo opzione). Un errore audio non blocca mai il gioco.
- Impostazioni nel database (`admin_settings.audio`), registrate nel registro operazioni.

#### Invariato
- Probabilità di cattura, motore di gioco, Twitch e Channel Points, classifiche, formato dei backup.

#### Test
- `test/audio.test.js`: 16 test. Suite completa: 266/266 su Node 24.22.2 e 26.13.0.

### Classifiche, Hall of Fame e Stream Recap


#### Database: schema v5 (migrazione 5)
- `twitch_users`: colonne `custom_name`, `custom_name_at`, `custom_name_by` (nome visualizzato scelto dall'admin).
- Nuove tabelle: `player_aliases` (storico dei nomi), `leaderboard_rule_versions` (regole di punteggio versionate), `leaderboard_events` (un evento per cattura valida, univoco sul tentativo, immutabile), `leaderboard_snapshots` (risultati congelati, immutabili, non cancellabili), `leaderboard_settings`, `stream_recaps`.
- Viste: `players`, `leaderboard_entries` (classifica calcolata dagli eventi, nessuna seconda copia dei dati).
- Le catture reali già presenti (Twitch e manuali) entrano negli eventi con le regole iniziali (`source = 'backfill'`); DEMO e catture annullate escluse. Backup `pre-migration` automatico.

#### Classifiche
- Classifica catture e classifica punti per sessione, in tempo reale; punteggio = base + bonus rarità + bonus shiny, configurabile, con regole versionate e punti salvati alla cattura.
- Sezione **Classifiche** della dashboard: sessione corrente o precedente, filtri Twitch/Manuale e giocatore, controlli dell'overlay, congelamento e sblocco con motivazione, istantanee, anteprima privata.
- Overlay OBS: Top 10, podio, vincitore, riepilogo, Hall of Fame, via WebSocket; restano visibili finché non vengono nascoste (anche dopo la fine della diretta e dopo un riavvio).
- Comando `!leaderboard [hide|freeze|winner]` per broadcaster e moderatori autorizzati (ruolo dall'evento Twitch, mai dal nickname), solo durante le dirette.
- Giocatori: identità per Twitch User ID con storico dei nickname, giocatori locali separati, ricerca, profilo, nome visualizzato modificabile (registrato, non tocca i dati storici).
- Hall of Fame permanente con filtri; Stream Recap salvato alla chiusura di ogni sessione Twitch e manuale.
- Registro operazioni: congelamenti, sblocchi, mostra/nascondi, regole, comandi, rinomine, rigenerazione dei riepiloghi.

#### Correzione: backup ripristinato su un'altra installazione
- Difetto presente anche nella 1.0.0-rc.3. Le credenziali Twitch sono cifrate con `secret.key`, che non è nei backup. Ripristinando un backup su un'installazione nuova (Umbrel reinstallato, nuovo server) la decifratura andava in errore: il ripristino rispondeva 500 pur avendo sostituito i dati, Panoramica, Twitch e Sistema rispondevano 500 e la modalità manuale non partiva.
- Ora le credenziali non leggibili con la chiave attuale sono trattate come assenti: Twitch risulta scollegato, con un avviso in Panoramica e nella pagina Twitch che spiega di reinserire il Client Secret e ricollegare gli account. Dashboard e modalità manuale funzionano.
- Le credenziali cifrate originali restano intatte nel database finché un nuovo collegamento riuscito non le sostituisce. Formato dei backup invariato; `secret.key` resta esclusa.

#### Test
- `test/leaderboard.test.js`: 30 test (i 28 casi richiesti, più catture annullate e rinomina).
- `test/credentials-key.test.js`: 3 test sul ripristino con una `secret.key` diversa (backup di rete e locale, HTTP 200, pagine, modalità manuale, avviso, conservazione delle credenziali, ricollegamento).
- Suite completa: 250/250 su Node 24.22.2 e 26.13.0.
- `test/network-backup.test.js`: le verifiche "schema invariato" usano la versione corrente invece del numero 4; il backup costruito per far fallire la migrazione toglie le righe di migrazione dalla 4 in su (prima solo la 4).

### Modalità manuale, backup di rete e modifica del Pokédex


#### Database: schema v4 (migrazione 4)
- `stream_sessions`: colonne `kind` (`twitch` / `manual` / `demo`), `errors`, `last_error`.
- `user_pokemon`: colonne `origin` (`twitch` / `manual` / `admin` / `import` / `demo`, ricavata dai dati esistenti), `note`, `rev`, `updated_at`, `updated_by`.
- `twitch_users`: colonna `origin` (`twitch` / `demo` / `local`).
- Nuova tabella `admin_audit` (registro delle modifiche).
- Solo aggiunte, nessun dato modificato o rimosso. Backup `pre-migration` automatico prima della migrazione. La rc.3 rifiuta un database v4: per tornare indietro va rimesso il backup `pre-migration` (README → *Tornare a una versione precedente*).

#### Modalità manuale
- Nuova sezione **Controllo gioco**: modalità AUTOMATICA/MANUALE, avvio e arresto del gioco con Twitch OFFLINE usando lo stesso motore, tempo trascorso, incontri, catture, errori, indicatore SESSIONE MANUALE nella barra in alto.
- Lanci per giocatori locali (separati dagli utenti Twitch) o per spettatori registrati; nessuna chiamata a Twitch, nessun EventSub, nessun riscatto reale.
- La diretta Twitch ha la priorità: la sessione manuale viene chiusa (`twitch_live`), registrata e segnalata in dashboard.
- Storico dirette con filtro per tipo di sessione.

#### Backup di rete
- Backup automatici e manuali in una cartella montata in `/backups-network` (Umbrel `folderAccess` o volume Docker): verifica della connessione, frequenza, ora, rotazione, backup prima degli aggiornamenti, stato e ritentativi, tempi massimi per non bloccare l'app.
- Copia consistente (`VACUUM INTO`), manifest con versione, schema e SHA-256, scrittura atomica, nessun segreto in chiaro, file sconosciuti mai toccati, ultimo backup valido mai eliminato.
- Ripristino guidato: verifica, riepilogo, conferma, backup di sicurezza, arresto del motore, gestione del WAL, verifica di integrità e rollback automatico in caso di errore.

#### Modifica del Pokédex
- Nuova sezione **Modifica Pokédex**: ricerca e filtri, correzione, registrazione e rimozione di esemplari con anteprima delle differenze, conferma, controllo dei conflitti (revisione), origine sempre visibile, registro delle modifiche.

#### Test
- 37 nuovi test (modalità manuale, backup di rete, modifica del Pokédex).

## 1.0.0-rc.3 — Overlay Themes e correzioni dopo l'audit pre-release

Terza versione candidata (**Release Candidate, non una versione stabile**), pubblicata il 10 novembre 2026: tag `v1.0.0-rc.3`, immagine `ghcr.io/michaelpiu/pokemon-twitch-catch:1.0.0-rc.3@sha256:5b1fb376086df52b883cac684ae939c0451f1a92695c8599a8c1cc79b5dbb114` (`linux/amd64`, `linux/arm64`), store Umbrel aggiornato.

### Aggiornamento dalla 1.0.0-rc.2
- Il database passa dallo schema v2 al v3 (tabella `overlay_themes`). Prima della migrazione l'app crea da sola il backup `…-pre-migration.sqlite.gz`.
- Le impostazioni overlay esistenti diventano il tema Classico: l'aspetto in diretta non cambia.
- Rollback alla rc.2: vedi README → *Tornare a una versione precedente*.

### Stato delle verifiche
- **Test automatici locali**: 180/180 su Node 24.22.2 (la versione dell'immagine `node:24-alpine`) e su Node 26.13.0, con Twitch simulato (`FakeTwitch`, `FakeEventSub`). Comprendono migrazioni, backup e ripristino, errori temporanei di Twitch e sicurezza.
- **Verifiche locali con script**: rollback rc.2 ↔ rc.3 sulla stessa cartella dati (nessun dato perso); backup creato con una versione di Node e ripristinato con l'altra; avvio del server con `/health` e `scripts/healthcheck.js`.
- **Test browser automatizzati** (Chromium del browser integrato, non OBS): pagine della dashboard e Overlay Designer, cookie malformato, conflitto di revisione dei temi (409).
- **CI di GitHub sul tag `v1.0.0-rc.3`** (run 42776475968): test Node 24 180/180, linter Umbrel, avvio reale del container amd64 e arm64 (arm64 in emulazione QEMU), build e push multi-arch, controllo anonimo bloccante superato.
- **Pubblicazione verificata senza credenziali**: manifest e digest su GHCR, tutti i layer di entrambe le architetture scaricati e verificati; Action dello store (linter ufficiale con `--check-images`) superata.
- **Non ancora verificati**: installazione e rollback su un vero Umbrel, Twitch reale (OAuth, EventSub, chat, ricompense, rimborsi), overlay dentro OBS.

### Overlay Designer
- Nuova sezione **Overlay Designer**, che sostituisce la pagina *Overlay*.
- **9 temi integrati**: Classico, che replica l'aspetto precedente ed è il tema attivo di default, più gli 8 richiesti: Minimal Dark, Clean Glass, Neon HUD, Minimal Light, Cyber Pulse, Holographic, Cinematic, Gradient Motion. Ognuno ha disposizione e foglio di stile propri.
- **Editor visuale**: colori con opacità, font e dimensioni, bordi, angoli, ombre e bagliore, posizione (9 punti), margini, larghezza del pannello e dimensione dell'immagine, animazioni di entrata e uscita con velocità, notifiche (durata, numero visibili, tipi), elementi e stile del timer (barra, anello, numeri), intensità degli effetti.
- **Anteprima in tempo reale** con la vera pagina `/overlay` alla risoluzione scelta (1920×1080 / 1280×720) e sfondo selezionabile; aggiornamento senza ricaricare.
- **Gestione dei temi**: selezione, duplicazione, modifica, salvataggio, ripristino dei valori originali, creazione da zero, importazione ed esportazione JSON con validazione e sanificazione. I temi sono salvati nel database (tabella `overlay_themes`, migrazione 3, con backup automatico prima della migrazione).
- **Simulatore**: spawn, shiny, leggendario, lancio fallito, cattura, fuga, scadenza, notifica, sequenza completa.
  - Nessuna scrittura nel database.
  - Invio all'overlay pubblico (OBS) facoltativo, solo a gioco fermo, con badge "SIMULAZIONE".

### Overlay
- Tela logica 1920×1080 scalata alla sorgente: stesso aspetto a 1920×1080 e 1280×720.
- Cambio di tema immediato via WebSocket, senza ricaricare la sorgente OBS.
- Nuove posizioni: centro-sinistra e centro-destra.
- Nuovo evento `notice`.
- Intensità effetti 0: nessuna animazione continua.
- Compatibilità:
  - le impostazioni overlay esistenti vengono applicate al tema Classico, quindi l'aspetto in diretta non cambia dopo l'aggiornamento;
  - `GET`/`PUT /api/admin/overlay` continuano a funzionare;
  - lo snapshot WebSocket mantiene i campi precedenti.

### Dashboard
- Barra superiore su schermi stretti (≤ 600 px): titolo abbreviato e solo il pallino di stato Twitch, senza scorrimento orizzontale.

### Manutenzione e stabilizzazione (dopo l'audit tecnico)

#### Simulatore e overlay pubblico
- **P1**:
  - Le simulazioni verso l'overlay pubblico (OBS) sono bloccate anche in **PAUSED**: prima il controllo guardava solo il motore in esecuzione.
  - L'overlay pubblico risulta "in uso" in LIVE, PAUSED, DEMO o con una diretta sospesa. Il blocco vale anche chiamando l'API direttamente (409) e su `sendToObs`.
  - La destinazione predefinita è l'anteprima privata; valori diversi da `preview` e `obs` sono rifiutati (400).
  - Il Designer distingue *anteprima privata* e *overlay pubblico (OBS)*. A gioco attivo disattiva l'opzione e lo spiega; lo stato viene ricontrollato ogni 15 s.
- **P2**:
  - Quando il gioco passa a LIVE o PAUSED, o si avvia la DEMO, gli invii programmati vengono annullati e gli overlay ricevono il nuovo evento `sim_clear`.
  - Gli overlay tolgono solo gli elementi marcati `sim: true` (eventi in coda, spawn, notifiche). Lo stesso fanno con `state` attivo e con il `clear` del simulatore. Gli elementi reali non vengono toccati.
  - Alla riconnessione lo snapshot contiene solo lo stato reale.
- **P8**: lo spawn simulato che arriva dal browser è validato campo per campo (id, tipi, rarità, immagine locale o PokéAPI, date, tentativi, nome senza caratteri di controllo). Se non è valido viene scartato. Testo e durata delle notifiche di prova sono controllati.
- **P12**: ogni invio simulato all'overlay pubblico e ogni pulizia sono registrati nel log (`[overlay]`).

#### Overlay
- **P3**:
  - Nuova coda limitata per spawn, lanci e fughe (`public/assets/js/overlay/event-queue.js`).
  - Il limite è configurabile da *Animazioni → Eventi in coda prima di saltare le animazioni* (2–50, predefinito 6). Con la coda piena a metà le animazioni sono 3 volte più rapide; con la coda piena vengono saltate.
  - Nessun evento reale viene perso; ogni evento ha un tempo massimo di 8 s.
  - Nel browser, 120 lanci consecutivi sono stati smaltiti in circa 10 s con il contatore esatto.
  - Il cambio tema non passa più dalla coda: viene applicato subito (2 ms misurati con 119 eventi in attesa).
  - Notifiche: con la coda piena si scartano per prime le meno importanti; le catture reali restano.
  - Con cambi di tema rapidi vince l'ultimo foglio di stile richiesto.
- **P4**: il contatore dei tentativi resta corretto dopo un cambio tema.
- **P5**:
  - Contrasto del testo ≥ 4,5:1 sul pannello di ogni preset, anche sopra uno sfondo bianco. Clean Glass ha ora una velatura scura e l'ombra del testo; il pannello di Gradient Motion è più opaco; il testo secondario di Minimal Dark è più chiaro.
  - Dimensioni minime: scritte piccole 14 px e notifiche 18 px sulla tela 1920×1080 (circa 9,3 e 12 px a 1280×720, contro gli 8–11 px precedenti).
  - Chi ha già modificato un preset mantiene i propri colori; *Ripristina* applica i nuovi valori.

#### Temi e API
- **P6**: `PUT /api/admin/overlay` (API precedente) accetta tutte le 9 posizioni. Prima rifiutava qualsiasi modifica se il tema attivo era al centro a sinistra o a destra.
- **P7**:
  - Nomi dei font personalizzati: lettere (anche accentate), cifre, spazi, trattini e punti, fino a 60 caratteri.
  - Apostrofi, virgolette, virgole e punti e virgola sono rifiutati.
  - Il CSS generato mette il nome tra virgolette doppie dopo averlo ripulito.
- **P9**:
  - Il salvataggio di un tema richiede la revisione `rev`. Il server scrive solo se il tema è ancora a quella revisione (controllo nella stessa istruzione SQL); altrimenti risponde 409 con la versione salvata.
  - Il Designer chiede se ricaricare o sovrascrivere esplicitamente (`force: true`). Nessuna sovrascrittura silenziosa.
- **P12**:
  - Una sola funzione di unione delle configurazioni (`mergeConfig`) per browser e server.
  - Rimossi il ramo `fromId` della creazione dei temi e tre selettori CSS che non potevano mai applicarsi.
  - Nomi dei tipi in un'unica tabella (`lib.js`) per dashboard e overlay. I colori delle rarità dell'overlay restano distinti, per scelta, da quelli della dashboard.

#### Documentazione
- **P10**: come aggiornare la cache della sorgente Browser in OBS dopo un aggiornamento (README, Guida rapida, scheda del Designer).
- **P11**:
  - Funzioni del browser usate dall'overlay: `color-mix()`, che richiede Chromium 111+, `backdrop-filter` e `@property`.
  - Le versioni di Chromium incluse in OBS non sono state verificate.

### Correzioni dopo l'audit pre-release

#### Twitch: errori temporanei (A1, B5)
- HTTP 429 e 5xx, errori di rete e timeout verso Twitch sono **errori temporanei, non revoche**: il token non viene segnato come non valido, lo stato resta LIVE, nessuna pausa delle ricompense e nessun rimborso. Prima un 503 o un problema di rete durante il controllo orario del token portava il gioco in ERROR in piena diretta, chiedendo di ricollegare l'account.
- La procedura di revoca parte solo quando Twitch rifiuta davvero il token: `/oauth2/validate` risponde 401 e il rinnovo risponde 400 o 401.
- Il controllo orario del token usa il rinnovo condiviso con le richieste Helix (un solo rinnovo alla volta).
- Nuovo modulo `src/twitch/http.js` per Helix e id.twitch.tv:
  - timeout per ogni chiamata (10 s, `TWITCH_HTTP_TIMEOUT_MS`);
  - fino a 2 ritentativi (`TWITCH_HTTP_RETRIES`) con attesa crescente, rispettando `Retry-After` e `Ratelimit-Reset`; un'attesa richiesta oltre 15 s non viene ignorata, si riprova al ciclo successivo;
  - le richieste POST vengono ritentate solo dopo un 429, per non inviare due volte un messaggio in chat o creare due ricompense.
- Dashboard: avviso "Problema temporaneo di Twitch … il gioco continua", che sparisce da solo alla prima risposta corretta.
- Rimborsi: un 429 o Twitch irraggiungibile non consumano i 6 tentativi.
- Collegamento account: un errore temporaneo durante il polling del Device Code Flow non interrompe la procedura.

#### Sicurezza e robustezza (M1, B1, B4)
- **M1**: un cookie con codifica non valida (anche di un'altra app sullo stesso host, es. `umbrel.local`) viene ignorato. Prima mandava in errore 500 tutte le API e lasciava appeso il WebSocket della dashboard. Un parametro di percorso malformato riceve 400. Qualsiasi errore durante l'apertura di un WebSocket chiude la connessione con 400.
- **B1**: `limit` della classifica pubblica e degli elenchi della dashboard sempre tra 1 e il massimo previsto (prima un valore negativo eliminava il limite).
- **B4**: limite delle connessioni WebSocket dell'overlay: 30 per indirizzo IP e 100 in totale (`WS_OVERLAY_MAX_PER_IP`, `WS_OVERLAY_MAX_CONNECTIONS`). Oltre il limite: risposta 503, l'overlay riprova da solo. La dashboard non è coinvolta.

#### Database e backup (M2, B6, B7)
- **M2**: un backup con uno schema più recente di quello supportato viene rifiutato, sia al ripristino sia al caricamento, **prima** di toccare il database (nessun backup di sicurezza, nessuna sostituzione). Lo stesso controllo all'avvio: con un database più recente l'app non parte e non lo modifica.
- **B6**: il backup automatico usa ora e giorno nello stesso fuso orario (`TZ`); prima confrontava l'ora locale con la data UTC e con l'orario a mezzanotte o all'una poteva saltare un giorno.
- **B7**: le impostazioni dei Pokémon in un'importazione JSON sono validate con gli stessi limiti della dashboard; un valore non valido annulla l'intera importazione senza modifiche. I campi assenti restano invariati.

#### Gioco, temi e simulatore (B2, B3, B8)
- **B2**: con *revoca della cattura sull'annullamento* attiva, un riscatto annullato da un moderatore toglie il Pokémon e anche il tentativo dalle statistiche (sessione, spawn, grafici, classifiche). Il tentativo appare come rifiutato con motivo "riscatto annullato". Eventi ripetuti non contano due volte.
- **B3**: *Ripristina* ed *Elimina* nel Designer inviano la revisione del tema: se nel frattempo è stato salvato altrove il server risponde 409 e il Designer carica la versione più recente invece di agire alla cieca. Senza `rev` l'API resta compatibile.
- **B8**: in ERROR o CONNECTING le simulazioni verso l'overlay pubblico sono bloccate se Twitch ha segnalato il canale in diretta (API `/streams` o evento `stream.online`, informazione valida 30 minuti). L'anteprima privata del Designer resta sempre disponibile.

#### Documentazione (M3)
- README: tabella delle versioni dello schema e procedura **Tornare a una versione precedente**: rollback semplice (nessuna perdita di dati) e rollback esatto con il backup `pre-migration`. Verificata in locale con il codice rc.2, non su Umbrel.
- `docs/UMBREL.md`: collaudo aggiornato allo schema v3, passi per Designer/OBS e rollback.
- Nuove variabili d'ambiente e nuove voci in *Risoluzione problemi*.

#### Test delle correzioni
- `test/twitch-resilience.test.js` (12 test): 503 su validate e rinnovo, 429 con `Retry-After` breve e lungo, timeout, rete assente, 5xx persistente di Helix, token davvero revocato, recupero, rinnovo deduplicato, Device Code Flow, unità di `fetchWithRetry`.
- `test/hardening.test.js` (14 test): cookie malformati via HTTP e WebSocket, backup e database con schema più recente (database e file invariati), limite della classifica, statistiche dopo l'annullamento, revisione dei temi, limite delle connessioni overlay, backup automatico con fuso orario, validazione dell'importazione, simulatore in ERROR/CONNECTING, timeout di Helix.
- `FakeTwitch.fault()` (helpers) simula 429/5xx, rete assente e richieste che non rispondono.
- `test/rewards.test.js`: il guasto simulato del rimborso dura ora 3 risposte 500 invece di 1, perché il client ritenta da solo i 5xx. Le verifiche del test sono invariate.
- Totale 156 (130 + 26).

#### CI: accesso anonimo all'immagine ora bloccante
- Il passo *Verifica accesso anonimo* del job di pubblicazione non ha più `continue-on-error`: prima una run poteva risultare verde anche con il pacchetto GHCR privato (è successo per rc.1 e rc.2, HTTP 401).
- Nuovo `scripts/check-ghcr-anonymous.mjs` (Node, nessuna dipendenza, nessuna credenziale): token anonimo, manifest del tag appena pubblicato, digest uguale a quello della build e al contenuto ricevuto, presenza e download di `linux/amd64` e `linux/arm64` con la configurazione dell'architettura giusta. 401, 403, 404, digest mancante o diverso, architettura mancante, errori di rete e timeout fanno fallire il job. Il digest verificato va nel riepilogo della run.
- `test/ghcr-anonymous-check.test.js` (24 test) con un registry simulato in locale; controllano anche che il workflow non tolleri l'errore. Totale 180.
- Stato GHCR: il 10 novembre 2026 il pacchetto è stato reso pubblico; pull anonimo, manifest e digest della rc.2 e Action dello store verificati. Il nuovo passo è stato poi eseguito e superato in GitHub Actions per `main` e per il tag `v1.0.0-rc.3`.

### Test
- `test/overlay-stability.test.js` (25 test):
  - simulazione in OFFLINE, DEMO, LIVE e PAUSED, con tentativi di aggirare il blocco via API;
  - passaggio OFFLINE → LIVE con elementi simulati presenti;
  - sequenza programmata interrotta;
  - riconnessione del WebSocket durante la transizione;
  - 150 eventi consecutivi; evento bloccato o in errore; timer come nel browser;
  - cambio tema con la coda piena e durante una cattura reale;
  - contatore dei tentativi dopo il cambio tema;
  - pulizia solo degli elementi simulati;
  - notifiche con la coda piena;
  - cambi di tema rapidi;
  - 8 salvataggi contemporanei dello stesso tema;
  - posizioni nell'API precedente;
  - font personalizzati;
  - contrasto e dimensioni minime;
  - validazione dello spawn simulato;
  - database (Pokédex, catture, statistiche, classifiche, ricompense) invariato.
- I test dell'overlay eseguono il vero `overlay.js` in un DOM minimo senza dipendenze (`test/dom-shim.js`).
- Utilità condivise in `test/overlay-helpers.js`.
- `FakeEventSub.refuse` simula Twitch irraggiungibile, così lo stato PAUSED resta stabile.
- Totale 130 (105 + 25).

### Test (prima versione di Overlay Themes)
- `test/overlay-themes.test.js` (15 test):
  - preset e validazione;
  - salvataggio e persistenza dopo il riavvio;
  - duplicazione, ripristino ed eliminazione;
  - importazione ed esportazione, anche con input malevoli;
  - aggiornamento WebSocket e cambio tema senza riavvio;
  - isolamento del simulatore (fotografia completa del database);
  - simulatore bloccato a gioco attivo;
  - API precedenti;
  - migrazione da un database rc.2.
- Totale allora: 105. Negli stessi test i salvataggi ora inviano `rev`.

## 1.0.0-rc.2 — preparazione al collaudo su Umbrel

### Token Twitch revocati
- Revoca EventSub `authorization_revoked` / `user_removed`: stato **ERROR** immediato, senza attendere il controllo periodico.
- Token del canale revocato: segnato come non valido (visibile in dashboard). Avviso con le ricompense che potrebbero restare riscattabili su Twitch perché la pausa non è possibile senza token.
- Rimborsi: gli errori di autorizzazione non consumano più i 6 tentativi. Al ricollegamento l'app mette in pausa le ricompense e rimborsa i riscatti rimasti in coda.
- Se il rinnovo del token torna a funzionare, l'app ricollega EventSub e ricrea le sottoscrizioni.
- Token del **bot** revocato: il gioco non va più in ERROR. Le risposte passano all'account del canale e il messaggio non consegnato viene reinviato.

### Documentazione
- Guida passo per passo all'hostname dedicato su Umbrel (`docs/UMBREL.md`), con il limite residuo dichiarato.
- Scope OAuth verificati sulla documentazione Twitch.
- Repository di sviluppo pubblico.

### Test
- Nuovi: `test/tokens.test.js` (3) e `test/audit.test.js` (4). Totale 90.

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
