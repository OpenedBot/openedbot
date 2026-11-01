#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

api_command="bun run --cwd apps/api --silent dev"
console_command="bun run --cwd apps/console --silent dev"
worker_command="bun run --cwd apps/worker --silent dev"

fail() {
  printf 'make dev contract failed: %s\n' "$1" >&2
  exit 1
}

# .env.make-dev-contract does not exist: the default plans below are the ones
# of a workstation without any env file (profile fake, runtime mode external).
dry_run() {
  make --no-print-directory --dry-run ENV_FILE=.env.make-dev-contract "$@"
}

# Same plan, against a temporary env file holding the given lines.
contract_tmpdir="$(mktemp -d)"
trap 'rm -rf "$contract_tmpdir"' EXIT
# The core names no plug-in path: dev-admin reads plugins/admin, or ADMIN_DIR.
admin_command="bun run --cwd $contract_tmpdir/plugins/admin --silent dev"
dry_run_with_env() {
  local env_file="$contract_tmpdir/env.$RANDOM$RANDOM"
  local lines="$1"
  shift
  printf '%s\n' "$lines" > "$env_file"
  make --no-print-directory --dry-run ENV_FILE="$env_file" "$@"
}

count_command() {
  local command="$1"
  awk -v command="$command" '
    {
      rest = $0
      while ((position = index(rest, command)) != 0) {
        before = position == 1 ? "" : substr(rest, position - 1, 1)
        after = substr(rest, position + length(command), 1)
        if ((before == "" || before ~ /[[:space:]();|&]/) &&
            (after == "" || after ~ /[[:space:]();|&]/)) {
          count += 1
        }
        rest = substr(rest, position + length(command))
      }
    }
    END { print count + 0 }
  '
}

count_literal() {
  local literal="$1"
  awk -v literal="$literal" '
    {
      rest = $0
      while ((position = index(rest, literal)) != 0) {
        count += 1
        rest = substr(rest, position + length(literal))
      }
    }
    END { print count + 0 }
  '
}

assert_literal_count() {
  local target="$1"
  local plan="$2"
  local literal="$3"
  local expected="$4"
  local actual
  actual="$(printf '%s\n' "$plan" | count_literal "$literal")"
  if [ "$actual" -ne "$expected" ]; then
    fail "make -n $target should contain '$literal' exactly $expected time(s), found $actual."
  fi
}

assert_command_count() {
  local target="$1"
  local plan="$2"
  local command="$3"
  local expected="$4"
  local actual
  actual="$(printf '%s\n' "$plan" | count_command "$command")"
  if [ "$actual" -ne "$expected" ]; then
    fail "make -n $target should contain '$command' exactly $expected time(s), found $actual."
  fi
}

assert_not_contains() {
  local target="$1"
  local plan="$2"
  local forbidden="$3"
  if [[ "$plan" == *"$forbidden"* ]]; then
    fail "make -n $target unexpectedly contains '$forbidden'."
  fi
}

assert_no_preparation() {
  local target="$1"
  local plan="$2"
  assert_not_contains "$target" "$plan" "scripts/infra-up.sh"
  assert_not_contains "$target" "$plan" "scripts/db-up.sh"
  assert_not_contains "$target" "$plan" "scripts/db-migrate.sh"
  assert_not_contains "$target" "$plan" "scripts/hermes.sh --up"
  assert_not_contains "$target" "$plan" "scripts/db.sh --up"
  assert_not_contains "$target" "$plan" "scripts/db.sh --migrate"
}

dev_plan="$(dry_run dev)"
assert_literal_count dev "$dev_plan" "bun run" 1
assert_literal_count dev "$dev_plan" "--filter api" 1
assert_literal_count dev "$dev_plan" "--filter console" 1
assert_literal_count dev "$dev_plan" "--filter worker" 1
assert_literal_count dev "$dev_plan" "--parallel" 1
assert_literal_count dev "$dev_plan" "--no-orphans" 1
assert_literal_count dev "$dev_plan" "--elide-lines=0" 1
assert_literal_count dev "$dev_plan" 'label="API"' 1
assert_literal_count dev "$dev_plan" 'label="CONSOLE"' 1
assert_literal_count dev "$dev_plan" 'label="WORKER"' 1
assert_not_contains dev "$dev_plan" "dev:worker"
assert_not_contains dev "$dev_plan" "--filter admin"
assert_command_count dev "$dev_plan" "$admin_command" 0
assert_no_preparation dev "$dev_plan"

