import {
  BILLING_PLUGIN_ID,
  SUBSCRIPTION_PORT_MEMBERS,
  ALIAS_HEADER_RE,
  ALIAS_PATH_RE,
  PAYMENT_WEBHOOK_PATH_RE,
  PAYMENT_WEBHOOK_RESERVED_ROOTS,
  SESSION_ALIAS_ROOT,
  SESSION_ALIAS_TARGETS,
  ALIAS_QUERY_RE,
  ENTITLEMENT_RE,
  isCapabilityEntitlement,
  PERMISSIONS_V2_ENTITLEMENT,
  PLUGIN_API_VERSION,
  PLUGIN_ENV_MAX,
  PLUGIN_ENV_NAME_RE,
  PLUGIN_ID_RE,
  WORKER_JOB_MIN_EVERY_MS,
  WORKER_JOB_NAME_RE,
  type CompatAliases,
  type ProPlugin,
} from "./contract";

export type PluginSkip = { readonly specifier: string; readonly reason: string };

export type LoadedPlugins = {
  readonly plugins: readonly ProPlugin[];
  readonly skipped: readonly PluginSkip[];
};

export type LoadOptions = {
  /** `import()` by default; injected in tests. */
  readonly importer?: (specifier: string) => Promise<unknown>;
  /** License or plan gate for a plug-in as a whole; allow everything by default. */
  readonly allow?: (plugin: ProPlugin) => boolean | Promise<boolean>;
  /** Warnings for every skipped plug-in. */
  readonly warn?: (skip: PluginSkip) => void;
  /**
   * Names a plug-in may not declare in `manifest.env` (the core's own
   * variables); the API and the worker pass their environment schema.
   */
  readonly reservedEnv?: (name: string) => boolean;
};

/**
 * Parses a comma-separated list of module specifiers (the value of an env
 * variable such as `OPENEDBOT_PLUGINS`). Empty or blank means no plug-in.
 */
export function parsePluginList(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const specifier = part.trim();
    if (specifier) seen.add(specifier);
  }
  return [...seen];
}

