#!/bin/sh
# Copia di sicurezza dell'intera cartella dati (database, immagini, backup, chiave di cifratura).
# Uso: sh scripts/backup-volume.sh /percorso/cartella-dati /percorso/destinazione
set -e
SRC=${1:?cartella dati}
DST=${2:-.}
NAME="livecatch-volume-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$DST/$NAME" -C "$SRC" .
echo "Creato $DST/$NAME"
