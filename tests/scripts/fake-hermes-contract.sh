#!/usr/bin/env bash
# The fake gateway's address and bearer live in tests/fake-hermes/defaults.ts.
# The Makefile and scripts/setup.sh cannot import a TypeScript module without
# paying a Bun start on every invocation, so they keep their own literal. This
# contract fails when a copy drifts.
#
# What drift costs: Makefile's FAKE_HERMES_URL is what decides whether an
# existing .env.local *is* the fake profile (see the MODE resolution at the top
# of the Makefile). A port changed on one side only makes `make dev` silently
# pick the `external` profile against a gateway nobody started.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

failures=0

expect() {
  local label="$1" want="$2" got="$3"
  if [ "$want" != "$got" ]; then
    printf 'fake-hermes-contract: %s is %s, tests/fake-hermes/defaults.ts says %s.\n' "$label" "$got" "$want" >&2
    failures=$((failures + 1))
  fi
}

# `\?` est une extension GNU : le sed de BSD (macOS) la lit littéralement et
# l'expression ne rend rien, faisant échouer ce contrat sur tout poste macOS.
# `\{0,1\}` est le même « zéro ou un » en BRE POSIX, compris des deux.
ts_value() {
  sed -n "s/^export const $1 = \"\\{0,1\\}\([^\";]*\)\"\\{0,1\\};/\1/p" tests/fake-hermes/defaults.ts
}

want_host="$(ts_value FAKE_HERMES_HOST)"
want_port="$(ts_value FAKE_HERMES_PORT)"
want_token="$(ts_value FAKE_HERMES_TOKEN)"
want_url="http://${want_host}:${want_port}"

for name in want_host want_port want_token; do
  if [ -z "${!name}" ]; then
    printf 'fake-hermes-contract: could not read %s from tests/fake-hermes/defaults.ts.\n' "$name" >&2
    exit 1
  fi
done

expect "Makefile FAKE_HERMES_URL" "$want_url" \
  "$(sed -n 's/^FAKE_HERMES_URL := //p' Makefile)"

expect "scripts/setup.sh fake_hermes_host" "$want_host" \
  "$(sed -n 's/^fake_hermes_host="\(.*\)"$/\1/p' scripts/setup.sh)"

expect "scripts/setup.sh fake_hermes_port" "$want_port" \
  "$(sed -n 's/^fake_hermes_port="${FAKE_HERMES_PORT:-\(.*\)}"$/\1/p' scripts/setup.sh)"

expect "scripts/setup.sh fake_hermes_default_token" "$want_token" \
  "$(sed -n 's/^fake_hermes_default_token="\(.*\)"$/\1/p' scripts/setup.sh)"

# The help line of `make fake-hermes` quotes the address to the developer; a
# stale one sends them to a port nothing listens on.
if ! grep -q "fake-hermes:.*${want_host}:${want_port}" Makefile; then
  printf 'fake-hermes-contract: the `make fake-hermes` help line does not quote %s:%s.\n' "$want_host" "$want_port" >&2
  failures=$((failures + 1))
fi

# No literal may reappear beside the module.
strays="$(grep -rn --include='*.ts' -e "$want_port" -e "$want_token" tests/fake-hermes \
  | grep -v '^tests/fake-hermes/defaults.ts:' || true)"
if [ -n "$strays" ]; then
  printf 'fake-hermes-contract: literal address or token outside defaults.ts:\n%s\n' "$strays" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  printf 'fake-hermes-contract: %d divergence(s).\n' "$failures" >&2
  exit 1
fi
printf 'fake-hermes address contract passed.\n'
