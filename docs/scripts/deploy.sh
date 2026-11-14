#!/usr/bin/env bash
# Builds the public scope and deploys it to docs.openedbot.app (wrangler.toml).
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... scripts/deploy.sh
# The token stays in the environment, never in argv. The build is checked
# (types, tests, links) before anything leaves, then /install is read back
# from the public origin and compared with public/install.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || { echo "CLOUDFLARE_API_TOKEN is required" >&2; exit 2; }
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || { echo "CLOUDFLARE_ACCOUNT_ID is required" >&2; exit 2; }
ORIGIN="${DOCS_ORIGIN:-https://docs.openedbot.app}"

bun install --frozen-lockfile
bun run check
bun test
DOCS_SCOPE=public bun run build
bun run check:links
bunx --bun wrangler@4 deploy

served="$(mktemp)"
trap 'rm -f "$served"' EXIT
for attempt in 1 2 3 4 5 6; do
  if curl -fsS -H 'Cache-Control: no-cache' "$ORIGIN/install?deploy=$(date +%s)" -o "$served" \
    && cmp -s "$served" public/install; then
    echo "$ORIGIN/install matches public/install"
    exit 0
  fi
  sleep 10
done
echo "$ORIGIN/install does not serve public/install after deploy" >&2
exit 1
