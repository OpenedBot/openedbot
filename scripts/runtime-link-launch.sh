#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_root"
# Un seul fichier depuis la consolidation (ENV_DIR_OF_SCOPE) : la racine
# porte aussi RUNTIME_LINK_PORT, que l'API portait avant.
set -a
if [ -f .env.local ]; then . .env.local; fi
set +a
# This process owns only the persistent gateway. API/worker cutover is separate.
export RUNTIME_LINK_MODE=separate
export RUNTIME_LINK_INTERNAL_URL="${RUNTIME_LINK_INTERNAL_URL:-http://127.0.0.1:${RUNTIME_LINK_PORT:-8791}}"
exec "${1:?Bun executable path is required}" apps/link-gateway/src/main.ts
