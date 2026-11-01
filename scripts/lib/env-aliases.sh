# shellcheck shell=bash
# One-release fallback for the OHB_* -> OPENEDBOT_* rename (bash side).
# Sourced by the Makefile recipes that load the env file (LOAD_ENV) and by
# scripts/db.sh, scripts/mailpit.sh and scripts/setup.sh. An old name still
# set is exported under its new name when the new one is unset, with one
# warning per name on stderr; the new name always wins, and the old one is
# unset for the processes started afterwards. Never prints a value.
# Same table as platform/config/src/env-aliases.ts (checked by its tests).
# Delete in the release after the rename.

openedbot_env_alias() {
  local old="$1" new="$2"
  [ -n "${!old+x}" ] || return 0
  if [ -z "${!new+x}" ]; then
    export "$new=${!old}"
    printf '%s is deprecated: rename it to %s (old name read for one more release).\n' "$old" "$new" >&2
  elif [ "${!old}" != "${!new}" ]; then
    printf '%s and %s are both set with different values: %s wins; remove %s.\n' "$old" "$new" "$new" "$old" >&2
  fi
  # Handled once here: the processes started below see the new name only.
  unset "$old"
}

openedbot_env_aliases() {
  local old new
  while read -r old new; do
    [ -n "$old" ] && openedbot_env_alias "$old" "$new"
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
  OHB_CORE_DIR OPENEDBOT_CORE_DIR
  OHB_DIR OPENEDBOT_DIR
  OHB_ENV_FILE OPENEDBOT_ENV_FILE
  OHB_DEV_PROFILE OPENEDBOT_DEV_PROFILE
  OHB_POSTGRES_CONTAINER OPENEDBOT_POSTGRES_CONTAINER
  OHB_DATABASE_NAME OPENEDBOT_DATABASE_NAME
  OHB_POSTGRES_PORT OPENEDBOT_POSTGRES_PORT
  OHB_DEV_RESET_CONFIRM OPENEDBOT_DEV_RESET_CONFIRM
  OHB_MAILPIT_CONTAINER OPENEDBOT_MAILPIT_CONTAINER
  OHB_MAILPIT_URL OPENEDBOT_MAILPIT_URL
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
  OHB_SNAPSHOT_DIR OPENEDBOT_SNAPSHOT_DIR
  OHB_SCOPE_TEST_SENTINEL OPENEDBOT_SCOPE_TEST_SENTINEL
  OHB_APPROVAL_ROOT OPENEDBOT_APPROVAL_ROOT
  OHB_APPROVAL_PROFILE OPENEDBOT_APPROVAL_PROFILE
  OHB_APPROVAL_ENABLE OPENEDBOT_APPROVAL_ENABLE
  OHB_APPROVAL_RELOAD OPENEDBOT_APPROVAL_RELOAD
  OHB_APPROVAL_TEST OPENEDBOT_APPROVAL_TEST
TABLE
  # Plug-in family OHB_PRO_<ID>__<KEY> -> OPENEDBOT_PLUGIN_<ID>__<KEY>.
  for old in $(compgen -e); do
    case "$old" in
      OHB_PRO_PLUGINS|OHB_PRO_CONSOLE) ;;
      OHB_PRO_?*) openedbot_env_alias "$old" "OPENEDBOT_PLUGIN_${old#OHB_PRO_}" ;;
    esac
  done
}

openedbot_env_aliases
