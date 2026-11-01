#!/usr/bin/env bash
# Refresh this repository from the two implementations of the wire contract,
# in the same monorepo: the root .. (TypeScript) and ../edge-setup (Go).
# Run it after either side changes the contract, then `bun run check`, then
# review the diff and bump SPEC.md / CHANGELOG.md.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
main="${OPENEDBOT_MAIN_DIR:-$root/..}"
edge="${EDGE_SETUP_DIR:-$root/../edge-setup}"
[ -d "$main/contracts/connector/src" ] || { echo "missing $main" >&2; exit 2; }
[ -d "$edge/test/golden" ] || { echo "missing $edge" >&2; exit 2; }

for f in relay-frames.ts relay-allowlist.ts a2a.ts index.ts; do
  cp "$main/contracts/connector/src/$f" "$root/connector/src/$f"
done
# The only workspace import of the contract: vendored as ./uuid.
sed -i.bak 's#from "@openedbot/contracts-primitives"#from "./uuid"#' "$root/connector/src/relay-frames.ts"
rm -f "$root/connector/src/relay-frames.ts.bak"

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