if [ -d apps/api/src/worker ]; then
  fail "worker sources must not remain under apps/api/src/worker."
fi
if [ ! -f apps/worker/src/index.ts ]; then
  fail "apps/worker/src/index.ts is missing."
fi

api_plan="$(dry_run dev-api)"
assert_command_count dev-api "$api_plan" "$api_command" 1
assert_command_count dev-api "$api_plan" "$console_command" 0
assert_command_count dev-api "$api_plan" "$worker_command" 0
assert_no_preparation dev-api "$api_plan"

console_plan="$(dry_run dev-console)"
assert_command_count dev-console "$console_plan" "$api_command" 0
assert_command_count dev-console "$console_plan" "$console_command" 1
assert_command_count dev-console "$console_plan" "$worker_command" 0
assert_no_preparation dev-console "$console_plan"

worker_plan="$(dry_run dev-worker)"
assert_command_count dev-worker "$worker_plan" "$api_command" 0
assert_command_count dev-worker "$worker_plan" "$console_command" 0
assert_command_count dev-worker "$worker_plan" "$worker_command" 1
assert_no_preparation dev-worker "$worker_plan"

admin_plan="$(dry_run dev-admin ADMIN_DIR="$contract_tmpdir/plugins/admin")"
assert_command_count dev-admin "$admin_plan" "$admin_command" 1
assert_command_count dev-admin "$admin_plan" "$api_command" 0
assert_command_count dev-admin "$admin_plan" "$console_command" 0
assert_command_count dev-admin "$admin_plan" "$worker_command" 0
assert_no_preparation dev-admin "$admin_plan"

# dev, dev-api and dev-worker validate the env file first (env-check), with
# the same runtime mode as the apps: a file that would crash an app at boot
# stops make before anything starts. Hence two OHB_RUNTIME_MODE per dev plan.
for target in dev dev-api dev-worker; do
  assert_literal_count "$target" "$(dry_run "$target")" "scripts/env.ts --check" 1
done

# Profiles. The default profile is `fake`: the apps run in external runtime
# mode against tests/fake-hermes, and nothing pulls the Hermes image.
assert_literal_count dev "$dev_plan" 'OHB_RUNTIME_MODE="external"' 2
fake_plan="$(dry_run MODE=fake dev)"
assert_literal_count "dev MODE=fake" "$fake_plan" 'OHB_RUNTIME_MODE="external"' 2
bundled_plan="$(dry_run MODE=bundled dev)"
assert_literal_count "dev MODE=bundled" "$bundled_plan" 'OHB_RUNTIME_MODE="bundled"' 2
external_plan="$(dry_run MODE=external dev)"
assert_literal_count "dev MODE=external" "$external_plan" 'OHB_RUNTIME_MODE="external"' 2

