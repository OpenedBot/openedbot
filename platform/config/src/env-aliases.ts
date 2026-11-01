/**
 * One-release fallback for the OHB_* -> OPENEDBOT_* rename of the
 * environment variables. An old name still set is copied to its new name
 * (when the new one is unset) with one deprecation warning per name; the
 * new name always wins. Delete this file, `env-aliases-apply.ts`, the shell
 * table (scripts/lib/env-aliases.sh) and the Makefile one
 * (scripts/lib/env-aliases.mk) in the release after the rename.
 *
 * `make env-audit --apply` (scripts/env.ts) rewrites the same names in the
 * env files, values kept: see `renamedEnvName`.
 */

/** Old name -> new name. Mirrored by scripts/lib/env-aliases.sh (tested). */
export const ENV_RENAMES: Readonly<Record<string, string>> = {
  OHB_ENV: "OPENEDBOT_ENV",
  OHB_DEPLOY_ENV: "OPENEDBOT_DEPLOY_ENV",
  OHB_PRO_PLUGINS: "OPENEDBOT_PLUGINS",
  OHB_PRO_CONSOLE: "OPENEDBOT_CONSOLE_PLUGINS",
  OHB_CF_ACCOUNT_ID: "OPENEDBOT_CF_ACCOUNT_ID",
  OHB_CF_API_TOKEN: "OPENEDBOT_CF_API_TOKEN",
  OHB_CF_ZONE_ID: "OPENEDBOT_CF_ZONE_ID",
  OHB_MANAGED_TUNNEL_SUFFIX: "OPENEDBOT_MANAGED_TUNNEL_SUFFIX",
  OHB_TAILSCALE_FUNNEL_ENABLED: "OPENEDBOT_TAILSCALE_FUNNEL_ENABLED",
  OHB_COMPUTER_PROVIDER: "OPENEDBOT_COMPUTER_PROVIDER",
  OHB_COMPUTER_BOX_TOKEN: "OPENEDBOT_COMPUTER_BOX_TOKEN",
  OHB_LOG_DIR: "OPENEDBOT_LOG_DIR",
  OHB_LOG_TO_FILES: "OPENEDBOT_LOG_TO_FILES",
  OHB_CONSOLE_SOLO: "OPENEDBOT_CONSOLE_SOLO",
  OHB_CONSOLE_MODULE_REPORT: "OPENEDBOT_CONSOLE_MODULE_REPORT",
  OHB_PUBLIC_URL: "OPENEDBOT_PUBLIC_URL",
  OHB_CONSOLE_URL: "OPENEDBOT_CONSOLE_URL",
  OHB_CORE_DIR: "OPENEDBOT_CORE_DIR",
  OHB_DIR: "OPENEDBOT_DIR",
  OHB_ENV_FILE: "OPENEDBOT_ENV_FILE",
  OHB_DEV_PROFILE: "OPENEDBOT_DEV_PROFILE",
  OHB_POSTGRES_CONTAINER: "OPENEDBOT_POSTGRES_CONTAINER",
  OHB_DATABASE_NAME: "OPENEDBOT_DATABASE_NAME",
  OHB_POSTGRES_PORT: "OPENEDBOT_POSTGRES_PORT",
  OHB_DEV_RESET_CONFIRM: "OPENEDBOT_DEV_RESET_CONFIRM",
  OHB_MAILPIT_CONTAINER: "OPENEDBOT_MAILPIT_CONTAINER",
  OHB_MAILPIT_URL: "OPENEDBOT_MAILPIT_URL",
  OHB_INTEGRATION_DATABASE: "OPENEDBOT_INTEGRATION_DATABASE",
  OHB_LINK_GATEWAY_E2E: "OPENEDBOT_LINK_GATEWAY_E2E",
  OHB_LINK_E2E_API_PORT: "OPENEDBOT_LINK_E2E_API_PORT",
  OHB_LINK_E2E_CONTROL_URL: "OPENEDBOT_LINK_E2E_CONTROL_URL",
  OHB_LINK_E2E_GATEWAY_URL: "OPENEDBOT_LINK_E2E_GATEWAY_URL",
  OHB_LINK_E2E_WS_URL: "OPENEDBOT_LINK_E2E_WS_URL",
  OHB_RUNTIME_ID: "OPENEDBOT_K6_RUNTIME_ID",
  OHB_INTERNAL_TOKEN: "OPENEDBOT_K6_INTERNAL_TOKEN",
  OHB_K6_API_URL: "OPENEDBOT_K6_API_URL",
  OHB_K6_SUMMARY: "OPENEDBOT_K6_SUMMARY",
  OHB_BROKER_E2E: "OPENEDBOT_BROKER_E2E",
  OHB_TEST_MAC_CRASH_ROOT: "OPENEDBOT_TEST_MAC_CRASH_ROOT",
  OHB_TEST_MAC_CRASH_PHASE: "OPENEDBOT_TEST_MAC_CRASH_PHASE",
  OHB_SNAPSHOT_DIR: "OPENEDBOT_SNAPSHOT_DIR",
  OHB_SCOPE_TEST_SENTINEL: "OPENEDBOT_SCOPE_TEST_SENTINEL",
  OHB_APPROVAL_ROOT: "OPENEDBOT_APPROVAL_ROOT",
  OHB_APPROVAL_PROFILE: "OPENEDBOT_APPROVAL_PROFILE",
  OHB_APPROVAL_ENABLE: "OPENEDBOT_APPROVAL_ENABLE",
  OHB_APPROVAL_RELOAD: "OPENEDBOT_APPROVAL_RELOAD",
  OHB_APPROVAL_TEST: "OPENEDBOT_APPROVAL_TEST",
};

