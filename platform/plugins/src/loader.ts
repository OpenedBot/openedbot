import {
  AUDIT_ARCHIVE_ID_MAX,
  AUDIT_PLUGIN_ID,
  BILLING_PLUGIN_ID,
  SUBSCRIPTION_PORT_MEMBERS,
  ALIAS_PATH_RE,
  PAYMENT_WEBHOOK_PATH_RE,
  PAYMENT_WEBHOOK_RESERVED_ROOTS,
  SESSION_ALIAS_ROOT,
  ENTITLEMENT_RE,
  PERMISSIONS_PLUGIN_ID,
  PERMISSIONS_V2_ENTITLEMENT,
  REVIEWER_PASS_MIN_EVERY_MS,
  PLUGIN_API_VERSION,
  PLUGIN_ENV_MAX,
  PLUGIN_ENV_NAME_RE,
  PLUGIN_ID_RE,
  WORKER_JOB_MIN_EVERY_MS,
  WORKER_JOB_NAME_RE,
  type ApprovalReviewerPort,
  type AuditArchivePort,
  type CompatAlias,
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
    if (typeof entitlement !== "string" || !ENTITLEMENT_RE.test(entitlement) || !entitlement.startsWith(`${manifest.id}.`)) {
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
  // Jobs and reviewer passes share one worker namespace (`pro:<id>:<name>`,
  // keyed by name in the scheduler): a name used twice would run only once.
  const jobNames = new Set<string>();
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs)) return "invalid jobs";
    for (const job of value.jobs as unknown[]) {
      if (!isRecord(job) || typeof job.name !== "string" || !WORKER_JOB_NAME_RE.test(job.name)) return "invalid job name";
      if (jobNames.has(job.name)) return `duplicate job ${JSON.stringify(job.name)}`;
      jobNames.add(job.name);
      if (typeof job.everyMs !== "number" || !Number.isSafeInteger(job.everyMs) || job.everyMs < WORKER_JOB_MIN_EVERY_MS) {
        return `job ${JSON.stringify(job.name)}: everyMs must be an integer of at least ${WORKER_JOB_MIN_EVERY_MS}`;
      }
      if (typeof job.run !== "function") return `job ${JSON.stringify(job.name)} without run()`;
      if (job.enabled !== undefined && typeof job.enabled !== "function") return `job ${JSON.stringify(job.name)}: invalid enabled`;
    }
  }
  if (value.permissionRules !== undefined) {
    if (!isRecord(value.permissionRules) || typeof value.permissionRules.read !== "function") return "invalid permissionRules";
    if (value.permissionRules.unattended !== undefined && typeof value.permissionRules.unattended !== "function") return "invalid permissionRules.unattended";
    if (manifest.id !== PERMISSIONS_PLUGIN_ID || !(manifest.entitlements as unknown[]).includes(PERMISSIONS_V2_ENTITLEMENT)) {
      return `permissionRules needs the plug-in "permissions" declaring ${JSON.stringify(PERMISSIONS_V2_ENTITLEMENT)}`;
    }
  }
  if (value.approvalReviewer !== undefined) {
    const reviewer = value.approvalReviewer;
    if (!isRecord(reviewer) || typeof reviewer.ready !== "function" || !Array.isArray(reviewer.passes)) return "invalid approvalReviewer";
    const names = new Set<string>();
    for (const pass of reviewer.passes as unknown[]) {
      if (!isRecord(pass) || typeof pass.name !== "string" || !WORKER_JOB_NAME_RE.test(pass.name)) return "invalid approvalReviewer pass name";
      if (names.has(pass.name)) return `duplicate approvalReviewer pass ${JSON.stringify(pass.name)}`;
      if (jobNames.has(pass.name)) return `approvalReviewer pass ${JSON.stringify(pass.name)} has the name of a job`;
      names.add(pass.name);
      if (typeof pass.everyMs !== "number" || !Number.isSafeInteger(pass.everyMs) || pass.everyMs < REVIEWER_PASS_MIN_EVERY_MS) {
        return `approvalReviewer pass ${JSON.stringify(pass.name)}: everyMs must be an integer of at least ${REVIEWER_PASS_MIN_EVERY_MS}`;
      }
      if (typeof pass.run !== "function") return `approvalReviewer pass ${JSON.stringify(pass.name)} without run()`;
    }
    if (manifest.id !== PERMISSIONS_PLUGIN_ID) return `approvalReviewer needs the plug-in ${JSON.stringify(PERMISSIONS_PLUGIN_ID)}`;
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
  if (value.auditArchive !== undefined) {
    const archive = value.auditArchive;
    if (!isRecord(archive) || typeof archive.put !== "function" || typeof archive.get !== "function") return "invalid auditArchive";
    if (typeof archive.id !== "string" || archive.id.length === 0 || archive.id.length > AUDIT_ARCHIVE_ID_MAX) return "invalid auditArchive.id";
    if (archive.orphaned !== undefined && typeof archive.orphaned !== "function") return "invalid auditArchive.orphaned";
    if (manifest.id !== AUDIT_PLUGIN_ID) return `auditArchive needs the plug-in ${JSON.stringify(AUDIT_PLUGIN_ID)}`;
  }
  if (value.aliases !== undefined) {
    const problem = invalidAliasesReason(value.aliases);
    if (problem) return problem;
  }
  return null;
}