# Without MODE=, the profile follows OHB_RUNTIME_MODE in the env file: an
# existing bundled workstation must not be re-run as external (env-check would
# refuse the conflicting mode), and a fake workstation (external mode pointed
# at the fake gateway by setup.sh) must keep seeding its fake runtime row.
bundled_env='OHB_RUNTIME_MODE=bundled'
external_env='OHB_RUNTIME_MODE=external'
fake_env=$'OHB_RUNTIME_MODE=external\nDEV_HERMES_URL=http://127.0.0.1:18642'
derived_bundled_plan="$(dry_run_with_env "$bundled_env" dev)"
assert_literal_count "dev (env bundled)" "$derived_bundled_plan" 'OHB_RUNTIME_MODE="bundled"' 2
assert_not_contains "dev (env bundled)" "$derived_bundled_plan" 'OHB_RUNTIME_MODE="external"'
derived_bundled_seed_plan="$(dry_run_with_env "$bundled_env" db-seed)"
assert_literal_count "db-seed (env bundled)" "$derived_bundled_seed_plan" 'OHB_DEV_PROFILE="bundled"' 1
derived_external_plan="$(dry_run_with_env "$external_env" dev)"
assert_literal_count "dev (env external)" "$derived_external_plan" 'OHB_RUNTIME_MODE="external"' 2
derived_external_seed_plan="$(dry_run_with_env "$external_env" db-seed)"
assert_literal_count "db-seed (env external)" "$derived_external_seed_plan" 'OHB_DEV_PROFILE="external"' 1
derived_fake_seed_plan="$(dry_run_with_env "$fake_env" db-seed)"
assert_literal_count "db-seed (env fake)" "$derived_fake_seed_plan" 'OHB_DEV_PROFILE="fake"' 1
assert_literal_count "db-seed (env fake)" "$derived_fake_seed_plan" 'OHB_RUNTIME_MODE="external"' 1
derived_empty_seed_plan="$(dry_run_with_env 'OHB_RUNTIME_MODE=' db-seed)"
assert_literal_count "db-seed (env empty mode)" "$derived_empty_seed_plan" 'OHB_DEV_PROFILE="fake"' 1
# An explicit MODE= keeps priority over the env file.
explicit_fake_plan="$(dry_run_with_env "$bundled_env" dev MODE=fake)"
assert_literal_count "dev MODE=fake (env bundled)" "$explicit_fake_plan" 'OHB_RUNTIME_MODE="external"' 2
explicit_bundled_plan="$(dry_run_with_env "$external_env" dev MODE=bundled)"
assert_literal_count "dev MODE=bundled (env external)" "$explicit_bundled_plan" 'OHB_RUNTIME_MODE="bundled"' 2

setup_plan="$(dry_run setup)"
assert_not_contains setup "$setup_plan" "hermes-image-tag.ts"
assert_literal_count setup "$setup_plan" 'OHB_DEV_PROFILE="fake"' 1
assert_literal_count setup "$setup_plan" 'OHB_RUNTIME_MODE="external"' 1
assert_literal_count setup "$setup_plan" "scripts/setup.sh" 1

bundled_setup_plan="$(dry_run setup MODE=bundled)"
assert_not_contains "setup MODE=bundled" "$bundled_setup_plan" "hermes-image-tag.ts"
assert_literal_count "setup MODE=bundled" "$bundled_setup_plan" 'OHB_DEV_PROFILE="bundled"' 1
assert_literal_count "setup MODE=bundled" "$bundled_setup_plan" 'OHB_RUNTIME_MODE="bundled"' 1

# infra-up only proves PostgreSQL now: the bundled Hermes container tooling
# was removed with deprecated/infra.
infra_plan="$(dry_run infra-up)"
assert_literal_count infra-up "$infra_plan" "scripts/db.sh --up" 1
assert_not_contains infra-up "$infra_plan" "OHB_DEV_PROFILE"
assert_not_contains infra-up "$infra_plan" "scripts/hermes.sh"
bundled_infra_plan="$(dry_run infra-up MODE=bundled)"
assert_literal_count "infra-up MODE=bundled" "$bundled_infra_plan" "scripts/db.sh --up" 1

# Integration tests need PostgreSQL only: never the Hermes container, never
# its bootstrap. INTEGRATION_DATABASE_URL (CI service) skips the local db-up.
integration_plan="$(dry_run test-integration INTEGRATION_DATABASE_URL=)"
assert_not_contains test-integration "$integration_plan" "hermes-bootstrap.sh"
assert_not_contains test-integration "$integration_plan" "scripts/hermes.sh --bootstrap"
assert_not_contains test-integration "$integration_plan" "scripts/hermes.sh --up"
assert_not_contains test-integration "$integration_plan" "--profile bundled"
assert_not_contains test-integration "$integration_plan" "scripts/infra-up.sh"
assert_not_contains test-integration "$integration_plan" "hermes"
assert_literal_count test-integration "$integration_plan" "scripts/db.sh --up" 1
assert_literal_count test-integration "$integration_plan" "tests/integration/postgres-rls.sh" 1
ci_integration_plan="$(dry_run test-integration INTEGRATION_DATABASE_URL=postgres://ci)"
assert_not_contains "test-integration (CI)" "$ci_integration_plan" "scripts/db-up.sh"
assert_not_contains "test-integration (CI)" "$ci_integration_plan" "scripts/db.sh --up"
assert_literal_count "test-integration (CI)" "$ci_integration_plan" "tests/integration/postgres-rls.sh" 1

