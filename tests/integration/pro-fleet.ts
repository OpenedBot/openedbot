/**
 * The fleet routes moved to a plug-in in open-core step 11.2: an
 * integration test that drives them loads the plug-in that brings the
 * fleet capability from `OHB_PRO_PLUGINS` and mounts it exactly as the API
 * does (`proPublicRoutes` before the session, `proSessionRoutes` after it,
 * `context.host.fleet` lent by `fleetHost`). Solo, there is none: the test
 * says so on one line and exits 0.
 */
import type { Hono } from "hono";
import { CAPABILITY_ENTITLEMENTS, type ProPlugin } from "../../platform/plugins/src";
import type { Db } from "../../platform/db/src/db";
import type { ProductFeatureSource } from "../../modules/identity/src/application/entitlements";
import { fleetWorkspacesEnabled } from "../../modules/identity/src/application/entitlements";
import { loadApiProPlugins, proPluginContext, proPublicRoutes, proSessionRoutes } from "../../apps/api/src/application/pro-plugins";
import { fleetHost } from "../../apps/api/src/application/fleet-host";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";

/** The loaded plug-in that provides `fleet.workspaces`, or `null` (solo). */
export async function loadFleetPlugin(): Promise<ProPlugin | null> {
  const { plugins } = await loadApiProPlugins(process.env.OHB_PRO_PLUGINS);
  return plugins.find((plugin) => plugin.manifest.entitlements.includes(CAPABILITY_ENTITLEMENTS.fleetWorkspaces)) ?? null;
}

/** Exits 0 with one clear line when no fleet plug-in is loaded. */
export async function requireFleetPlugin(test: string): Promise<ProPlugin> {
  const plugin = await loadFleetPlugin();
  if (plugin) return plugin;
  console.log(`${test}: skipped, no plug-in provides ${CAPABILITY_ENTITLEMENTS.fleetWorkspaces} (set OHB_PRO_PLUGINS)`);
  process.exit(0);
}

/** The two mounts of the API for this plug-in, with the session gate the API puts in front. */
export function fleetMounts(plugin: ProPlugin, db: Db, config: Partial<ApiConfig>, enabled: ProductFeatureSource): { public: Hono; session: Hono } {
  const hosts = { fleet: fleetHost(db, config as ApiConfig, enabled) };
  const context = (loaded: ProPlugin) => proPluginContext(loaded, db, {}, hosts);
  return {
    public: proPublicRoutes([plugin], context),
    session: proSessionRoutes([plugin], context, {
      entitled: (caller, entitlement) => entitlement === CAPABILITY_ENTITLEMENTS.fleetWorkspaces
        ? fleetWorkspacesEnabled(enabled, caller)
        : Promise.resolve(false),
      caller: (c) => (c.var as Partial<AppVariables>).auth,
    }),
  };
}
