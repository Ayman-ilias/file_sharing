#!/usr/bin/env bash
# Southern IoT Files v2 — the one command for running it on the VM (run as root).
# Layout: <home>/app = this git checkout, <home>/.env, <home>/data, <home>/backups.
# See deploy/RUNBOOK.md.
set -euo pipefail

APP="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
export SIF_HOME="${SIF_HOME:-$(dirname "$APP")}"
ENV_FILE="$SIF_HOME/.env"
DATA="$SIF_HOME/data"
BACKUPS="$SIF_HOME/backups"
APP_UID=10001
KEEP_ARCHIVES=14
KEEP_BYTES=$((5 * 1024 * 1024 * 1024))

compose() {
  docker compose --env-file "$ENV_FILE" -p southern-iot-files -f "$APP/deploy/compose.yaml" "$@"
}
die() { echo "sif: $*" >&2; exit 1; }
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d "\"'"; }

check_env() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. Create it: install -m 600 $APP/deploy/.env.example $ENV_FILE"
  [ "$(stat -c %a "$ENV_FILE")" = 600 ] || die "$ENV_FILE can be read by others. Run: chmod 600 $ENV_FILE"
  [ -n "$(setting SHARED_PASSWORD)" ] || die "SHARED_PASSWORD is empty in $ENV_FILE"
}

cmd_up() {
  check_env
  mkdir -p "$DATA" "$BACKUPS"
  chown "$APP_UID:$APP_UID" "$DATA" "$BACKUPS"
  chmod 700 "$BACKUPS"
  if ! compose up -d --build --remove-orphans --wait --wait-timeout 180; then
    compose ps
    echo "--- api log (web waits for a healthy api) ---"
    compose logs --tail 40 api
    echo "--- web log ---"
    compose logs --tail 20 web
    die "did not start; see the logs above"
  fi
  echo "UP on port $(setting PUBLIC_PORT | grep . || echo 5000)"
}

cmd_status() {
  compose ps
  echo -n "health: "
  docker exec sif-web wget -qO- http://127.0.0.1:8080/api/health || echo "NOT ANSWERING"
  echo
}

cmd_update() {
  local ref="${1:-}" old
  [ -n "$ref" ] || die "usage: sif.sh update <tag or branch>, e.g. sif.sh update v2.0.1"
  [ -z "$(git -C "$APP" status --porcelain)" ] || die "$APP has local changes; not updating"
  old=$(git -C "$APP" rev-parse --short HEAD)
  git -C "$APP" fetch -q --tags origin 2>/dev/null || git -C "$APP" fetch -q --tags
  git -C "$APP" checkout -q "$ref"
  echo "code: $old -> $(git -C "$APP" rev-parse --short HEAD) ($ref)"
  cmd_up
}

cmd_backup() {
  local stamp name
  stamp=$(date -u +%Y-%m-%d-%H%M%S)
  name="sif-$stamp.tar.gz"
  # A consistent copy of the live database (SQLite online backup) + My storage files.
  docker exec -i sif-api python - "$name" <<'PY'
import os, sqlite3, sys, tarfile
name = sys.argv[1]
tmp = f"/backups/.tmp-{name}"
src = sqlite3.connect("file:/data/app.db?mode=ro", uri=True)
dst = sqlite3.connect(tmp)
src.backup(dst)
dst.close(); src.close()
part = f"/backups/.{name}.part"
with tarfile.open(part, "w:gz") as tar:
    tar.add(tmp, arcname="app.db")
    tar.add("/data/vault", arcname="vault")
os.remove(tmp)
os.rename(part, f"/backups/{name}")
PY
  # keep the newest $KEEP_ARCHIVES, and at most $KEEP_BYTES in total
  local n=0 total=0 size f
  while IFS= read -r f; do
    size=$(stat -c %s "$f")
    n=$((n + 1)); total=$((total + size))
    if [ "$n" -gt "$KEEP_ARCHIVES" ] || { [ "$n" -gt 1 ] && [ "$total" -gt "$KEEP_BYTES" ]; }; then
      rm -f "$f"
    fi
  done < <(ls -1t "$BACKUPS"/sif-*.tar.gz)
  echo "backup: $BACKUPS/$name ($(du -h "$BACKUPS/$name" | cut -f1))"
}

cmd_restore() {
  local arch="${1:-}" stamp aside
  [ -f "$arch" ] || die "usage: sif.sh restore $BACKUPS/sif-<date>.tar.gz"
  tar tzf "$arch" | grep -x app.db >/dev/null || die "$arch has no app.db"
  stamp=$(date -u +%Y-%m-%d-%H%M%S)
  aside="$BACKUPS/before-restore-$stamp"
  compose down
  mkdir -p "$aside"
  # the old database (with its WAL files) and vault are set aside, never deleted
  for f in app.db app.db-wal app.db-shm vault; do
    [ -e "$DATA/$f" ] && mv "$DATA/$f" "$aside/"
  done
  tar xzf "$arch" -C "$DATA" app.db vault
  chown -R "$APP_UID:$APP_UID" "$DATA"
  echo "restored $arch (previous database and vault moved to $aside)"
  cmd_up
}

case "${1:-}" in
  up) cmd_up ;;
  down) compose down ;;
  status) cmd_status ;;
  logs) shift; compose logs --tail 200 -f "$@" ;;
  update) shift; cmd_update "$@" ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  *) echo "usage: sif.sh up | down | status | logs [web|api] | update <tag> | backup | restore <archive>"; exit 2 ;;
esac
