#!/usr/bin/env bash
# Task 4: sif.sh exactly as the owner will use it on the VM (root, folder layout
# <home>/app = git checkout, <home>/.env, data/, backups/). Runs inside the Colima Linux VM.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "$(uname -s)" = Darwin ]; then
  exec colima ssh -- bash "$REPO/deploy/tests/ops.sh" "$@"
fi
H=/tmp/sif-ops
PORT=5057
SIF="sudo $H/app/deploy/sif.sh"
fail() { echo "FAIL: $*"; exit 1; }
cleanup() {
  sudo docker compose -p southern-iot-files --env-file "$H/.env" -f "$H/app/deploy/compose.yaml" \
    down >/dev/null 2>&1 || true
  sudo rm -rf "$H"
}
trap cleanup EXIT; [ "${KEEP:-}" = 1 ] && trap - EXIT
cleanup

# app/ = a clean checkout of HEAD plus this working tree's deploy/ folder (committed in the copy)
git clone -q "$REPO" "$H/app"
rsync -a --delete "$REPO/deploy/" "$H/app/deploy/"
git -C "$H/app" add -A
git -C "$H/app" -c user.email=t@t -c user.name=t commit -q -m "test copy" --allow-empty
# .env made the way the runbook says (from .env.example), then adjusted for this test
install -m 644 "$H/app/deploy/.env.example" "$H/.env"
sed -i "s/^SHARED_PASSWORD=.*/SHARED_PASSWORD=ops-pass-12345/; s/^PUBLIC_PORT=.*/PUBLIC_PORT=$PORT/;
        s#^TRUSTED_PROXIES=.*#TRUSTED_PROXIES=0.0.0.0/0#; s/^LOGIN_RATE_LIMIT=.*/LOGIN_RATE_LIMIT=1000/" "$H/.env"
echo "COOKIE_SECURE=false" >> "$H/.env"
chmod 644 "$H/.env"
py() { python3 -c "import sys; sys.path.insert(0, '$REPO/deploy/tests'); import smoke
c = smoke.sign_in('http://127.0.0.1:$PORT', 'ops-pass-12345', 'ops1@southerniot.net')
$1"; }
send_text() { py "st, _ = c.json('POST', '/api/items/text', {'body': '$1', 'is_global': True}); assert st == 201, st"; }
listed() { py "st, page = c.json('GET', '/api/items?section=global'); print(' '.join(i.get('text_body') or '' for i in page['items']))"; }

# 1. refuses a readable .env
out=$($SIF up 2>&1) && fail "up accepted a .env with mode 644"
grep -q "chmod 600" <<<"$out" || fail "no chmod 600 hint: $out"
echo "PASS refuses .env that others can read"
sudo chown root:root "$H/.env"; sudo chmod 600 "$H/.env"

# 2. first start from a root-owned empty data folder
sudo mkdir -p "$H/data"
out=$($SIF up 2>&1) || { echo "$out" | tail -20; fail "up"; }
grep -q "UP on port $PORT" <<<"$out" || fail "no UP line: $out"
[ "$(sudo stat -c %u "$H/data")" = 10001 ] || fail "data/ not owned by 10001"
[ "$(sudo stat -c %a "$H/backups")" = 700 ] || fail "backups/ not mode 700"
echo "PASS up from a root-owned empty data folder"

$SIF status | grep -q '"ok":true\|"ok": true' || fail "status has no health"
echo "PASS status shows health"

# 3. backup, then restore brings the database back to that moment
send_text "before-backup"
out=$($SIF backup) || fail "backup"
arch=$(sudo bash -c "ls -1t $H/backups/sif-*.tar.gz | head -1")
sudo tar tzf "$arch" | grep -x "app.db" >/dev/null || fail "archive has no app.db"
sudo tar tzf "$arch" | grep "^vault/" >/dev/null || fail "archive has no vault/"
echo "PASS backup archive has app.db and vault/"
send_text "after-backup"
listed | grep -q after-backup || fail "second text not listed"
$SIF restore "$arch" >/dev/null || fail "restore"
l=$(listed)
grep -q before-backup <<<"$l" || fail "restore lost the backed-up item: $l"
grep -q after-backup <<<"$l" && fail "restore kept a later item: $l"
echo "PASS restore returns to the backup"

# 4. update keeps data
send_text "kept-across-update"
$SIF update HEAD | grep -q "UP on port $PORT" || fail "update"
listed | grep -q kept-across-update || fail "update lost data"
echo "PASS update keeps data"

# 5. the allowlist comes from .env through sif.sh
sudo sed -i 's#^TRUSTED_PROXIES=.*#TRUSTED_PROXIES=203.0.113.9#' "$H/.env"
$SIF up >/dev/null 2>&1 || true
st=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$st" = 403 ] || fail "TRUSTED_PROXIES in .env ignored by sif.sh (got $st)"
echo "PASS TRUSTED_PROXIES in .env is used"

# 6. backup retention: at most 14 archives
for i in $(seq 16); do sudo touch -d "-$i hours" "$H/backups/sif-old-$i.tar.gz"; done
$SIF backup >/dev/null
n=$(sudo bash -c "ls -1 $H/backups/sif-*.tar.gz | wc -l")
[ "$n" -le 14 ] || fail "$n archives kept"
echo "PASS keeps at most 14 archives"
echo "OPS ALL PASS"
