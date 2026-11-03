#!/usr/bin/env bash
set -euo pipefail

# Offline contract for scripts/db.sh --reset: the reset must refuse without
# --yes before touching docker, and its plan must be a
# drop/create of the single openedbot database in the shared container,
# never a `docker compose down -v` of anything.

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
fake_bin="$test_directory/bin"
mkdir -p "$fake_bin"

fail() {
  printf 'db-reset contract failed: %s\n' "$1" >&2
  exit 1
}

# Any docker invocation is a contract failure: it is recorded and refused.
printf '%s\n' \
  '#!/bin/bash' \
  'printf "docker %s\n" "$*" >> "$FAKE_DOCKER_EVENTS"' \
  'exit 97' \
  > "$fake_bin/docker"
chmod +x "$fake_bin/docker"
docker_events="$test_directory/docker-events"
: > "$docker_events"

run_reset() {
  PATH="$fake_bin:/usr/bin:/bin" \
    FAKE_DOCKER_EVENTS="$docker_events" \
    OPENEDBOT_POSTGRES_CONTAINER=infra-postgres \
    API_DATABASE_URL=postgres://openedbot_api@127.0.0.1:5432/ohb \
    /bin/bash scripts/db.sh --reset "$@"
}

assert_no_docker_call() {
  if [ -s "$docker_events" ]; then
    fail "docker must not be called ($1): $(tr '\n' ';' < "$docker_events")"
  fi
}

# 1. Without confirmation: exit != 0, docker never called, explicit message.
refusal_output="$test_directory/refusal"
if run_reset > "$refusal_output" 2>&1; then
  fail "db.sh --reset without --yes must exit non-zero."
fi
assert_no_docker_call "refusal"
grep -q -- '--yes' "$refusal_output" \
  || fail "the refusal must tell how to confirm; got: $(cat "$refusal_output")"

# A wrong confirmation value is a refusal too.
if run_reset --YES > "$refusal_output" 2>&1; then
  fail "db.sh --reset with --YES (not --yes) must exit non-zero."
fi
assert_no_docker_call "refusal (wrong value)"

# 2. Dry run: the SQL plan is printed, docker never called.
plan_output="$test_directory/plan"
run_reset --yes --dry-run > "$plan_output" 2>"$test_directory/plan-stderr" \
  || fail "dry run must succeed; stderr: $(cat "$test_directory/plan-stderr")"
assert_no_docker_call "dry run"

assert_plan_contains() {
  grep -qF -- "$1" "$plan_output" || fail "dry-run SQL must contain '$1'; got: $(cat "$plan_output")"
}
assert_plan_contains 'drop database if exists "ohb"'
assert_plan_contains 'create database "ohb"'
assert_plan_contains 'pg_terminate_backend'
assert_plan_contains 'revoke connect on database "ohb"'
assert_plan_contains 'grant connect on database "ohb"'
assert_plan_contains 'template template0'
if grep -qF -- 'down -v' "$plan_output"; then
  fail "dry-run SQL must not contain 'down -v'."
fi
if grep -qF -- 'compose' "$plan_output"; then
  fail "dry-run SQL must not mention compose."
fi
# Only the openedbot database is named: no other database, no role drop.
if grep -qiE 'drop (role|database if exists "(devhub|postgres|template[01])")' "$plan_output"; then
  fail "dry-run SQL must not drop roles or other databases."
fi

# 3. A system or malformed database name is refused before any docker call.
for bad_name in postgres template0 'ohb"; drop database devhub; --' 'Weird Name'; do
  if PATH="$fake_bin:/usr/bin:/bin" FAKE_DOCKER_EVENTS="$docker_events" \
      API_DATABASE_URL="postgres://openedbot_api@127.0.0.1:5432/$bad_name" \
      /bin/bash scripts/db.sh --reset --yes --dry-run >/dev/null 2>&1; then
    fail "database name '$bad_name' must be refused."
  fi
done
assert_no_docker_call "bad names"

# 4. db-reset-keep-users: the confirmation gate is the script's, before the
# database is even located, and the make target refuses without CONFIRM=yes.
# Nothing here talks to docker or to PostgreSQL.
keep_users_output="$test_directory/keep-users"
if PATH="$fake_bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
    FAKE_DOCKER_EVENTS="$docker_events" \
    env -u OPENEDBOT_DEV_RESET_CONFIRM bun apps/api/scripts/dev-reset-data.ts > "$keep_users_output" 2>&1; then
  fail "dev-reset-data.ts without OPENEDBOT_DEV_RESET_CONFIRM=yes must exit non-zero."
fi
assert_no_docker_call "keep-users refusal"
grep -q 'db-reset-keep-users CONFIRM=yes' "$keep_users_output" \
  || fail "the refusal must name the confirmed command; got: $(cat "$keep_users_output")"

if make -n db-reset-keep-users > "$keep_users_output" 2>&1; then
  fail "make db-reset-keep-users without CONFIRM=yes must fail."
fi
grep -q 'CONFIRM=yes' "$keep_users_output" \
  || fail "make db-reset-keep-users must tell how to confirm; got: $(cat "$keep_users_output")"

# The preserved-table list lives in ONE place, shared by the route and the
# script: neither the Makefile nor this contract may grow a copy of it.
if grep -qE '^[^#]*\b(truncate|schema_migrations)\b' Makefile; then
  fail "the Makefile must not carry its own wipe plan; apps/api/src/application/dev-reset.ts owns it."
fi
grep -q 'DEV_RESET_PRESERVED_TABLES' apps/api/src/application/dev-reset.ts \
  || fail "apps/api/src/application/dev-reset.ts must own DEV_RESET_PRESERVED_TABLES."

printf 'db-reset contract passed.\n'
