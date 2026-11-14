/**
 * The worker's side of the plug-in seam. It mounts nothing: it reads what the
 * loaded plug-ins declare (for the instance entitlements, `billing.enforced`),
 * runs their `onTenantDeleting` hooks in the purge transaction, and schedules
 * their `jobs` next to the core maintenance jobs.
 *
 * Same rules as the API: an empty or unset `OPENEDBOT_PLUGINS` is solo and
 * runs no query; a pool role that could bypass row-level security drops
 * every plug-in; in production, a loaded plug-in missing one of its
 * `requiredInProduction` deployment variables stops the boot (solo requires
 * none).
 */
import type { TransactionDb } from "@openedbot/platform-db";
import type { Db } from "@openedbot/platform-db";
import type { SubscriptionPort } from "@openedbot/platform-db/subscription-port";
import { readDbRoleFacts, tenantRoleProblem } from "@openedbot/platform-db/role-guard";
import { isCoreEnvName } from "@openedbot/platform-config/env-schema";
import { createEntitlementSource, PRO_ENTITLEMENTS, type EntitlementSource } from "@openedbot/identity/application/entitlements";
import type { TenantDeletingEvent, TenantDeletingListener } from "@openedbot/identity/application/tenant-deleting";
import { approvalReviewerOf, assertDistinctPluginEnv, assertRequiredPlugins, BILLING_PLUGIN_ID, declaredEntitlements, hookContext, loadProPlugins, missingProductionEnv, parsePluginList, PERMISSIONS_PLUGIN_ID, PERMISSIONS_V2_ENTITLEMENT, type LoadOptions, type ProPlugin, type PluginSkip } from "@openedbot/platform-plugins";
import type { ApprovalReviewerReadiness } from "@openedbot/runtimes/application/approval-reviewer";
import type { PermissionRuleSelector } from "@openedbot/execution/application/runner/permission-rule-sources";
import type { BackgroundJob } from "./background-jobs";

export type WorkerPro = {
  plugins: readonly ProPlugin[];
  entitlements: EntitlementSource;
  /** `billing.enforced`, resolved once at boot through the EntitlementSource. */
  billingEnforced: boolean;
  /** `null` when no loaded plug-in has an `onTenantDeleting` hook. */
  tenantDeleting: TenantDeletingListener | null;
  /** The enabled plug-in jobs, named `pro:<plugin id>:<job>`. */
  jobs: readonly BackgroundJob[];
  /** `null` without the plug-in `permissions`: every gate reads the core rules. */
  permissionRules: PermissionRuleSelector | null;
  /** The reviewer of the plug-in `permissions` (`approvalReviewer`); `null`: no reviewer, `auto` acts as `manual`. */
  approvalReviewer: ApprovalReviewerReadiness | null;
  /**
   * `billing.subscriptions` of the plug-in billing (step 8d), `null` without
   * it: the queue and the routines then read `NO_SUBSCRIPTIONS` (no paywall).
   */
  subscriptions: SubscriptionPort | null;
};

export type WorkerProLog = {
  skipped(skip: PluginSkip): void;
  refused(reason: string): void;
  /** A declared job left unscheduled at boot (`enabled` false or throwing). */
  jobDisabled?(job: { readonly name: string; readonly reason: string }): void;
};

/** The worker reads no product switch; only instance entitlements matter here. */
const NO_FEATURES = async () => ({ connectorOnlyEnrollment: false });

export async function loadWorkerPro(
  env: Readonly<Record<string, string | undefined>>,
  db: Db,
  config: { billingEnforced: boolean; environment?: string },
  log: WorkerProLog,
  options: Pick<LoadOptions, "importer"> = {},
): Promise<WorkerPro> {
  const loaded = await loadProPlugins(parsePluginList(env.OPENEDBOT_PLUGINS), { reservedEnv: isCoreEnvName, ...options, warn: log.skipped });
  // Every environment: one owner per deployment variable, as in the API.
  assertDistinctPluginEnv(loaded.plugins);
  if (config.environment === "production") assertWorkerProPluginProductionEnv(loaded.plugins, env);
  const plugins = await guardWorkerPlugins(loaded.plugins, db, log.refused);
  // OPENEDBOT_REQUIRED_PLUGINS: fail fast rather than run without them.
  assertRequiredPlugins(env, plugins, loaded.skipped);
  const entitlements = createEntitlementSource({
    features: NO_FEATURES,
    billingEnforced: config.billingEnforced,
    pro: { declared: declaredEntitlements(plugins), grant: async () => false },
  });
  return {
    plugins,
    entitlements,
    billingEnforced: await entitlements.has(PRO_ENTITLEMENTS.billingEnforced),
    tenantDeleting: tenantDeletingHooks(plugins, env),
    jobs: proJobs(plugins, db, env, log.jobDisabled),
    permissionRules: permissionRuleSelector(plugins, env),
    approvalReviewer: approvalReviewerOf(plugins),
    subscriptions: (plugins.find((plugin) => plugin.manifest.id === BILLING_PLUGIN_ID)?.billing?.subscriptions as unknown as SubscriptionPort | undefined) ?? null,
  };
}

