#!/usr/bin/env bash
set -euo pipefail

# Offline contract for the pro plug-in migrations of scripts/db.sh --migrate.
# docker is faked: every core migration reads as applied, so
# only plug-in files can be sent to psql.
#   1. Solo (OPENEDBOT_PLUGINS unset or empty): nothing is applied.
#   2. A fixture plug-in: its pending files are applied after the core, in
#      order, each followed by the insert of `<id>:<file>`, in one
#      transaction; an already recorded `<id>:<file>` is skipped.

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
fake_bin="$test_directory/bin"
mkdir -p "$fake_bin"

fail() {
  printf 'pro-migrations contract failed: %s\n' "$1" >&2
  exit 1
}

cat > "$fake_bin/docker" <<'FAKE'
#!/bin/bash
case "$*" in
  inspect*) exit 0 ;;
  *"select version from schema_migrations"*)
    for file in "$FAKE_ROOT"/db/migrations/*.sql; do basename "$file" .sql; done
    printf '%s\n' "$FAKE_APPLIED"
    exit 0
    ;;
  "exec -i "*)
    printf '=== %s\n' "$*" >> "$FAKE_DOCKER_STDIN"
    cat >> "$FAKE_DOCKER_STDIN"
    exit 0
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$fake_bin/docker"

bun_dir="$(dirname "$(command -v bun)")"
stdin_log="$test_directory/stdin"

run_migrate() {
  : > "$stdin_log"
  PATH="$fake_bin:$bun_dir:/usr/bin:/bin" \
    FAKE_ROOT="$root" \
    FAKE_DOCKER_STDIN="$stdin_log" \
    OPENEDBOT_POSTGRES_CONTAINER=infra-postgres \
    API_DATABASE_URL=postgres://openedbot_api@127.0.0.1:5432/openedbot \
    "$@" /bin/bash scripts/db.sh --migrate
}

# 1. Solo.
for solo in "env -u OPENEDBOT_PLUGINS" "env OPENEDBOT_PLUGINS="; do
  output="$(run_migrate $solo FAKE_APPLIED=)" || fail "solo migrate must succeed ($solo)"
  [ ! -s "$stdin_log" ] || fail "solo mode must apply nothing ($solo); psql got: $(head -3 "$stdin_log")"
  case "$output" in *"pro"*|*":"[0-9][0-9][0-9][0-9]_*) fail "solo mode must not mention plug-in migrations: $output" ;; esac
done

# 2. A fixture plug-in with two migrations, the first already recorded.
plugin_dir="$test_directory/pro-fixture"
mkdir -p "$plugin_dir/migrations"
printf 'create table fixture_first (id int);\n' > "$plugin_dir/migrations/0001_first.sql"
printf 'create table fixture_second (id int);\n' > "$plugin_dir/migrations/0002_second.sql"
printf 'ignored\n' > "$plugin_dir/migrations/notes.md"
cat > "$plugin_dir/index.ts" <<PLUGIN
export default {
  manifest: { id: "fixture", version: "1.0.0", pluginApi: 1, entitlements: [] },
  migrations: { directory: "$plugin_dir/migrations" },
};
PLUGIN

output="$(run_migrate env OPENEDBOT_PLUGINS="$plugin_dir/index.ts" FAKE_APPLIED="fixture:0001_first")" \
  || fail "pro migrate must succeed"
printf '%s\n' "$output" | grep -qx 'Migration fixture:0002_second applied to openedbot.' \
  || fail "fixture:0002_second must be applied; got: $output"
if printf '%s\n' "$output" | grep -q 'fixture:0001_first applied'; then fail "an applied <id>:<file> must be skipped"; fi
grep -q 'fixture_first' "$stdin_log" && fail "0001_first was already recorded and must not be replayed"
grep -q 'create table fixture_second' "$stdin_log" || fail "0002_second must be sent to psql"
grep -q "insert into schema_migrations(version) values ('fixture:0002_second') on conflict (version) do nothing;" "$stdin_log" \
  || fail "0002_second must be recorded as fixture:0002_second; psql got: $(cat "$stdin_log")"
grep -q -- '--single-transaction' "$stdin_log" || fail "a plug-in migration and its record must share one transaction"
[ "$(grep -c '^=== ' "$stdin_log")" -eq 1 ] || fail "exactly one plug-in migration must be applied"

printf 'pro-migrations contract passed: solo applies nothing, plug-in files are recorded as <id>:<file> after the core.\n'
