#!/usr/bin/env bash
set -euo pipefail

# Offline contract of the hosted-console guard (step 9). Nothing is built:
# the wiring is read with `make -n`, and the only real run is the refusal,
# which stops before any build.
#   1. `make build` with the console and an empty OHB_PRO_CONSOLE runs the
#      guard BEFORE build-console, and really refuses (exit 2, no build).
#   2. OHB_PRO_CONSOLE set, or OHB_CONSOLE_SOLO=1: the guard lets it through.
#   3. `make build APP=admin` (no console) has no guard.

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

fail() {
  printf 'console build guard contract failed: %s\n' "$1" >&2
  exit 1
}

# Every case names both variables on the command line: an env file or the
# caller's shell cannot leak a list in.
plan="$(make -n build APP=console OHB_PRO_CONSOLE= OHB_CONSOLE_SOLO= 2>/dev/null || true)"
guard_line="$(printf '%s\n' "$plan" | grep -n 'OHB_PRO_CONSOLE vide' | head -n 1 | cut -d: -f1 || true)"
build_line="$(printf '%s\n' "$plan" | grep -n 'bun run --filter console build' | head -n 1 | cut -d: -f1 || true)"
[ -n "$guard_line" ] || fail "make build does not run prod-console-guard"
[ -n "$build_line" ] || fail "make build no longer builds the console"
[ "$guard_line" -lt "$build_line" ] || fail "the guard runs after build-console"

set +e
refusal="$(make --no-print-directory prod-console-guard OHB_PRO_CONSOLE= OHB_CONSOLE_SOLO= 2>&1)"
status=$?
set -e
[ "$status" -eq 2 ] || fail "an empty OHB_PRO_CONSOLE is not refused (status $status)"
printf '%s' "$refusal" | grep -q 'OHB_PRO_CONSOLE vide' || fail "the refusal does not name OHB_PRO_CONSOLE"

make --no-print-directory prod-console-guard OHB_PRO_CONSOLE=/fixture/console/index.ts OHB_CONSOLE_SOLO= >/dev/null 2>&1 \
  || fail "a set OHB_PRO_CONSOLE is refused"
make --no-print-directory prod-console-guard OHB_PRO_CONSOLE= OHB_CONSOLE_SOLO=1 >/dev/null 2>&1 \
  || fail "OHB_CONSOLE_SOLO=1 is refused"

admin_plan="$(make -n build APP=admin OHB_PRO_CONSOLE= OHB_CONSOLE_SOLO= 2>/dev/null || true)"
printf '%s' "$admin_plan" | grep -q 'OHB_PRO_CONSOLE vide' && fail "make build APP=admin runs the console guard"

printf 'console build guard contract passed.\n'
