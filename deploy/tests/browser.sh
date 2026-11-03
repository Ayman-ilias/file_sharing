#!/usr/bin/env bash
# Task 3: the real app in Chrome against the production stack (nginx + API) in the Colima VM.
# Runs on the Mac; Colima forwards the stack's port to 127.0.0.1.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
trap 'bash "$REPO/deploy/tests/stack.sh" --down >/dev/null 2>&1 || true' EXIT
bash "$REPO/deploy/tests/stack.sh" --serve
for _ in $(seq 30); do
  curl -sf http://127.0.0.1:5056/api/health >/dev/null && break
  sleep 1
done
cd "$REPO/frontend"
DEPLOY_BASE_URL=http://127.0.0.1:5056 DEPLOY_SHARED_PASSWORD=smoke-pass-12345 \
  npx playwright test -c playwright.deploy.config.ts
