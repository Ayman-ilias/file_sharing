#!/usr/bin/env bash
# A throwaway backend for the e2e flows: fresh data folder, dummy shared password, 1 MiB chunks.
set -euo pipefail
# the test runner may choose the folder (the vault flow reads it to prove no plaintext is stored)
DATA="${E2E_DATA_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/fs-e2e.XXXXXX")}"
trap 'rm -rf "$DATA"' EXIT
cd "$(dirname "$0")/../../backend"
export DATA_DIR="$DATA" SHARED_PASSWORD="e2e-shared-start-pw" COOKIE_SECURE=false CHUNK_SIZE=1048576 SERVE_FILES=true LOGIN_RATE_LIMIT=1000
exec uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8765 --no-server-header
