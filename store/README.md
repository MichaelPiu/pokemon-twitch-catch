# Piu — Community App Store per Umbrel OS

Questo repository contiene **solo** i file di installazione per Umbrel (nessun codice sorgente):

- `umbrel-app-store.yml` — store con id `piu`
- `piu-live-catch/` — app **Live Catch**, gioco di cattura per Twitch con i punti canale

## Installazione su Umbrel

1. Apri Umbrel (`http://umbrel.local`) → **App Store** → menu **⋯** in alto a destra → **Community App Stores**.
2. Incolla `https://github.com/MichaelPiu/piu-umbrel-app-store` e premi **Add**.
3. Apri lo store **Piu**, scegli **Live Catch** e premi **Install**.
4. Apri l'app (`http://umbrel.local:8788/admin`): utente `admin`, password mostrata da Umbrel nella scheda dell'app. Al primo accesso ti verrà chiesto di sceglierne una nuova (da quel momento la password mostrata da Umbrel non vale più).

L'immagine Docker (`ghcr.io/michaelpiu/pokemon-twitch-catch`) è fissata per tag **e** digest ed è pubblicata per `linux/amd64` e `linux/arm64`. La GitHub Action di questo repository esegue il linter ufficiale di Umbrel e verifica che l'immagine sia scaricabile senza autenticazione.

> Progetto amatoriale non ufficiale. Pokémon e i relativi marchi appartengono ai rispettivi titolari (Nintendo, Creatures Inc., GAME FREAK inc., The Pokémon Company). Nessuna affiliazione. Il gioco non contiene dati né immagini Pokémon: vengono scaricati da PokéAPI sul tuo server.
