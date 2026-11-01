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
  OHB_PRO_PLUGINS: "OPENEDBOT_PLUGINS",
  OHB_PRO_CONSOLE: "OPENEDBOT_CONSOLE_PLUGINS",
  OHB_TAILSCALE_FUNNEL_ENABLED: "OPENEDBOT_TAILSCALE_FUNNEL_ENABLED",
  OHB_COMPUTER_BOX_TOKEN: "OPENEDBOT_COMPUTER_BOX_TOKEN",
  OHB_LOG_DIR: "OPENEDBOT_LOG_DIR",
  OHB_CONSOLE_MODULE_REPORT: "OPENEDBOT_CONSOLE_MODULE_REPORT",
  OHB_PUBLIC_URL: "OPENEDBOT_PUBLIC_URL",
  OHB_CONSOLE_URL: "OPENEDBOT_CONSOLE_URL",
  // Both old checkout names point at the main (core) repository.
  OHB_CORE_DIR: "OPENEDBOT_MAIN_DIR",
  OHB_DIR: "OPENEDBOT_MAIN_DIR",
  OHB_ENV_FILE: "ENV_FILE",
  OHB_DEV_PROFILE: "OPENEDBOT_DEV_PROFILE",
  OHB_POSTGRES_CONTAINER: "OPENEDBOT_POSTGRES_CONTAINER",
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

/**
 * Old names folded into another variable with a value change (decision
 * "merge"). `convert` sees the environment after the plain renames and
 * returns the new value of `into`: a string sets it, `null` unsets it,
 * `undefined` leaves it as it is (the old value carried no information the
 * new form does not already give). The old names are then removed.
 */
export interface EnvMerge {
  readonly from: readonly string[];
  readonly into: string;
  readonly convert: (env: Readonly<Record<string, string | undefined>>) => string | null | undefined;
}

export const ENV_MERGES: readonly EnvMerge[] = [
  {
    // dev/prod were derived from OPENEDBOT_ENV already; only `preprod`, on
    // production rules, says something more: OPENEDBOT_ENV=preprod.
    from: ["OHB_DEPLOY_ENV"],
    into: "OPENEDBOT_ENV",
    convert: (env) => (env.OHB_DEPLOY_ENV?.trim().toLowerCase() === "preprod" && env.OPENEDBOT_ENV?.trim() === "production" ? "preprod" : undefined),
  },
  {
    // Four values that only make sense together become one URL, the token
    // percent-encoded in its user part (still a secret, never logged).
    from: ["OHB_CF_ACCOUNT_ID", "OHB_CF_API_TOKEN", "OHB_CF_ZONE_ID", "OHB_MANAGED_TUNNEL_SUFFIX"],
    into: "OPENEDBOT_MANAGED_TUNNEL_URL",
    convert: (env) => {
      if (env.OPENEDBOT_MANAGED_TUNNEL_URL?.trim()) return undefined;
      const [accountId, apiToken, zoneId] = [env.OHB_CF_ACCOUNT_ID, env.OHB_CF_API_TOKEN, env.OHB_CF_ZONE_ID].map((value) => value?.trim() ?? "");
      if (!accountId || !apiToken || !zoneId) return undefined;
      const suffix = env.OHB_MANAGED_TUNNEL_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
      const query = suffix && suffix !== "rt.openedbot.app" ? `?suffix=${encodeURIComponent(suffix)}` : "";
      return `cloudflare://${encodeURIComponent(apiToken)}@${accountId}/${zoneId}${query}`;
    },
  },
  {
    // The token alone now enables the provider. An explicit `disabled` next
    // to a token kept it off: the token is then unset, for the same result.
    from: ["OHB_COMPUTER_PROVIDER"],
    into: "OPENEDBOT_COMPUTER_BOX_TOKEN",
    convert: (env) => (env.OHB_COMPUTER_PROVIDER?.trim() === "box" ? undefined : env.OPENEDBOT_COMPUTER_BOX_TOKEN === undefined ? undefined : null),
  },
  {
    // Only `0` ever changed anything (files off): it becomes LOG_DIR=off.
    from: ["OHB_LOG_TO_FILES"],
    into: "OPENEDBOT_LOG_DIR",
    convert: (env) => (env.OHB_LOG_TO_FILES?.trim() === "0" ? "off" : undefined),
  },
  {
    // `1` assumed a solo console build; it becomes CONSOLE_MODE=solo.
    from: ["OHB_CONSOLE_SOLO"],
    into: "OPENEDBOT_CONSOLE_MODE",
    convert: (env) => (env.OHB_CONSOLE_SOLO?.trim() === "1" ? "solo" : undefined),
  },
];

/** The variable an old merged name now folds into, or undefined. */
export function mergedEnvTarget(name: string): string | undefined {
  return ENV_MERGES.find((merge) => merge.from.includes(name))?.into;
}

/**
 * Applies every merge whose old names are set in `env`, in place, and
 * returns the old names consumed with their target. Never reads a value
 * back to the caller.
 */
export function foldEnvMerges(env: Record<string, string | undefined>): { name: string; into: string }[] {
  const folded: { name: string; into: string }[] = [];
  for (const merge of ENV_MERGES) {
    const present = merge.from.filter((name) => env[name] !== undefined);
    if (!present.length) continue;
    const next = merge.convert(env);
    if (next === null) delete env[merge.into];
    else if (next !== undefined) env[merge.into] = next;
    for (const name of present) {
      delete env[name];
      folded.push({ name, into: merge.into });
    }
  }
  return folded;
}

/** Old names that are no longer read at all: warned about, then ignored. */
export const ENV_DROPPED: readonly string[] = ["OHB_RUNTIME_MODE", "OHB_RUNTIME_ADMIN_MODE"];

/** Old names whose value now comes from another variable: warned about, then ignored. */
export const ENV_DERIVED: Readonly<Record<string, string>> = {
  OHB_DATABASE_NAME: "API_DATABASE_URL",
  OHB_POSTGRES_PORT: "API_DATABASE_URL",
  OPENEDBOT_DATABASE_NAME: "API_DATABASE_URL",
  OPENEDBOT_POSTGRES_PORT: "API_DATABASE_URL",
};

/** The new name of a renamed variable (plain rename, no value change), or undefined. */
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
    if (Object.hasOwn(ENV_DERIVED, name)) {
      emit(name, `${name} is retired and ignored: its value now comes from ${ENV_DERIVED[name]}; remove it.`);
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
  for (const { name, into } of foldEnvMerges(env)) {
    emit(name, `${name} is deprecated: it is folded into ${into} (converted for one more release); set ${into} instead.`);
  }
  return emitted;
}

/** For the tests: forget which names were already warned about. */
export function resetEnvAliasWarnings(): void {
  warned.clear();
}