/** Prefix of the core's own variables. */
const CORE_ENV_PREFIXES = ["OPENEDBOT_"] as const;

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

function invalidAliasesReason(aliases: unknown): string | null {
  if (!isRecord(aliases)) return "invalid aliases";
  for (const key of Object.keys(aliases)) {
    if (key !== "paths") return `invalid aliases.${key}`;
  }
  const list = aliases.paths;
  if (list === undefined) return null;
  if (!Array.isArray(list)) return "invalid aliases.paths";
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  for (const alias of list as unknown[]) {
    if (!isRecord(alias) || typeof alias.from !== "string" || typeof alias.to !== "string" || alias.from === alias.to) {
      return "invalid aliases.paths entry";
    }
    if (alias.exact !== undefined && typeof alias.exact !== "boolean") return "invalid aliases.paths entry";
    const { from, to } = alias as { from: string; to: string };
    if (!ALIAS_PATH_RE.test(from) || !ALIAS_PATH_RE.test(to)) return `invalid path alias ${JSON.stringify(from)}`;
    if (ALIAS_RESERVED_ROOTS.some((root) => under(from, root)) || from.split("/").length < 3) {
      return `path alias ${JSON.stringify(from)} is reserved or too broad`;
    }
    if (under(to, from) || under(from, to)) return `path alias ${JSON.stringify(from)} loops`;
    if (under(from, SESSION_ALIAS_ROOT) || under(to, SESSION_ALIAS_ROOT)) {
      return `path alias ${JSON.stringify(from)} touches ${SESSION_ALIAS_ROOT}`;
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

/** The path aliases of the loaded plug-ins (`CompatAliases.paths`). */
export function compatPathAliasesOf(plugins: readonly ProPlugin[]): CompatAlias[] {
  return plugins.flatMap((plugin) => plugin.aliases?.paths ?? []);
}

/**
 * The audit archive of the loaded plug-in `audit` (`AuditArchivePort`), or
 * `null`: the core's default, PostgreSQL only.
 */
export function auditArchiveOf(plugins: readonly ProPlugin[]): AuditArchivePort | null {
  return plugins.find((plugin) => plugin.manifest.id === AUDIT_PLUGIN_ID)?.auditArchive ?? null;
}

/**
 * The automatic reviewer of the loaded plug-in `permissions`
 * (`ApprovalReviewerPort`), or `null`: the core's default, no reviewer.
 */
export function approvalReviewerOf(plugins: readonly ProPlugin[]): ApprovalReviewerPort | null {
  return plugins.find((plugin) => plugin.manifest.id === PERMISSIONS_PLUGIN_ID)?.approvalReviewer ?? null;
}

/** Every entitlement the loaded plug-ins can grant. */
export function declaredEntitlements(plugins: readonly ProPlugin[]): Set<string> {
  return new Set(plugins.flatMap((plugin) => plugin.manifest.entitlements));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
