# Piu — Community App Store per Umbrel OS

Questo repository contiene **solo** i file di installazione per Umbrel (nessun codice sorgente):

- `umbrel-app-store.yml` — store con id `piu`
- `piu-live-catch/` — app **Live Catch**, gioco di cattura per Twitch con i punti canale

## Installazione su Umbrel

1. Apri Umbrel (`http://umbrel.local`) → **App Store** → menu **⋯** in alto a destra → **Community App Stores**.
2. Incolla `https://github.com/MichaelPiu/piu-umbrel-app-store` e premi **Add**.
3. Apri lo store **Piu**, scegli **Live Catch** e premi **Install**.
4. Apri l'app (`http://umbrel.local:8788/admin`): utente `admin`, password mostrata da Umbrel nella scheda dell'app. Al primo accesso ti verrà chiesto di sceglierne una nuova (da quel momento la password mostrata da Umbrel non vale più).

L'immagine Docker (`ghcr.io/michaelpiu/pokemon-twitch-catch`) è fissata per tag **e** digest ed è pubblicata per `linux/amd64` e `linux/arm64`. La GitHub Action di questo repository esegue il linter ufficiale di Umbrel con `--check-images`: controlla che l'immagine sia fissata per digest e scaricabile senza autenticazione, e che l'icona sia raggiungibile.

> **Ultima verifica (10 novembre 2026, senza credenziali, versione 1.0.0):** pacchetto GHCR pubblico; token anonimo di pull e manifest `1.0.0` HTTP 200, con digest `sha256:6f03f10cf2bcea6558d2baa7ea0d24068cc865eb8c8c1684e3a61d5c72808055` uguale a quello fissato nello store per questa versione; immagini `linux/amd64` e `linux/arm64` scaricate per intero (11 layer ciascuna, sha256 verificati). Ogni modifica dello store viene ricontrollata dall'Action. **Non ancora verificati**: l'installazione e l'aggiornamento su un vero Umbrel e l'uso con Twitch e OBS reali.

## Aggiornare Live Catch

Se l'app è già installata, aprila nell'App Store e premi **Update**: i dati (`~/umbrel/app-data/piu-live-catch/data`) restano. **Non disinstallarla** per aggiornarla: la disinstallazione cancella i dati. Prima dell'aggiornamento crea e scarica un backup dalla dashboard (*Backup & Sistema*). Dopo l'aggiornamento, in OBS premi *Aggiorna la cache della pagina corrente* sulla sorgente `/overlay`.

> Progetto amatoriale non ufficiale. Pokémon e i relativi marchi appartengono ai rispettivi titolari (Nintendo, Creatures Inc., GAME FREAK inc., The Pokémon Company). Nessuna affiliazione. Il gioco non contiene dati né immagini Pokémon: vengono scaricati da PokéAPI sul tuo server.
