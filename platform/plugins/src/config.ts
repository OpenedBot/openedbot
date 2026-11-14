/**
 * A plug-in's configuration: only its own `OPENEDBOT_PLUGIN_<ID>__<KEY>` variables,
 * indexed by KEY. Shared by the API (mount context) and the worker (hooks).
 */
import type { HookContext, PluginEnvVariable, ProPlugin } from "./contract";

/** `OPENEDBOT_PLUGIN_<ID>__`: the id upper-cased, `-` as `_`, then a double underscore. */
export function pluginConfigPrefix(pluginId: string): string {
  return `OPENEDBOT_PLUGIN_${pluginId.toUpperCase().replaceAll("-", "_")}__`;
}

const PLUGIN_CONFIG_KEY_RE = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/**
 * Only the plug-in's own variables, never the whole environment. A key may
 * not contain `__`, so the variables of `a--b` never reach plug-in `a`.
 */
export function pluginConfig(pluginId: string, env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const prefix = pluginConfigPrefix(pluginId);
  const config: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    if (PLUGIN_CONFIG_KEY_RE.test(key)) config[key] = value;
  }
  return Object.freeze(config);
}

/**
 * The declared deployment variables (`manifest.env`) that hold a non-empty
 * value, by their full name; `undefined` when nothing is declared.
 */
export function pluginDeployEnv(
  declared: readonly PluginEnvVariable[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  if (!declared || declared.length === 0) return undefined;
  const values: Record<string, string> = {};
  for (const { name } of declared) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") values[name] = value;
  }
  return Object.freeze(values);
}

/**
 * The context every hook of a plug-in receives: its `OPENEDBOT_PLUGIN_<ID>__<KEY>`
 * configuration and, when its manifest declares some, its deployment
 * variables. A bare id (no manifest) gets the configuration only.
 */
export function hookContext(plugin: ProPlugin | string, env: Readonly<Record<string, string | undefined>>): HookContext {
  const id = typeof plugin === "string" ? plugin : plugin.manifest.id;
  const deploy = typeof plugin === "string" ? undefined : pluginDeployEnv(plugin.manifest.env, env);
  return Object.freeze({ config: pluginConfig(id, env), ...(deploy ? { env: deploy } : {}) });
}

/**
 * What the loaded plug-ins miss in production: one `"<id>: <NAME>"` per
 * declared `requiredInProduction` variable without a non-empty value.
 */
export function missingProductionEnv(plugins: readonly ProPlugin[], env: Readonly<Record<string, string | undefined>>): string[] {
  return plugins.flatMap((plugin) => (plugin.manifest.env ?? [])
    .filter((variable) => variable.requiredInProduction === true && !(env[variable.name]?.trim()))
    .map((variable) => `${plugin.manifest.id}: ${variable.name}`));
}

/**
 * A deployment variable (`manifest.env`) has one owner: the names that two or
 * more loaded plug-ins declare, as `"<NAME> (<id>, <id>)"`, in load order.
 */
export function sharedPluginEnv(plugins: readonly ProPlugin[]): string[] {
  const owners = new Map<string, string[]>();
  for (const plugin of plugins) {
    for (const name of new Set((plugin.manifest.env ?? []).map((variable) => variable.name))) {
      owners.set(name, [...(owners.get(name) ?? []), plugin.manifest.id]);
    }
  }
  return [...owners].filter(([, ids]) => ids.length > 1).map(([name, ids]) => `${name} (${ids.join(", ")})`);
}

/**
 * Every environment: the API and the worker refuse to start while two loaded
 * plug-ins declare the same deployment variable, since each would read the
 * other's value as its own.
 */
export function assertDistinctPluginEnv(plugins: readonly ProPlugin[]): void {
  const shared = sharedPluginEnv(plugins);
  if (shared.length > 0) throw new Error(`Deployment variable declared by more than one loaded plug-in: ${shared.join(", ")}.`);
}