/** The reason a value is not a usable plug-in, or `null` when it is. */
export function invalidPluginReason(value: unknown, options: Pick<LoadOptions, "reservedEnv"> = {}): string | null {
  if (!isRecord(value)) return "the module does not export a plug-in object";
  const manifest = value.manifest;
  if (!isRecord(manifest)) return "missing manifest";
  if (typeof manifest.id !== "string" || !PLUGIN_ID_RE.test(manifest.id)) return "invalid manifest.id";
  if (typeof manifest.version !== "string" || manifest.version.length === 0) return "invalid manifest.version";
  if (manifest.pluginApi !== PLUGIN_API_VERSION) {
    return `built for plug-in API ${String(manifest.pluginApi)}, core provides ${PLUGIN_API_VERSION}`;
  }
  if (!Array.isArray(manifest.entitlements)) return "invalid manifest.entitlements";
  for (const entitlement of manifest.entitlements) {
    if (typeof entitlement !== "string" || !ENTITLEMENT_RE.test(entitlement)
      || !(entitlement.startsWith(`${manifest.id}.`) || isCapabilityEntitlement(entitlement))) {
      return `invalid entitlement ${JSON.stringify(entitlement)}`;
    }
  }
  if (manifest.env !== undefined) {
    const problem = invalidEnvReason(manifest.env, options.reservedEnv);
    if (problem) return problem;
  }
  if (value.api !== undefined) {
    if (!Array.isArray(value.api)) return "api must be an array";
    for (const mount of value.api) {
      if (!isRecord(mount)) return "invalid api mount";
      if (typeof mount.prefix !== "string" || !/^\/[a-z0-9/_-]*$/.test(mount.prefix) || mount.prefix.includes("..")) {
        return "invalid api mount prefix";
      }
      if (mount.access !== "public" && mount.access !== "session") return "invalid api mount access";
      if (typeof mount.build !== "function") return "api mount without build()";
      if (mount.access === "session" && typeof mount.entitlement !== "string") {
        return "a session api mount must name its entitlement";
      }
      if (mount.entitlement !== undefined && !(manifest.entitlements as unknown[]).includes(mount.entitlement)) {
        return `api mount uses undeclared entitlement ${JSON.stringify(mount.entitlement)}`;
      }
    }
  }
  if (value.migrations !== undefined && (!isRecord(value.migrations) || typeof value.migrations.directory !== "string")) {
    return "invalid migrations";
  }
  if (value.console !== undefined && (!isRecord(value.console) || typeof value.console.module !== "string")) {
    return "invalid console";
  }
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs)) return "invalid jobs";
    const names = new Set<string>();
    for (const job of value.jobs as unknown[]) {
      if (!isRecord(job) || typeof job.name !== "string" || !WORKER_JOB_NAME_RE.test(job.name)) return "invalid job name";
      if (names.has(job.name)) return `duplicate job ${JSON.stringify(job.name)}`;
      names.add(job.name);
      if (typeof job.everyMs !== "number" || !Number.isSafeInteger(job.everyMs) || job.everyMs < WORKER_JOB_MIN_EVERY_MS) {
        return `job ${JSON.stringify(job.name)}: everyMs must be an integer of at least ${WORKER_JOB_MIN_EVERY_MS}`;
      }
      if (typeof job.run !== "function") return `job ${JSON.stringify(job.name)} without run()`;
      if (job.enabled !== undefined && typeof job.enabled !== "function") return `job ${JSON.stringify(job.name)}: invalid enabled`;
    }
  }
  if (value.impersonation !== undefined && (!isRecord(value.impersonation) || typeof value.impersonation.claim !== "function")) {
    return "invalid impersonation";
  }
  if (value.supportDesk !== undefined && (!isRecord(value.supportDesk) || typeof value.supportDesk.build !== "function")) {
    return "invalid supportDesk";
  }
  if (value.permissionRules !== undefined) {
    if (!isRecord(value.permissionRules) || typeof value.permissionRules.read !== "function") return "invalid permissionRules";
    for (const member of ["reviewRules", "unattended"] as const) {
      if (value.permissionRules[member] !== undefined && typeof value.permissionRules[member] !== "function") return `invalid permissionRules.${member}`;
    }
    if (manifest.id !== "permissions" || !(manifest.entitlements as unknown[]).includes(PERMISSIONS_V2_ENTITLEMENT)) {
      return `permissionRules needs the plug-in "permissions" declaring ${JSON.stringify(PERMISSIONS_V2_ENTITLEMENT)}`;
    }
  }
  if (value.hooks !== undefined && !isRecord(value.hooks)) return "invalid hooks";
  if (isRecord(value.hooks) && value.hooks.onOrganizationCreating !== undefined) {
    if (typeof value.hooks.onOrganizationCreating !== "function") return "invalid hooks.onOrganizationCreating";
    if (manifest.id !== BILLING_PLUGIN_ID) return `onOrganizationCreating needs the plug-in ${JSON.stringify(BILLING_PLUGIN_ID)}`;
  }
  if (value.billing !== undefined) {
    if (!isRecord(value.billing) || typeof value.billing.webhook !== "function") return "invalid billing";
    const webhookPath = value.billing.webhookPath;
    if (typeof webhookPath !== "string" || !PAYMENT_WEBHOOK_PATH_RE.test(webhookPath)) return "invalid billing.webhookPath";
    if (PAYMENT_WEBHOOK_RESERVED_ROOTS.some((root) => webhookPath === root || webhookPath.startsWith(`${root}/`))) {
      return `billing.webhookPath ${JSON.stringify(webhookPath)} is reserved`;
    }
    const subscriptions = value.billing.subscriptions;
    if (subscriptions !== undefined
      && (!isRecord(subscriptions) || SUBSCRIPTION_PORT_MEMBERS.some((member) => typeof subscriptions[member] !== "function"))) {
      return "invalid billing.subscriptions";
    }
    if (manifest.id !== BILLING_PLUGIN_ID) return `billing needs the plug-in ${JSON.stringify(BILLING_PLUGIN_ID)}`;
  }
  if (value.aliases !== undefined) {
    const problem = invalidAliasesReason(value.aliases, manifest.id, manifest.entitlements as string[]);
    if (problem) return problem;
  }
  return null;
}

/**
 * Prefixes of the core's own variables: `OPENEDBOT_`, and `OHB_`, the prefix
 * they carried until the OPENEDBOT_ rename (still read for one release).
 */
const CORE_ENV_PREFIXES = ["OPENEDBOT_", "OHB_"] as const; // rename:keep

function invalidEnvReason(declared: unknown, reserved: ((name: string) => boolean) | undefined): string | null {
  if (!Array.isArray(declared) || declared.length > PLUGIN_ENV_MAX) return "invalid manifest.env";
  const names = new Set<string>();
  for (const variable of declared as unknown[]) {
    if (!isRecord(variable) || typeof variable.name !== "string" || !PLUGIN_ENV_NAME_RE.test(variable.name)) return "invalid manifest.env entry";
    if (variable.requiredInProduction !== undefined && typeof variable.requiredInProduction !== "boolean") return "invalid manifest.env entry";
    const name = variable.name;
    if (CORE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) || reserved?.(name)) return `manifest.env ${JSON.stringify(name)} is a core variable`;
    if (names.has(name)) return `duplicate manifest.env ${JSON.stringify(name)}`;
    names.add(name);
  }
  return null;
}

/** Reserved roots an alias path may neither leave nor enter. */
const ALIAS_RESERVED_ROOTS = ["/api/pro", "/internal"];

