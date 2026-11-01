#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

env_file="${ENV_FILE:-.env.local}"

# Three development profiles, one runtime mode each:
#   fake     -> OHB_RUNTIME_MODE=external, pointed at tests/fake-hermes (default)
#   bundled  -> OHB_RUNTIME_MODE=bundled, operator-provided Hermes + dashboard credentials
#   external -> OHB_RUNTIME_MODE=external, operator-provided DEV_HERMES_URL/TOKEN
# `make` always passes OHB_DEV_PROFILE; a direct call falls back to the runtime
# mode it was given, and only then to the fake profile.
profile="${OHB_DEV_PROFILE:-}"
if [ -z "$profile" ]; then
  case "${OHB_RUNTIME_MODE:-}" in
    bundled) profile="bundled" ;;
    external) profile="external" ;;
    "") profile="fake" ;;
    *)
      # Same rule as platform/config/src/runtime-mode.ts, which a shell
      # script cannot import: only the two profile-backed modes exist.
      printf 'OHB_RUNTIME_MODE=%s is not a runtime mode; use bundled or external.\n' "$OHB_RUNTIME_MODE" >&2
      exit 1
      ;;
  esac
fi
case "$profile" in
  fake) runtime_mode="external" ;;
  bundled) runtime_mode="bundled" ;;
  external) runtime_mode="external" ;;
  *)
    printf 'OHB_DEV_PROFILE must be fake, bundled or external, not %s.\n' "$profile" >&2
    exit 1
    ;;
esac

fake_hermes_host="127.0.0.1"
fake_hermes_port="${FAKE_HERMES_PORT:-18642}"
fake_hermes_origin="${fake_hermes_host}:${fake_hermes_port}"
fake_hermes_url="http://${fake_hermes_origin}"
fake_hermes_default_token="fake-hermes-token"

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required. %s\n' "$command_name" "$install_hint" >&2
    exit 1
  fi
}

require_command bun 'Install Bun 1.3.14 or newer from https://bun.sh/docs/installation, then rerun make setup.'
require_command openssl 'Install OpenSSL, then rerun make setup.'
if [ "$profile" = "fake" ]; then
  require_command curl 'Install curl, then rerun make setup.'
fi

printf 'Installing JavaScript dependencies from bun.lock...\n'
bun install --frozen-lockfile

# One variable, one file: the schema says which (ENV_DIR_OF_SCOPE). Bash cannot
# import it, so the whole map is read once here instead of paying a Bun start
# per variable.
declare -A env_file_of=()
while IFS=$'\t' read -r mapped_name mapped_path; do
  [ -n "$mapped_name" ] && env_file_of["$mapped_name"]="$mapped_path"
done < <(OHB_ENV_FILE="$env_file" bun scripts/env.ts --file-of)

# The private file a variable belongs to; the root one for anything the schema
# does not know, which is where env-audit also keeps unknown names.
file_of() {
  printf '%s' "${env_file_of[$1]:-$env_file}"
}

for template in .env.example; do
  target="$(dirname "$template")/$env_file"
  target="${target#./}"
  if [ ! -e "$target" ]; then
    cp "$template" "$target"
    chmod 600 "$target"
    printf 'Created %s from %s.\n' "$target" "$template"
  elif [ ! -f "$target" ]; then
    printf '%s exists but is not a regular file.\n' "$target" >&2
    exit 1
  else
    chmod 600 "$target"
    printf 'Preserving existing %s.\n' "$target"
    # A variable added to the template after this file was created reaches it
    # here when the template gives it a value; an existing name is never
    # touched. The audit below then drops what this runtime mode does not read.
    added_names="$(awk -F= '
      FNR == NR { if ($0 ~ /^[A-Z_][A-Z0-9_]*=/) present[$1] = 1; next }
      $0 ~ /^[A-Z_][A-Z0-9_]*=./ && !($1 in present) { print }
    ' "$target" "$template")"
    if [ -n "$added_names" ]; then
      printf '\n# Added by make setup from %s.\n%s\n' "$template" "$added_names" >> "$target"
      printf 'Added to %s from %s: %s.\n' "$target" "$template" "$(printf '%s\n' "$added_names" | cut -d= -f1 | paste -sd, - | sed 's/,/, /g')"
    fi
    unset added_names
  fi
done
unset template target

