#!/usr/bin/env bash
set -euo pipefail

# Offline contract for scripts/db.sh --pending, the prerequisite of make dev,
# dev-api and dev-worker. docker is faked; any call that is neither a read of
# schema_migrations nor the reachability probe is logged as a write.
#   1. Every migration applied: exit 0, nothing printed.
#   2. One migration missing: non-zero, names it and make db-migrate.
#   3. Database unreachable or container absent: non-zero, says so, and never
#      reports anything as pending.
#   In every case, nothing is written to the database.

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
fake_bin="$test_directory/bin"
mkdir -p "$fake_bin"
writes="$test_directory/writes"

fail() {
  printf 'db-pending contract failed: %s\n' "$1" >&2
  exit 1
}

cat > "$fake_bin/docker" <<'FAKE'
#!/bin/bash
case "$*" in
  inspect*) [ -z "${FAKE_NO_CONTAINER:-}" ] ;;
  *'"select 1"'*)
    if [ -n "${FAKE_UNREACHABLE:-}" ]; then
      printf 'psql: error: database "openedbot" does not exist\n' >&2
      exit 2
    fi
    ;;
  *"select version from schema_migrations"*)
    if [ -n "${FAKE_REGISTRY_UNREADABLE:-}" ]; then
      printf 'ERROR:  permission denied for table schema_migrations\n' >&2
      exit 1
    fi
    for file in "$FAKE_ROOT"/db/migrations/*.sql; do
      version="$(basename "$file" .sql)"
      [ "$version" = "${FAKE_MISSING:-}" ] || printf '%s\n' "$version"
    done
    ;;
  *) printf '%s\n' "$*" >> "$FAKE_WRITES" ;;
esac
FAKE
chmod +x "$fake_bin/docker"

run_pending() {
  : > "$writes"
  env -u OPENEDBOT_PLUGINS PATH="$fake_bin:/usr/bin:/bin" \
    FAKE_ROOT="$root" FAKE_WRITES="$writes" \
    OPENEDBOT_POSTGRES_CONTAINER=infra-postgres \
    API_DATABASE_URL=postgres://openedbot_api@127.0.0.1:5432/openedbot \
    "$@" /bin/bash scripts/db.sh --pending 2>&1
}

assert_no_write() {
  [ ! -s "$writes" ] || fail "$1 must write nothing; docker got: $(head -3 "$writes")"
}

# 1. Nothing pending.
output="$(run_pending)" || fail "nothing pending must exit 0; got: $output"
[ -z "$output" ] || fail "nothing pending must print nothing; got: $output"
assert_no_write "nothing pending"

# 2. The latest migration missing.
migrations=(db/migrations/*.sql)
latest="$(basename "${migrations[-1]}" .sql)"
if output="$(run_pending FAKE_MISSING="$latest")"; then fail "a pending migration must exit non-zero"; fi
printf '%s\n' "$output" | grep -qx "  $latest" || fail "the pending migration must be named; got: $output"
[[ "$output" == *"make db-migrate"* ]] || fail "the message must name make db-migrate; got: $output"
[ "$(printf '%s\n' "$output" | grep -c '^  ')" -eq 1 ] || fail "only $latest is pending; got: $output"
assert_no_write "a pending migration"

# 3. Unreachable database, absent container, unreadable registry: no false
#    "pending".
for case_env in FAKE_UNREACHABLE=1 FAKE_NO_CONTAINER=1 FAKE_REGISTRY_UNREADABLE=1; do
  if output="$(run_pending "$case_env")"; then fail "$case_env must exit non-zero"; fi
  [[ "$output" == *"Cannot check pending migrations"* ]] || fail "$case_env must say the check could not run; got: $output"
  [[ "$output" != *"has pending migrations"* ]] || fail "$case_env must not report migrations as pending; got: $output"
  assert_no_write "$case_env"
done

printf 'db-pending contract passed: silent when up to date, names a pending migration, never mistakes an unreachable database for one, writes nothing.\n'
