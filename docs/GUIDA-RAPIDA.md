# Guida rapida (per chi non è pratico di informatica)

Tempo stimato: 20–30 minuti, da fare una sola volta.

## Cosa ti serve
- Il tuo server **Umbrel** acceso e collegato a Internet.
- Il computer da cui fai le dirette, con **OBS**, nella **stessa rete di casa** del server.
- Il tuo account Twitch **Affiliate o Partner**.

## Passo 1 — Installa l'app su Umbrel
1. Dal computer apri il browser e vai su **http://umbrel.local**.
2. Clicca **App Store**, poi i **tre puntini ⋯** in alto a destra → **Community App Stores**.
3. Incolla l'indirizzo dello store che ti è stato fornito (es. `https://github.com/MichaelPiu/pokemon-twitch-catch`) e premi **Add**.
4. Apri lo store **Piu**, clicca **Live Catch** → **Install**. Attendi qualche minuto.
5. Nella scheda dell'app su Umbrel trovi **utente** (`admin`) e **password iniziale**: annotali.

## Passo 2 — Primo accesso
1. Apri l'app (oppure vai su **http://umbrel.local:8788/admin**).
2. Accedi con utente e password del passo 1.
3. Scegli una **nuova password** personale (almeno 10 caratteri, con lettere e numeri) e conservala.

## Passo 3 — Scarica i Pokémon
1. Nel menu a sinistra clicca **Pokémon**.
2. Premi **Importa da PokéAPI** e aspetta che la barra arrivi al 100% (qualche minuto).

## Passo 4 — Collega Twitch
1. Nel menu clicca **Gestione Twitch** e segui i riquadri numerati:
2. **Riquadro 1**: apri il link *dev.twitch.tv/console/apps*, clicca *Registra la tua applicazione*:
   - Nome: quello che vuoi (es. `LiveCatch` + il tuo nome);
   - URL di reindirizzamento: `http://localhost` → *Aggiungi*;
   - Categoria: *Chat Bot*; Tipo di client: *Riservato*;
   - Crea, poi apri *Gestisci*: copia **ID client**, premi **Nuovo segreto** e copia il segreto.
   - Incolla entrambi nella dashboard e premi **Salva**.
3. **Riquadro 2**: premi **Collega account del canale**. Compare un codice grande.
   - Dal telefono o dal PC apri **twitch.tv/activate**, accedi con l'account del TUO canale, scrivi il codice e premi *Autorizza*.
   - Dopo pochi secondi la dashboard mostra “✅ Collegato”.
4. **Riquadro 4**: crea le ricompense. Scegli *Poké Ball*, costo `300`, premi **Crea**. Ripeti per *Mega Ball* (800), *Ultra Ball* (2000), *Master Ball* (25000).
5. In alto premi **Testa connessione**: devono essere quasi tutte ✅ (“EventSub” è ✅ se il server è connesso).

## Passo 5 — Aggiungi l'overlay in OBS
1. Nella dashboard apri **Overlay** e premi **Copia** accanto all'indirizzo.
   - Se usi Windows, sostituisci `umbrel.local` con l'indirizzo IP del server (lo trovi nelle impostazioni di Umbrel, es. `192.168.1.50`).
2. In OBS: **Sorgenti → + → Browser** → incolla l'URL, larghezza `1920`, altezza `1080` → OK.

## Passo 6 — Prova tutto senza andare in diretta
1. Nel menu clicca **Impostazioni → Modalità DEMO** → **Avvia DEMO** → **Genera Pokémon**: in OBS appare il Pokémon.
2. Premi **Lancia** per simulare uno spettatore che lancia una Poké Ball.
3. Quando hai finito: **Ferma DEMO** e **Cancella dati DEMO**. Le prove non finiscono nelle statistiche reali.

## Fatto!
Da ora in poi **non devi fare nulla**: quando vai in diretta il gioco parte da solo, quando chiudi la diretta si ferma da solo. Tutto resta salvato sul tuo server.

Comandi da comunicare agli spettatori: `!pokedex`, `!pokemon`, `!dex @nome`, `!ultimocatturato`, `!classifica`, `!help`.

## Se qualcosa non va
- In **Panoramica** guarda il riquadro *Stato Twitch*: se è **ERRORE**, vai in **Gestione Twitch** e ricollega l'account.
- **IN PAUSA** significa che il server ha perso momentaneamente Internet: il gioco riprende da solo.
- Hai dimenticato la password? Vedi la sezione *Risoluzione problemi* nel README.
