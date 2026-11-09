#!/usr/bin/env bash
# Aggiorna il digest dell'immagine base node:24-alpine nel Dockerfile.
set -euo pipefail
TAG="${1:-24-alpine}"
TOKEN="$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')"
DIGEST="$(curl -fsSI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "https://registry-1.docker.io/v2/library/node/manifests/$TAG" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')"
[[ "$DIGEST" == sha256:* ]] || { echo "Digest non trovato" >&2; exit 1; }
sed -i.bak -E "s|^ARG NODE_IMAGE=.*|ARG NODE_IMAGE=node:${TAG}@${DIGEST}|" Dockerfile && rm -f Dockerfile.bak
echo "Dockerfile aggiornato: node:${TAG}@${DIGEST}"
