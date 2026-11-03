#!/usr/bin/env bash
# Task 1: the API image is non-root, has no dev tools, and answers /api/health.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMG=sif-api:test
NAME=sif-api-imagetest
docker build -q -t "$IMG" backend >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

fail() { echo "FAIL: $*"; exit 1; }

uid=$(docker run --rm --entrypoint id "$IMG" -u)
[ "$uid" = 10001 ] || fail "runs as uid $uid, want 10001"
echo "PASS non-root (uid 10001)"

if docker run --rm --entrypoint python "$IMG" -c "import pytest" 2>/dev/null; then
  fail "dev dependency pytest is in the image"
fi
echo "PASS no dev dependencies"

docker run -d --name "$NAME" -e SHARED_PASSWORD=dummy-test-pass -e COOKIE_SECURE=false \
  --tmpfs /data:uid=10001,gid=10001 "$IMG" >/dev/null
probe='import urllib.request as u, json, sys
r = u.urlopen("http://127.0.0.1:8000/api/health")
print(json.dumps({"body": json.load(r), "server": r.headers.get("server")}))'
for _ in $(seq 30); do
  out=$(docker exec "$NAME" python -c "$probe" 2>/dev/null) && break
  sleep 1
done
[ -n "${out:-}" ] || { docker logs "$NAME" | tail -20; fail "no /api/health within 30 s"; }
[ "$out" = '{"body": {"ok": true}, "server": null}' ] || fail "health said $out"
echo "PASS health ok, no server header"
echo "ALL PASS"
