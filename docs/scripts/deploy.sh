#!/usr/bin/env bash
# Builds the public scope and deploys it to docs.openedbot.app (wrangler.toml).
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ALLOWED_NETS=... scripts/deploy.sh
# ALLOWED_NETS is the comma-separated list of addresses or CIDRs the IP gate
# serves (worker/gate.js); it is stored as a Worker secret through stdin and
# never committed. The token stays in the environment, never in argv. The
# build is checked (types, tests, links) before anything leaves, then /install
# is read back (from an allowed network) and compared with public/install.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || { echo "CLOUDFLARE_API_TOKEN is required" >&2; exit 2; }
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || { echo "CLOUDFLARE_ACCOUNT_ID is required" >&2; exit 2; }
[[ -n "${ALLOWED_NETS:-}" ]] || { echo "ALLOWED_NETS is required (the gate would refuse everyone)" >&2; exit 2; }
bun -e 'import { parseNets } from "./worker/gate.js"; if (parseNets(process.env.ALLOWED_NETS).length === 0) process.exit(1)' \
  || { echo "ALLOWED_NETS is not a valid list" >&2; exit 2; }
ORIGIN="${DOCS_ORIGIN:-https://docs.openedbot.app}"

bun install --frozen-lockfile
bun run check
bun test
DOCS_SCOPE=public bun run build
bun run check:links
bunx --bun wrangler@4 deploy
# The secret lands after the code: until then the new gate refuses everyone
# (fail closed), never the reverse. Written through stdin, never argv.
printf '%s' "$ALLOWED_NETS" | bunx --bun wrangler@4 secret put ALLOWED_NETS

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
