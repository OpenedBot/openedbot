#!/usr/bin/env bash
set -euo pipefail

# Offline contract of the hosted-console guard (step 9). Nothing is built:
# the wiring is read with `make -n`, and the only real run is the refusal,
# which stops before any build.
#   1. `make build` with the console and an empty OPENEDBOT_CONSOLE_PLUGINS runs the
#      guard BEFORE build-console, and really refuses (exit 2, no build).
#   2. OPENEDBOT_CONSOLE_PLUGINS set, or OPENEDBOT_CONSOLE_MODE=solo: the guard lets it through.
#   3. `make build APP=admin` (no console) has no guard.

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

fail() {
  printf 'console build guard contract failed: %s\n' "$1" >&2
  exit 1
}

# Every case names both variables on the command line: an env file or the
# caller's shell cannot leak a list in.
plan="$(make -n build APP=console OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODE= 2>/dev/null || true)"
guard_line="$(printf '%s\n' "$plan" | grep -n 'OPENEDBOT_CONSOLE_PLUGINS vide' | head -n 1 | cut -d: -f1 || true)"
build_line="$(printf '%s\n' "$plan" | grep -n 'bun run --filter console build' | head -n 1 | cut -d: -f1 || true)"
[ -n "$guard_line" ] || fail "make build does not run prod-console-guard"
[ -n "$build_line" ] || fail "make build no longer builds the console"
[ "$guard_line" -lt "$build_line" ] || fail "the guard runs after build-console"

set +e
refusal="$(make --no-print-directory prod-console-guard OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODE= 2>&1)"
status=$?
set -e
[ "$status" -eq 2 ] || fail "an empty OPENEDBOT_CONSOLE_PLUGINS is not refused (status $status)"
printf '%s' "$refusal" | grep -q 'OPENEDBOT_CONSOLE_PLUGINS vide' || fail "the refusal does not name OPENEDBOT_CONSOLE_PLUGINS"

make --no-print-directory prod-console-guard OPENEDBOT_CONSOLE_PLUGINS=/fixture/console/index.ts OPENEDBOT_CONSOLE_MODE= >/dev/null 2>&1 \
  || fail "a set OPENEDBOT_CONSOLE_PLUGINS is refused"
make --no-print-directory prod-console-guard OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODE=solo >/dev/null 2>&1 \
  || fail "OPENEDBOT_CONSOLE_MODE=solo is refused"

# A retired OHB_* name is refused before any target, naming it, never read.
set +e
legacy="$(env -u OPENEDBOT_CONSOLE_MODE OHB_CONSOLE_SOLO=1 make --no-print-directory prod-console-guard OPENEDBOT_CONSOLE_PLUGINS=/fixture/console/index.ts 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "the retired OHB_CONSOLE_SOLO is not refused"
printf '%s' "$legacy" | grep -q 'retired OHB_ prefix is no longer read: OHB_CONSOLE_SOLO' || fail "the refusal does not name OHB_CONSOLE_SOLO"

admin_plan="$(make -n build APP=admin OPENEDBOT_CONSOLE_PLUGINS= OPENEDBOT_CONSOLE_MODE= 2>/dev/null || true)"
printf '%s' "$admin_plan" | grep -q 'OPENEDBOT_CONSOLE_PLUGINS vide' && fail "make build APP=admin runs the console guard"

printf 'console build guard contract passed.\n'