set_env_value() {
  local name="$1"
  local value="$2"
  local target
  target="$(file_of "$name")"
  [ -f "$target" ] || { : > "$target"; chmod 600 "$target"; }
  temporary_file="$(mktemp "${target}.tmp.XXXXXX")"
  trap 'rm -f "$temporary_file"' EXIT
  chmod 600 "$temporary_file"
  awk -v name="$name" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, name "=") == 1 {
      print name "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) print name "=" value
    }
  ' "$target" > "$temporary_file"
  mv "$temporary_file" "$target"
  trap - EXIT
}

# Value of NAME in the file that owns it, empty when absent. Never printed.
env_value() {
  local target
  target="$(file_of "$1")"
  [ -f "$target" ] && sed -n "s/^$1=//p" "$target" | head -n 1
}

if ! grep -Eq '^RUNTIME_TOKEN_ENCRYPTION_KEY=.+$' "$(file_of RUNTIME_TOKEN_ENCRYPTION_KEY)"; then
  encryption_key="$(openssl rand -base64 32 | tr -d '\n')"
  set_env_value RUNTIME_TOKEN_ENCRYPTION_KEY "$encryption_key"
  unset encryption_key
  printf 'Generated the local runtime-token encryption key in %s.\n' "$(file_of RUNTIME_TOKEN_ENCRYPTION_KEY)"
fi

if ! grep -Eq '^AUDIT_VERDICT_SIGNING_KEY=.+$' "$(file_of AUDIT_VERDICT_SIGNING_KEY)"; then
  verdict_key="$(openssl rand -base64 32 | tr -d '\n')"
  set_env_value AUDIT_VERDICT_SIGNING_KEY "$verdict_key"
  unset verdict_key
  printf 'Generated the creation-audit verdict signing key in %s.\n' "$(file_of AUDIT_VERDICT_SIGNING_KEY)"
fi

# Development passwords are never versioned: each workstation gets its own,
# generated once, kept in the private env file and never printed.
for password_name in E2E_PASSWORD DEV_STAFF_PASSWORD; do
  if ! grep -Eq "^${password_name}=.+\$" "$(file_of "$password_name")"; then
    generated_password="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')"
    set_env_value "$password_name" "$generated_password"
    unset generated_password
    printf 'Generated %s for the seeded development account in %s.\n' "$password_name" "$(file_of "$password_name")"
  fi
done
unset password_name

set_env_value OHB_RUNTIME_MODE "$runtime_mode"
if [ "$profile" = "bundled" ]; then
  # No Docker automation here: the operator runs their own Hermes gateway and
  # native Dashboard, and provides the matching credentials up front.
  if ! grep -Eq '^DEV_BUNDLED_HERMES_TOKEN=.+$' "$(file_of DEV_BUNDLED_HERMES_TOKEN)"; then
    printf 'DEV_BUNDLED_HERMES_TOKEN is required for MODE=bundled.\n' >&2
    exit 1
  fi
  if ! grep -Eq '^DEV_HERMES_DASHBOARD_USERNAME=.+$' "$(file_of DEV_HERMES_DASHBOARD_USERNAME)"; then
    printf 'DEV_HERMES_DASHBOARD_USERNAME is required for MODE=bundled.\n' >&2
    exit 1
  fi
  if ! grep -Eq '^DEV_HERMES_DASHBOARD_PASSWORD=.+$' "$(file_of DEV_HERMES_DASHBOARD_PASSWORD)"; then
    printf 'DEV_HERMES_DASHBOARD_PASSWORD is required for MODE=bundled.\n' >&2
    exit 1
  fi
elif [ "$profile" = "fake" ]; then
  # The fake gateway is a loopback HTTP origin: it must be listed explicitly
  # (host:port, see parseInsecureHermesOrigins) or the SSRF guard refuses it.
  if ! grep -Eq '^DEV_HERMES_URL=.+$' "$(file_of DEV_HERMES_URL)"; then
    set_env_value DEV_HERMES_URL "$fake_hermes_url"
    printf 'Pointed DEV_HERMES_URL at the fake Hermes gateway in %s.\n' "$(file_of DEV_HERMES_URL)"
  fi
  if ! grep -Eq '^DEV_HERMES_TOKEN=.+$' "$(file_of DEV_HERMES_TOKEN)"; then
    set_env_value DEV_HERMES_TOKEN "$fake_hermes_default_token"
  fi
  insecure_origins="$(env_value HERMES_ALLOW_INSECURE_ORIGINS)"
  if [ -z "$insecure_origins" ]; then
    set_env_value HERMES_ALLOW_INSECURE_ORIGINS "$fake_hermes_origin"
  elif ! printf '%s' ",${insecure_origins}," | tr -d ' ' | grep -Fq ",${fake_hermes_origin},"; then
    set_env_value HERMES_ALLOW_INSECURE_ORIGINS "${insecure_origins},${fake_hermes_origin}"
  fi
  unset insecure_origins
