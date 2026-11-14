/**
 * The audit archive of the persistent gateway: the anchors a connector sends
 * over the link are chained here, so the external archive of the plug-in
 * `audit` (`auditArchive`) must be installed here as well as in the API.
 *
 * Only that port is read: no route, hook or job of any plug-in runs in the
 * gateway. Same rules as the API: `OPENEDBOT_PLUGINS` empty or unset is solo
 * (PostgreSQL only, the local chain is the anchoring); a plug-in that cannot
 * be loaded is skipped with a warning; in production a loaded plug-in missing
 * one of its `requiredInProduction` variables prevents startup and, in every
 * environment, so does a
 * plug-in id of OPENEDBOT_REQUIRED_PLUGINS that is not kept; a pool role
 * that escapes row-level security keeps no plug-in.
 */
import { isCoreEnvName } from "@openedbot/platform-config/env-schema";
import type { Db } from "@openedbot/platform-db";
import { readDbRoleFacts, tenantRoleProblem } from "@openedbot/platform-db/role-guard";
import {
  assertRequiredPlugins,
  auditArchiveOf,
  loadProPlugins,
  missingProductionEnv,
  parsePluginList,
  RequiredPluginsMissingError,
  type LoadOptions,
  type PluginSkip,
} from "@openedbot/platform-plugins";
import type { AuditArchive } from "@openedbot/runtime-link/application/audit-worm";

export type GatewayArchiveOptions = {
  env: Readonly<Record<string, string | undefined>>;
  production: boolean;
  db: Db;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** `import()` by default; injected in tests. */
  importer?: LoadOptions["importer"];
  /** The role check; injected in tests. */
  roleProblem?: (db: Db) => Promise<string | null>;
};

export async function loadGatewayAuditArchive(options: GatewayArchiveOptions): Promise<AuditArchive | null> {
  const specifiers = parsePluginList(options.env.OPENEDBOT_PLUGINS);
  const loaded = specifiers.length === 0 ? { plugins: [], skipped: [] } : await loadProPlugins(specifiers, {
    reservedEnv: isCoreEnvName,
    warn: (skip: PluginSkip) => options.log("runtime_link.pro_plugin_skipped", { specifier: skip.specifier, reason: skip.reason }),
    ...(options.importer ? { importer: options.importer } : {}),
  });
  if (options.production) {
    const missing = missingProductionEnv(loaded.plugins, options.env);
    if (missing.length > 0) throw new Error(`Required in production by the loaded plug-ins: ${missing.join(", ")}.`);
  }
  let kept = loaded.plugins;
  if (kept.length > 0) {
    let problem: string | null;
    try {
      problem = await (options.roleProblem ?? defaultRoleProblem)(options.db);
    } catch (error) {
      problem = `role check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (problem) {
      options.log("runtime_link.pro_plugins_refused", { reason: problem });
      kept = [];
    }
  }
  // OPENEDBOT_REQUIRED_PLUGINS: never relay anchors without a required archive.
  try {
    assertRequiredPlugins(options.env, kept, loaded.skipped);
  } catch (error) {
    if (error instanceof RequiredPluginsMissingError) options.log("runtime_link.required_plugins_missing", { missing: error.missing, error: error.message });
    throw error;
  }
  const archive = auditArchiveOf(kept);
  if (!archive) return null;
  options.log("runtime_link.audit_archive", { archive: archive.id });
  return archive;
}

async function defaultRoleProblem(db: Db): Promise<string | null> {
  return tenantRoleProblem(await readDbRoleFacts(db));
}
