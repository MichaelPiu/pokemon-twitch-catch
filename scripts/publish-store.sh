#!/usr/bin/env bash
# Prepara il contenuto del repository PUBBLICO dell'App Store Umbrel a partire da
# questo repository (privato). Copia solo file di installazione, nessun sorgente.
#
#   scripts/publish-store.sh <cartella-checkout-store> <digest>
#   es. scripts/publish-store.sh ../piu-umbrel-app-store sha256:abcd…
#
# Il digest è quello mostrato nel riepilogo della GitHub Action del rilascio
# ("Digest multi-arch"). Commit e push del repository store si fanno a parte.
set -euo pipefail
DEST="${1:?Uso: $0 <cartella-store> <digest sha256:…>}"
DIGEST="${2:?Manca il digest della immagine, formato sha256:…}"
[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Digest non valido: $DIGEST" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
IMAGE="ghcr.io/michaelpiu/pokemon-twitch-catch"

mkdir -p "$DEST/piu-live-catch/data" "$DEST/assets" "$DEST/.github/workflows"
cp "$ROOT/umbrel-app-store.yml" "$DEST/umbrel-app-store.yml"
cp "$ROOT/piu-live-catch/umbrel-app.yml" "$DEST/piu-live-catch/umbrel-app.yml"
touch "$DEST/piu-live-catch/data/.gitkeep"
cp "$ROOT/store/README.md" "$DEST/README.md"
cp "$ROOT/store/assets/live-catch-icon.svg" "$DEST/assets/live-catch-icon.svg"
cp "$ROOT/store/.github/workflows/lint.yml" "$DEST/.github/workflows/lint.yml"
# Compose con immagine fissata per tag + digest.
sed -E "s|^(    image: ${IMAGE}):.*$|\1:${VERSION}@${DIGEST}|" "$ROOT/piu-live-catch/docker-compose.yml" \
  | grep -v "scritto da scripts/publish-store.sh" | grep -v "Nello store pubblico l'immagine" > "$DEST/piu-live-catch/docker-compose.yml"
grep -q "${IMAGE}:${VERSION}@${DIGEST}" "$DEST/piu-live-catch/docker-compose.yml" || { echo "Sostituzione immagine non riuscita" >&2; exit 1; }
grep -q "^version: \"${VERSION}\"" "$DEST/piu-live-catch/umbrel-app.yml" || { echo "La versione del manifest non coincide con package.json ($VERSION)" >&2; exit 1; }
echo "Store preparato in $DEST per Live Catch ${VERSION} (${IMAGE}:${VERSION}@${DIGEST})"