elif [ "$profile" = "external" ]; then
  if ! grep -Eq '^DEV_HERMES_URL=.+$' "$(file_of DEV_HERMES_URL)"; then
    printf 'DEV_HERMES_URL is required for MODE=external. No lab default is written.\n' >&2
    exit 1
  fi
  if ! grep -Eq '^DEV_HERMES_TOKEN=.+$' "$(file_of DEV_HERMES_TOKEN)"; then
    printf 'DEV_HERMES_TOKEN is required for MODE=external.\n' >&2
    exit 1
  fi
fi

OHB_ENV_FILE="$env_file" OHB_RUNTIME_MODE="$runtime_mode" bun scripts/env.ts --audit --apply
OHB_ENV_FILE="$env_file" OHB_RUNTIME_MODE="$runtime_mode" bun scripts/env.ts --check

# The seed probes DEV_HERMES_URL (health, capabilities, toolsets, model
# options). With the fake profile that gateway is this repository's own
# process: serve it for the duration of the seed unless one already answers.
fake_hermes_pid=""
stop_fake_hermes() {
  if [ -n "$fake_hermes_pid" ] && kill -0 "$fake_hermes_pid" 2>/dev/null; then
    kill "$fake_hermes_pid" 2>/dev/null || true
    wait "$fake_hermes_pid" 2>/dev/null || true
  fi
}
if [ "$profile" = "fake" ]; then
  configured_url="$(env_value DEV_HERMES_URL)"
  if [ "$configured_url" != "$fake_hermes_url" ]; then
    printf 'DEV_HERMES_URL in %s is not the fake gateway (%s). Use MODE=external for a real runtime.\n' \
      "$(file_of DEV_HERMES_URL)" "$fake_hermes_url" >&2
    exit 1
  fi
  unset configured_url
  if curl -fsS --max-time 2 "$fake_hermes_url/health" >/dev/null 2>&1; then
    printf 'Reusing the fake Hermes gateway already listening on %s.\n' "$fake_hermes_origin"
  else
    mkdir -p .run/logs
    FAKE_HERMES_HOST="$fake_hermes_host" FAKE_HERMES_PORT="$fake_hermes_port" \
    FAKE_HERMES_TOKEN="$(env_value DEV_HERMES_TOKEN)" \
      bun tests/fake-hermes/server.ts >.run/logs/setup-fake-hermes.log 2>&1 &
    fake_hermes_pid=$!
    trap stop_fake_hermes EXIT
    for _ in $(seq 1 50); do
      if curl -fsS --max-time 1 "$fake_hermes_url/health" >/dev/null 2>&1; then break; fi
      if ! kill -0 "$fake_hermes_pid" 2>/dev/null; then
        printf 'The fake Hermes gateway exited before answering; see .run/logs/setup-fake-hermes.log.\n' >&2
        exit 1
      fi
      sleep 0.1
    done
    if ! curl -fsS --max-time 1 "$fake_hermes_url/health" >/dev/null 2>&1; then
      printf 'The fake Hermes gateway did not answer on %s.\n' "$fake_hermes_origin" >&2
      exit 1
    fi
    printf 'Serving the fake Hermes gateway on %s for the seed.\n' "$fake_hermes_origin"
  fi
fi

printf 'Preparing PostgreSQL, schema and development account...\n'
make --no-print-directory ENV_FILE="$env_file" MODE="$profile" infra-up db-seed
stop_fake_hermes
trap - EXIT

if [ "$profile" = "fake" ]; then
  printf '\nInfrastructure ready. In one terminal: make fake-hermes. In another: make dev\n'
else
  printf '\nInfrastructure ready. Start API + Web + Worker with: make dev MODE=%s\n' "$profile"
fi
printf 'Then finish the provider, model and first-bot checks in the browser onboarding.\n'
