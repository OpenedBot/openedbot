# shellcheck shell=bash
# Refuses to go on while a retired OHB_* variable is set (bash side). They
# are no longer read: rather than run with a setting silently lost, the
# sourcing shell exits 78 (EX_CONFIG) with one line per name and its
# successor. Never prints a value. Sourced by the Makefile recipes that load
# the env file (LOAD_ENV) and by scripts/db.sh, scripts/mailpit.sh and
# scripts/setup.sh. Same table as platform/config/src/legacy-env.ts
# (checked by its tests), merged names included.

openedbot_legacy_env_advice() {
  local name="$1" old new
  while read -r old new; do
    if [ "$old" = "$name" ]; then
      printf 'rename it to %s' "$new"
      return 0
    fi
  done <<'TABLE'
  OHB_ENV OPENEDBOT_ENV
  OHB_PRO_PLUGINS OPENEDBOT_PLUGINS
  OHB_PRO_CONSOLE OPENEDBOT_CONSOLE_PLUGINS
  OHB_TAILSCALE_FUNNEL_ENABLED OPENEDBOT_TAILSCALE_FUNNEL_ENABLED
  OHB_COMPUTER_BOX_TOKEN OPENEDBOT_COMPUTER_BOX_TOKEN
  OHB_LOG_DIR OPENEDBOT_LOG_DIR
  OHB_CONSOLE_MODULE_REPORT OPENEDBOT_CONSOLE_MODULE_REPORT
  OHB_PUBLIC_URL OPENEDBOT_PUBLIC_URL
  OHB_CONSOLE_URL OPENEDBOT_CONSOLE_URL
  OHB_CORE_DIR OPENEDBOT_MAIN_DIR
  OHB_DIR OPENEDBOT_MAIN_DIR
  OHB_ENV_FILE ENV_FILE
  OHB_DEV_PROFILE OPENEDBOT_DEV_PROFILE
  OHB_POSTGRES_CONTAINER OPENEDBOT_POSTGRES_CONTAINER
  OHB_DEV_RESET_CONFIRM OPENEDBOT_DEV_RESET_CONFIRM
  OHB_MAILPIT_CONTAINER OPENEDBOT_MAILPIT_CONTAINER
  OHB_MAILPIT_URL E2E_MAILPIT_URL
  OHB_INTEGRATION_DATABASE OPENEDBOT_INTEGRATION_DATABASE
  OHB_LINK_GATEWAY_E2E OPENEDBOT_LINK_GATEWAY_E2E
  OHB_LINK_E2E_API_PORT OPENEDBOT_LINK_E2E_API_PORT
  OHB_LINK_E2E_CONTROL_URL OPENEDBOT_LINK_E2E_CONTROL_URL
  OHB_LINK_E2E_GATEWAY_URL OPENEDBOT_LINK_E2E_GATEWAY_URL
  OHB_LINK_E2E_WS_URL OPENEDBOT_LINK_E2E_WS_URL
  OHB_RUNTIME_ID OPENEDBOT_K6_RUNTIME_ID
  OHB_INTERNAL_TOKEN OPENEDBOT_K6_INTERNAL_TOKEN
  OHB_K6_API_URL OPENEDBOT_K6_API_URL
  OHB_K6_SUMMARY OPENEDBOT_K6_SUMMARY
  OHB_BROKER_E2E OPENEDBOT_BROKER_E2E
  OHB_TEST_MAC_CRASH_ROOT OPENEDBOT_TEST_MAC_CRASH_ROOT
  OHB_TEST_MAC_CRASH_PHASE OPENEDBOT_TEST_MAC_CRASH_PHASE
  OHB_SCOPE_TEST_SENTINEL OPENEDBOT_SCOPE_TEST_SENTINEL
  OHB_APPROVAL_ROOT OPENEDBOT_APPROVAL_ROOT
  OHB_APPROVAL_PROFILE OPENEDBOT_APPROVAL_PROFILE
  OHB_APPROVAL_ENABLE OPENEDBOT_APPROVAL_ENABLE
  OHB_APPROVAL_RELOAD OPENEDBOT_APPROVAL_RELOAD
  OHB_APPROVAL_TEST OPENEDBOT_APPROVAL_TEST
TABLE
  # Folded into another variable with a value change (ENV_MERGES).
  case "$name" in
    OHB_DEPLOY_ENV) printf 'folded into OPENEDBOT_ENV: set OPENEDBOT_ENV instead' ;;
    OHB_CF_ACCOUNT_ID|OHB_CF_API_TOKEN|OHB_CF_ZONE_ID|OHB_MANAGED_TUNNEL_SUFFIX)
      printf 'folded into OPENEDBOT_MANAGED_TUNNEL_URL: set OPENEDBOT_MANAGED_TUNNEL_URL instead' ;;
    OHB_COMPUTER_PROVIDER) printf 'folded into OPENEDBOT_COMPUTER_BOX_TOKEN: set OPENEDBOT_COMPUTER_BOX_TOKEN instead' ;;
    OHB_LOG_TO_FILES) printf 'folded into OPENEDBOT_LOG_DIR: set OPENEDBOT_LOG_DIR instead' ;;
    OHB_CONSOLE_SOLO) printf 'folded into OPENEDBOT_CONSOLE_MODE: set OPENEDBOT_CONSOLE_MODE instead' ;;
    OHB_PRO_?*) printf 'rename it to OPENEDBOT_PLUGIN_%s' "${name#OHB_PRO_}" ;;
    *) printf 'retired: remove it' ;;
  esac
}

openedbot_refuse_legacy_env() {
  local names name
  names="$(compgen -e | grep '^OHB_' | LC_ALL=C sort || true)"
  [ -n "$names" ] || return 0
  printf 'openedbot refuses to start: the retired OHB_ prefix is no longer read.\n' >&2
  for name in $names; do
    printf '  %s: %s\n' "$name" "$(openedbot_legacy_env_advice "$name")" >&2
  done
  # shellcheck disable=SC2016 # literal backticks: a command to type, not to run
  printf 'Fix them where the environment is defined (shell, env file). In a checkout, `make env-prune` rewrites .env.local under the new names, values kept.\n' >&2
  return 78
}

openedbot_refuse_legacy_env || exit 78