function invalidAliasesReason(aliases: unknown, id: string, entitlements: readonly string[]): string | null {
  if (!isRecord(aliases)) return "invalid aliases";
  const lists: Record<string, unknown> = aliases;
  for (const key of Object.keys(lists)) {
    if (!["headers", "queries", "paths", "entitlements"].includes(key)) return `invalid aliases.${key}`;
    const list = lists[key];
    if (!Array.isArray(list)) return `invalid aliases.${key}`;
    for (const alias of list as unknown[]) {
      if (!isRecord(alias) || typeof alias.from !== "string" || typeof alias.to !== "string" || alias.from === alias.to) {
        return `invalid aliases.${key} entry`;
      }
      if (alias.exact !== undefined && (key !== "paths" || typeof alias.exact !== "boolean")) {
        return `invalid aliases.${key} entry`;
      }
      const { from, to } = alias as { from: string; to: string };
      if (key === "headers" && !(ALIAS_HEADER_RE.test(from) && ALIAS_HEADER_RE.test(to))) return `invalid header alias ${JSON.stringify(from)}`;
      if (key === "queries" && !(ALIAS_QUERY_RE.test(from) && ALIAS_QUERY_RE.test(to))) return `invalid query alias ${JSON.stringify(from)}`;
      if (key === "paths") {
        if (!ALIAS_PATH_RE.test(from) || !ALIAS_PATH_RE.test(to)) return `invalid path alias ${JSON.stringify(from)}`;
        const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
        if (ALIAS_RESERVED_ROOTS.some((root) => under(from, root)) || from.split("/").length < 3) {
          return `path alias ${JSON.stringify(from)} is reserved or too broad`;
        }
        if (under(to, from) || under(from, to)) return `path alias ${JSON.stringify(from)} loops`;
        // The session root: one exact path, towards the core's allowlist, never a subtree.
        if (under(from, SESSION_ALIAS_ROOT) || under(to, SESSION_ALIAS_ROOT)) {
          if ((alias as { exact?: boolean }).exact !== true || !SESSION_ALIAS_TARGETS.includes(to) || from === SESSION_ALIAS_ROOT) {
            return `path alias ${JSON.stringify(from)} into ${SESSION_ALIAS_ROOT} must be exact and target an allowlisted path`;
          }
        }
      }
      if (key === "entitlements") {
        // The old key is the plug-in's own; the new one is one it declares.
        if (!ENTITLEMENT_RE.test(from) || !from.startsWith(`${id}.`) || !entitlements.includes(from)) {
          return `entitlement alias ${JSON.stringify(from)} must be declared under the plug-in id`;
        }
        if (!entitlements.includes(to)) return `entitlement alias target ${JSON.stringify(to)} is not declared`;
      }
    }
  }
  return null;
}

/**
 * Loads the listed plug-ins. Never throws: a missing package, an invalid
 * export, an incompatible API version, a duplicate id or a refused license
 * skips that plug-in, reports it through `warn`, and the core starts anyway.
 */
export async function loadProPlugins(specifiers: readonly string[], options: LoadOptions = {}): Promise<LoadedPlugins> {
  const importer = options.importer ?? ((specifier: string) => import(specifier));
  const plugins: ProPlugin[] = [];
  const skipped: PluginSkip[] = [];
  const skip = (specifier: string, reason: string) => {
    const entry = { specifier, reason };
    skipped.push(entry);
    options.warn?.(entry);
  };

  for (const specifier of specifiers) {
    let module: unknown;
    try {
      module = await importer(specifier);
    } catch (error) {
      skip(specifier, `cannot import: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const candidate = isRecord(module) && "default" in module ? module.default : module;
    const reason = invalidPluginReason(candidate, options);
    if (reason) {
      skip(specifier, reason);
      continue;
    }
    const plugin = candidate as ProPlugin;
    if (plugins.some((loaded) => loaded.manifest.id === plugin.manifest.id)) {
      skip(specifier, `duplicate plug-in id ${plugin.manifest.id}`);
      continue;
    }
    // A capability has one provider: the second plug-in claiming it is refused.
    const claimed = plugin.manifest.entitlements.find((entitlement) => isCapabilityEntitlement(entitlement)
      && plugins.some((loaded) => loaded.manifest.entitlements.includes(entitlement)));
    if (claimed) {
      skip(specifier, `capability ${claimed} already provided`);
      continue;
    }
    let allowed = true;
    try {
      allowed = options.allow ? await options.allow(plugin) : true;
    } catch (error) {
      allowed = false;
      skip(specifier, `license check failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!allowed) {
      skip(specifier, "not allowed by the license");
      continue;
    }
    plugins.push(plugin);
  }
  return { plugins, skipped };
}

/** The compatibility aliases of the loaded plug-ins, by kind (`CompatAliases`). */
export function compatAliasesOf(plugins: readonly ProPlugin[]): Required<CompatAliases> {
  const all = (kind: keyof CompatAliases) => plugins.flatMap((plugin) => plugin.aliases?.[kind] ?? []);
  return { headers: all("headers"), queries: all("queries"), paths: all("paths"), entitlements: all("entitlements") };
}

/** The capability entitlements (`CAPABILITY_ENTITLEMENTS`) a plug-in declares, by capability (`fleet`). */
export function capabilitiesOf(plugin: ProPlugin): string[] {
  return [...new Set(plugin.manifest.entitlements.filter(isCapabilityEntitlement).map((entitlement) => entitlement.split(".")[0]!))];
}

/** Every entitlement the loaded plug-ins can grant. */
export function declaredEntitlements(plugins: readonly ProPlugin[]): Set<string> {
  return new Set(plugins.flatMap((plugin) => plugin.manifest.entitlements));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
