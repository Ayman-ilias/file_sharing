#!/usr/bin/env bash
# Task 2: bring the whole stack up exactly as on the VM (settings only in $SIF_HOME/.env,
# compose run with --env-file) and smoke-test it through nginx. Runs inside the Colima Linux VM
# so file ownership behaves as on the server.
# Usage: bash deploy/tests/stack.sh [--keep | --serve | --down]
#   --serve  start a fresh stack on port 5056 for the browser check and leave it running
#   --down   remove the --serve stack
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "$(uname -s)" = Darwin ]; then
  exec colima ssh -- bash "$REPO/deploy/tests/stack.sh" "$@"
fi
KEEP="${1:-}"
PASSWORD=smoke-pass-12345
if [ "$KEEP" = --serve ] || [ "$KEEP" = --down ]; then
  HOME_DIR=/tmp/sif-browser PORT=5056 PROJECT=sif-browser
else
  HOME_DIR="$(mktemp -d /tmp/sif-smoke.XXXXXX)" PORT=5055 PROJECT=sif-smoke
fi
compose() { docker compose --env-file "$HOME_DIR/.env" -p "$PROJECT" -f "$REPO/deploy/compose.yaml" "$@"; }
cleanup() {
  [ "$KEEP" = --keep ] && { echo "kept: SIF_HOME=$HOME_DIR port $PORT"; return; }
  [ "$KEEP" = --serve ] && return
  compose down >/dev/null 2>&1 || true
  sudo rm -rf "$HOME_DIR"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; compose logs --tail 30 || true; exit 1; }

write_env() {  # $1 = TRUSTED_PROXIES, $2 = LOGIN_RATE_LIMIT (default 5)
  cat > "$HOME_DIR/.env" <<ENV
SIF_HOME=$HOME_DIR
SHARED_PASSWORD=$PASSWORD
COOKIE_SECURE=false
LOGIN_RATE_LIMIT=${2:-5}
PUBLIC_PORT=$PORT
TRUSTED_PROXIES=$1
ENV
  chmod 600 "$HOME_DIR/.env"
}

wait_up() {
  for _ in $(seq 90); do
    st=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)
    [ "$st" = "$1" ] && return 0
    sleep 2
  done
  fail "port $PORT never answered $1 (last: ${st:-none})"
}

if [ "$KEEP" = --down ]; then
  exit 0  # the EXIT trap removes the stack and its folder
fi
if [ "$KEEP" = --serve ]; then
  compose down >/dev/null 2>&1 || true
  sudo rm -rf "$HOME_DIR"
fi
mkdir -p "$HOME_DIR/data" "$HOME_DIR/backups"
sudo chown 10001:10001 "$HOME_DIR/data" "$HOME_DIR/backups"
if [ "$KEEP" = --serve ]; then
  write_env "0.0.0.0/0" 1000
  compose up -d --build --wait --wait-timeout 180 >/dev/null || fail "compose up"
  wait_up 200
  echo "SERVING http://127.0.0.1:$PORT"
  exit 0
fi
write_env "0.0.0.0/0"
compose up -d --build --wait --wait-timeout 180 >/dev/null || fail "compose up"
wait_up 200
python3 "$REPO/deploy/tests/smoke.py" --base "http://127.0.0.1:$PORT" --password "$PASSWORD" \
  || fail "smoke checks"

# The allowlist comes from .env alone: an untrusted client gets 403 everywhere.
write_env "203.0.113.9"
compose up -d --wait --wait-timeout 120 >/dev/null || fail "compose up (allowlist run)"
wait_up 403
st=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$st" = 403 ] || fail "untrusted client got $st on /"
echo "PASS untrusted client → 403 (TRUSTED_PROXIES read from .env)"

# A typo in TRUSTED_PROXIES stops nginx with a message naming the bad entry.
write_env "10.10.8.100 10.10.8.1OO"
compose up -d >/dev/null 2>&1 || true
sleep 5
compose logs web 2>&1 | grep -q "TRUSTED_PROXIES: not an IP or CIDR: 10.10.8.1OO" \
  || fail "a bad TRUSTED_PROXIES entry was not reported"
echo "PASS bad TRUSTED_PROXIES entry is refused with a clear message"
echo "STACK ALL PASS"