/** Plug-in family `OHB_PRO_<ID>__<KEY>` -> `OPENEDBOT_PLUGIN_<ID>__<KEY>` (after the exact names). */
export const ENV_RENAMED_PREFIXES: readonly (readonly [string, string])[] = [["OHB_PRO_", "OPENEDBOT_PLUGIN_"]];

/** Old names that are no longer read at all: warned about, then ignored. */
export const ENV_DROPPED: readonly string[] = ["OHB_RUNTIME_MODE"];

/** The new name of a renamed variable, or undefined. */
export function renamedEnvName(name: string): string | undefined {
  if (Object.hasOwn(ENV_RENAMES, name)) return ENV_RENAMES[name];
  for (const [from, to] of ENV_RENAMED_PREFIXES) {
    if (name.startsWith(from) && name.length > from.length) return to + name.slice(from.length);
  }
  return undefined;
}

const warned = new Set<string>();

function warnOnce(name: string, message: string, warn: (message: string) => void): void {
  if (warned.has(name)) return;
  warned.add(name);
  warn(message);
}

/**
 * Copies every renamed variable still set under its old name to the new one
 * (when unset) and warns once per old name. Returns the warnings emitted by
 * this call. Never prints a value.
 */
export function applyEnvAliases(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): string[] {
  const emitted: string[] = [];
  const emit = (name: string, message: string) => {
    const before = warned.size;
    warnOnce(name, message, warn);
    if (warned.size > before) emitted.push(message);
  };
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value === undefined) continue;
    if (ENV_DROPPED.includes(name)) {
      emit(name, `${name} is retired and ignored: remove it from the environment.`);
      continue;
    }
    const next = renamedEnvName(name);
    if (!next) continue;
    const current = env[next];
    if (current === undefined) {
      env[next] = value;
      emit(name, `${name} is deprecated: rename it to ${next} (old name read for one more release).`);
    } else if (current !== value) {
      emit(name, `${name} and ${next} are both set with different values: ${next} wins; remove ${name}.`);
    } else {
      emit(name, `${name} is deprecated: remove it, ${next} is already set.`);
    }
  }
  return emitted;
}

/** For the tests: forget which names were already warned about. */
export function resetEnvAliasWarnings(): void {
  warned.clear();
}
