#!/bin/sh
# Installazione/aggiornamento manuale (metodo B) su Umbrel OS via SSH.
# Uso:  sh scripts/install-umbrel-ssh.sh
# Esegui dalla cartella del progetto clonato (es. ~/livecatch).
set -e
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  cp .env.example .env
  PW=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)
  sed -i "s/^ADMIN_INITIAL_PASSWORD=.*/ADMIN_INITIAL_PASSWORD=$PW/" .env
  echo "Creato .env — password iniziale admin: $PW (ti verrà chiesto di cambiarla)"
fi
mkdir -p data
# La cartella dati deve appartenere all'utente 1000 (utente del container).
sudo chown -R 1000:1000 data
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only || echo "Attenzione: git pull non riuscito, continuo con il codice locale"
fi
sudo docker compose up -d --build
echo
echo "Fatto. Apri http://$(hostname -I 2>/dev/null | awk '{print $1}'):$(grep ^HOST_PORT .env | cut -d= -f2)/admin"