fake_hermes_plan="$(dry_run fake-hermes)"
assert_literal_count fake-hermes "$fake_hermes_plan" "bun tests/fake-hermes/server.ts" 1
assert_no_preparation fake-hermes "$fake_hermes_plan"

# db-reset is destructive: without CONFIRM=yes even the dry-run must refuse.
# The confirmed plan drops and recreates the single openedbot database in
# the shared dev-infra container (scripts/db.sh --reset, confirmed explicitly),
# then migrates and seeds. It must never `docker compose down -v`: the
# container is shared and this repository owns no PostgreSQL compose project.
if dry_run db-reset >/dev/null 2>&1; then
  fail "make -n db-reset without CONFIRM=yes must fail."
fi
db_reset_plan="$(dry_run db-reset CONFIRM=yes)"
assert_not_contains db-reset "$db_reset_plan" "down -v"
assert_not_contains db-reset "$db_reset_plan" "down --volumes"
assert_not_contains db-reset "$db_reset_plan" "docker compose"
assert_literal_count db-reset "$db_reset_plan" "scripts/db.sh --reset" 1
assert_literal_count db-reset "$db_reset_plan" "scripts/db.sh --reset --yes" 1
assert_literal_count db-reset "$db_reset_plan" "scripts/db.sh --migrate" 1
assert_literal_count db-reset "$db_reset_plan" "--filter api seed" 1
# env-check must validate the env file before the database is dropped (the
# recursive db-seed plan runs it a second time afterwards, which is fine), and
# the migrations must come back before the seed.
plan_line() {
  printf '%s\n' "$db_reset_plan" | grep -n -- "$1" | head -n 1 | cut -d: -f1
}
env_check_line="$(plan_line 'scripts/env.ts --check')"
reset_line="$(plan_line 'scripts/db.sh --reset')"
migrate_line="$(plan_line 'scripts/db.sh --migrate')"
seed_line="$(plan_line '--filter api seed')"
if [ -z "$env_check_line" ] || [ -z "$reset_line" ] || [ "$env_check_line" -ge "$reset_line" ]; then
  fail "make -n db-reset must run scripts/env.ts --check before scripts/db.sh --reset (env-check at line ${env_check_line:-none}, db-reset at line ${reset_line:-none})."
fi
if [ -z "$migrate_line" ] || [ "$reset_line" -ge "$migrate_line" ]; then
  fail "make -n db-reset must run scripts/db.sh --migrate after scripts/db.sh --reset (db-reset at line $reset_line, db-migrate at line ${migrate_line:-none})."
fi
if [ -z "$seed_line" ] || [ "$migrate_line" -ge "$seed_line" ]; then
  fail "make -n db-reset must seed after scripts/db.sh --migrate (db-migrate at line $migrate_line, seed at line ${seed_line:-none})."
fi

# link-dev-up names exactly the HOST of the command line, nothing without it:
# no workstation variable is read from the env file by the core Makefile.
case "$(make --no-print-directory --dry-run ENV_FILE=.env.make-dev-contract HOST=user@runtime-host link-dev-up)" in
  *'HOST="user@runtime-host"'*) ;;
  *) fail "make -n link-dev-up must pass HOST from the command line." ;;
esac
case "$(make --no-print-directory --dry-run ENV_FILE=.env.make-dev-contract link-dev-up)" in
  *'HOST=""'*) ;;
  *) fail "without HOST, make -n link-dev-up must name no host." ;;
esac

printf 'make dev dry-run contract passed.\n'
