#!/usr/bin/env bash
# Refresh the copied parts of this directory from the monorepo: the tests of
# the root .. (platform/hermes/tests/transport) and the golden files and spec
# of ../edge-setup (Go). The codec itself (connector/src) is NOT copied: it is
# the source of truth, and the root's contracts/connector re-exports it.
# Run it after either side changes the contract, then `bun run check`, then
# review the diff and bump SPEC.md / CHANGELOG.md.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
main="${OPENEDBOT_MAIN_DIR:-$root/..}"
edge="${EDGE_SETUP_DIR:-$root/../edge-setup}"
[ -d "$main/platform/hermes/tests/transport" ] || { echo "missing $main" >&2; exit 2; }
[ -d "$edge/test/golden" ] || { echo "missing $edge" >&2; exit 2; }

for f in relay-frames.test.ts relay-allowlist.test.ts relay-frames-audit.test.ts; do
  sed 's#from "@openedbot/contracts-connector"#from "../src/index"#' \
    "$main/platform/hermes/tests/transport/$f" > "$root/connector/tests/$f"
done
cp "$edge/test/golden/relay-frames/vectors.json" "$root/connector/fixtures/relay-frames.vectors.json"
cp "$edge/test/golden/relay-allowlist/allowlist.json" "$root/connector/fixtures/relay-allowlist.json"

{
  sed -n '1,/^<!-- spec-body -->$/p' "$root/SPEC.md"
  cat "$edge/docs/CONNECTOR.md"
} > "$root/SPEC.md.new"
mv "$root/SPEC.md.new" "$root/SPEC.md"
echo "synced from $main and $edge"
