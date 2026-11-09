#!/usr/bin/env bash
# Test reale di avvio del container (usato dalla CI, eseguibile ovunque ci sia Docker).
#
#   scripts/container-smoke.sh <immagine> [piattaforma]
#   es. scripts/container-smoke.sh livecatch:smoke linux/arm64
#
# Avvia l'immagine come su Umbrel (utente 1000:1000, volume /data, password
# iniziale da variabile) e verifica: HEALTHCHECK "healthy", /health, pagine,
# API protette, login + cambio password, backup, file di proprietà UID 1000,
# persistenza dopo il riavvio, assenza della password nei log, errore chiaro
# con un volume non scrivibile.
set -euo pipefail

IMAGE="${1:?Uso: $0 <immagine> [piattaforma]}"
PLATFORM="${2:-linux/amd64}"
PORT="${SMOKE_PORT:-18788}"
NAME="livecatch-smoke-$$"
WORK="$(mktemp -d)"
DATA="$WORK/data"
JAR="$WORK/cookies.txt"
BASE="http://127.0.0.1:${PORT}"
UA="LiveCatch-Smoke/1.0"
PW="Smoke$(openssl rand -hex 8)9"
NEWPW="Nuova$(openssl rand -hex 8)7"

fail() { echo "❌ $*" >&2; docker logs "$NAME" 2>&1 | tail -n 60 >&2 || true; exit 1; }
ok() { echo "✅ $*"; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker rm -f "${NAME}-ro" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || sudo rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$DATA"
# Come Umbrel: la cartella dati dell'app appartiene a 1000:1000.
docker run --rm --platform "$PLATFORM" --user 0 --entrypoint chown -v "$DATA:/data" "$IMAGE" 1000:1000 /data

start() {
  docker run -d --name "$NAME" --platform "$PLATFORM" --user 1000:1000 --init \
    -e DATA_DIR=/data -e ADMIN_INITIAL_PASSWORD="$PW" -e TZ=Europe/Rome -e TRUSTED_PROXIES=docker-gateway \
    -v "$DATA:/data" -p "127.0.0.1:${PORT}:8080" "$IMAGE" >/dev/null
}

wait_healthy() {
  local deadline=$((SECONDS + ${1:-180}))
  while (( SECONDS < deadline )); do
    local st
    st="$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)"
    [[ "$st" == "healthy" ]] && return 0
    [[ "$(docker inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null)" == "false" ]] && fail "il container si è fermato"
    sleep 2
  done
  fail "HEALTHCHECK non è diventato healthy in tempo"
}

http() { curl -sS -A "$UA" -o "$WORK/body" -w '%{http_code}' "$@"; }
expect() { local want="$1"; shift; local got; got="$(http "$@")"; [[ "$got" == "$want" ]] || fail "$* → HTTP $got (atteso $want): $(head -c 300 "$WORK/body")"; }

echo "▶ Immagine $IMAGE ($PLATFORM)"
start
wait_healthy 240
ok "HEALTHCHECK: healthy"

expect 200 "$BASE/health"
grep -q '"status":"ok"' "$WORK/body" || fail "/health non ok"
grep -q '"db":"ok"' "$WORK/body" || fail "/health: database non ok"
ok "/health: $(cat "$WORK/body")"
expect 200 "$BASE/admin/"
expect 200 "$BASE/overlay"
expect 200 "$BASE/api/public/overlay"
expect 401 "$BASE/api/admin/overview"
ok "pagine servite, API admin protette"

expect 200 -c "$JAR" -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\"}" "$BASE/api/auth/login"
CSRF="$(sed -E 's/.*"csrf":"([^"]+)".*/\1/' "$WORK/body")"
[[ -n "$CSRF" ]] || fail "token CSRF mancante"
expect 403 -b "$JAR" "$BASE/api/admin/overview"
expect 200 -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -H "Origin: $BASE" \
  -d "{\"currentPassword\":\"$PW\",\"newPassword\":\"$NEWPW\"}" "$BASE/api/auth/change-password"
expect 200 -b "$JAR" "$BASE/api/admin/overview"
expect 403 -b "$JAR" -X POST -H "X-CSRF-Token: $CSRF" -H 'Origin: http://evil.example' "$BASE/api/admin/backups"
expect 200 -b "$JAR" -X POST -H "X-CSRF-Token: $CSRF" -H "Origin: $BASE" "$BASE/api/admin/backups"
BACKUP="$(sed -E 's/.*"filename":"([^"]+)".*/\1/' "$WORK/body")"
ok "login, cambio password, CSRF/Origin, backup $BACKUP"

OWNER="$(docker exec "$NAME" stat -c '%u:%g' /data/db/livecatch.sqlite)"
[[ "$OWNER" == "1000:1000" ]] || fail "database di proprietà $OWNER (atteso 1000:1000)"
docker exec "$NAME" test -f "/data/backups/$BACKUP" || fail "file di backup assente"
docker exec "$NAME" test -f /data/secret.key || fail "secret.key assente"
[[ "$(docker exec "$NAME" id -u)" == "1000" ]] || fail "il processo non gira come UID 1000"
ok "file nel volume di proprietà 1000:1000, processo non privilegiato"

docker restart -t 15 "$NAME" >/dev/null
wait_healthy 240
expect 401 -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\"}" "$BASE/api/auth/login"
expect 200 -c "$JAR" -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$NEWPW\"}" "$BASE/api/auth/login"
grep -q '"mustChangePassword":false' "$WORK/body" || fail "dopo il riavvio la password cambiata non è stata mantenuta"
expect 200 -b "$JAR" "$BASE/api/admin/backups"
grep -q "$BACKUP" "$WORK/body" || fail "backup non presente dopo il riavvio"
ok "riavvio: dati, password e backup conservati"

if docker logs "$NAME" 2>&1 | grep -q -e "$PW" -e "$NEWPW"; then fail "password presente nei log del container"; fi
if docker exec "$NAME" grep -rq -e "$PW" -e "$NEWPW" /data/logs; then fail "password presente nei file di log"; fi
ok "nessuna password nei log"

docker stop -t 15 "$NAME" >/dev/null
CODE="$(docker inspect --format '{{.State.ExitCode}}' "$NAME")"
[[ "$CODE" == "0" ]] || fail "arresto non pulito (exit $CODE)"
ok "arresto pulito con SIGTERM"

# Volume non scrivibile: deve fallire subito con un messaggio chiaro.
RO="$WORK/ro"; mkdir -p "$RO"
docker run --rm --platform "$PLATFORM" --user 0 --entrypoint chown -v "$RO:/data" "$IMAGE" 0:0 /data
set +e
docker run --name "${NAME}-ro" --platform "$PLATFORM" --user 1000:1000 -e DATA_DIR=/data -v "$RO:/data" "$IMAGE" > "$WORK/ro.log" 2>&1
RC=$?
set -e
[[ $RC -ne 0 ]] || fail "con un volume non scrivibile il container non dovrebbe avviarsi"
grep -q "non è scrivibile" "$WORK/ro.log" || fail "messaggio di errore non chiaro: $(cat "$WORK/ro.log")"
ok "volume non scrivibile: errore chiaro (exit $RC)"

echo "🎉 Test del container superato ($PLATFORM)"