/**
 * Production only, the API's rule on the worker's side: the worker refuses to
 * start while a LOADED plug-in (billing included) misses one of its
 * `requiredInProduction` deployment variables. Checked on what the loader
 * kept, before the role guard; solo requires none.
 */
export function assertWorkerProPluginProductionEnv(plugins: readonly ProPlugin[], env: Readonly<Record<string, string | undefined>>): void {
  const missing = missingProductionEnv(plugins, env);
  if (missing.length > 0) throw new Error(`Required in production by the loaded plug-ins: ${missing.join(", ")}.`);
}

async function guardWorkerPlugins(plugins: readonly ProPlugin[], db: Db, refuse: (reason: string) => void): Promise<readonly ProPlugin[]> {
  if (plugins.length === 0) return plugins;
  let problem: string | null;
  try {
    problem = tenantRoleProblem(await readDbRoleFacts(db));
  } catch (error) {
    problem = `role check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!problem) return plugins;
  refuse(problem);
  return [];
}

/** Every plug-in hook, one after the other, in load order; the first failure stops the purge. */
export function tenantDeletingHooks(
  plugins: readonly ProPlugin[],
  env: Readonly<Record<string, string | undefined>> = {},
): TenantDeletingListener | null {
  const hooks = plugins.flatMap((plugin) => {
    const hook = plugin.hooks?.onTenantDeleting;
    return hook ? [{ id: plugin.manifest.id, hook, context: hookContext(plugin, env) }] : [];
  });
  if (hooks.length === 0) return null;
  return async (tx: TransactionDb, event: TenantDeletingEvent) => {
    for (const { id, hook, context } of hooks) {
      try {
        await hook(tx, event, context);
      } catch (error) {
        throw new Error(`plug-in ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  };
}

/**
 * The plug-in jobs as worker background jobs. `enabled` is read once, here,
 * with the plug-in's configuration: a job switched off by its configuration
 * is not scheduled at all, and says so once.
 */
export function proJobs(
  plugins: readonly ProPlugin[],
  db: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
  disabled: (job: { readonly name: string; readonly reason: string }) => void = () => {},
): BackgroundJob[] {
  return plugins.flatMap((plugin) => {
    const context = hookContext(plugin, env);
    return (plugin.jobs ?? []).flatMap((job): BackgroundJob[] => {
      const name = `pro:${plugin.manifest.id}:${job.name}`;
      let enabled = true;
      try {
        enabled = job.enabled ? job.enabled(context) === true : true;
        if (!enabled) disabled({ name, reason: "disabled by its configuration" });
      } catch (error) {
        enabled = false;
        disabled({ name, reason: `enabled() failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (!enabled) return [];
      return [{ name, everyMs: job.everyMs, run: (signal) => job.run(db, { ...context, signal }) }];
    });
  });
}

/**
 * PERM2 v2: the plug-in `permissions` (the loader refuses `permissionRules`
 * anywhere else) decides the rules of the organizations its `entitlementsFor`
 * grants `permissions.v2`; every other organization keeps the core rules,
 * so a plug-in with `permissions.v2` off decides exactly as solo. A hook
 * that throws is a `permissions.v2` it does not grant (the core rules).
 */
export function permissionRuleSelector(
  plugins: readonly ProPlugin[],
  env: Readonly<Record<string, string | undefined>> = {},
): PermissionRuleSelector | null {
  const plugin = plugins.find((candidate) => candidate.manifest.id === PERMISSIONS_PLUGIN_ID && candidate.permissionRules);
  const source = plugin?.permissionRules;
  const hook = plugin?.hooks?.entitlementsFor;
  if (!plugin || !source || !hook) return null;
  const context = hookContext(plugin, env);
  return async (organizationId) => ((await hook(organizationId, context)).includes(PERMISSIONS_V2_ENTITLEMENT) ? source : null);
}

/**
 * PERM2-7: the passes of the reviewer of the plug-in `permissions`
 * (`approvalReviewer.passes`) as worker background jobs, named
 * `pro:permissions:<pass>`, single-flight like the core passes. `host` is
 * what the worker lends them (`{ config }`). Solo: none, and the core's
 * `approval-review-handoff` pass hands any gate left under review to a person.
 */
export function reviewerJobs(
  plugins: readonly ProPlugin[],
  db: unknown,
  host: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
): BackgroundJob[] {
  const plugin = plugins.find((candidate) => candidate.manifest.id === PERMISSIONS_PLUGIN_ID && candidate.approvalReviewer);
  const reviewer = plugin?.approvalReviewer;
  if (!plugin || !reviewer) return [];
  const context = hookContext(plugin, env);
  return reviewer.passes.map((pass): BackgroundJob => ({
    name: `pro:${plugin.manifest.id}:${pass.name}`,
    everyMs: pass.everyMs,
    run: (signal, track) => pass.run(db, { ...context, signal, track: track ?? (() => undefined), host }),
  }));
}
