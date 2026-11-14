import { Hono } from "hono";
import { isUuid } from "@openedbot/contracts-primitives";
import { logger } from "@openedbot/platform-observability";
import { invalidateSnapshots, readThrough, type RuntimeReadKind } from "@openedbot/runtimes/application/runtime-read-snapshots";
import { matchInternalBearer, type InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import { internalAuthMetrics } from "@openedbot/platform-observability/internal-auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { IntegrationRouteContext } from "./runtime-integration-context";
import { keepIntegrations, liveIntegrationsRead } from "./runtime-integration-inventory-routes";
import { keepMcp, liveMcpRead } from "./runtime-integration-mcp-routes";
import { liveProfilesRead } from "./runtime-integration-profile-routes";
import type { HermesClientConfig } from "@openedbot/hermes";
import { RELAY_FEATURE_PROFILE_INVENTORY } from "@openedbot/contracts-connector/features";

/**
 * Warming a runtime's inventory, on a signal from its host.
 *
 * The connector sends `inventory.changed` when the files behind
 * the inventory move (toolsets, MCP servers and connections, skills) and once
 * on every connection. The broker records it (`runtimes.inventory_changed_at`)
 * then calls `warm`: the host is reread here, in the background, with the same
 * composition as the routes, and the snapshot is current before
 * Réglages › Connecteurs opens. Nothing blocks a request: a failed
 * read is logged, and the route then serves the previous snapshot by
 * rereading it itself.
 *
 * Per runtime, only one reread at a time; a signal received during it
 * schedules ONE more, which starts at the end: the latest change is
 * never lost, and a burst never costs more than two reads.
 */
export type InventoryWarmer = {
  warm(organizationId: string, runtimeId: string): void;
  /** Tests: waits for the rereads in progress to finish. */
  idle(): Promise<void>;
};

const WARMED_KINDS: readonly RuntimeReadKind[] = ["integrations", "mcp", "profiles"];

export function createInventoryWarmer(ctx: IntegrationRouteContext): InventoryWarmer {
  const { db, config, readRuntime, snapshots } = ctx;
  const running = new Map<string, Promise<void>>();
  const pending = new Set<string>();

  const readOnce = async (organizationId: string, runtimeId: string): Promise<void> => {
    const runtime = await readRuntime(db, config, organizationId);
    // The active runtime has changed, or the link dropped in the meantime: the
    // next connection will send its own signal.
    if (!runtime || runtime.id !== runtimeId) return;
    const reads = await Promise.allSettled([
      readThrough(snapshots, {
        organizationId, runtimeId, kind: "integrations", fresh: true,
        keep: keepIntegrations, read: liveIntegrationsRead(ctx, runtime),
      }),
      readThrough(snapshots, {
        organizationId, runtimeId, kind: "mcp", fresh: true,
        keep: keepMcp, read: liveMcpRead(ctx, runtime),
      }),
      warmProfiles(organizationId, runtime),
    ]);
    reads.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.warn({ event: "runtime.inventory_warm_failed", runtimeId, kind: WARMED_KINDS[index], error: String(result.reason) }, "runtime inventory warm read failed");
      }
    });
  };

  /**
   * The profiles carry each bot's MCP connections, which the host writes when
   * an authorization ends or a bot is disconnected, possibly with no openedbot
   * request in flight to invalidate them. Reread like the other two families
   * (one more interpreter on the host per signal), so Réglages › Connecteurs
   * opens warm instead of paying a cold read. A host that does not announce
   * the inventory, or a reread that fails, drops the old snapshot instead: the
   * next display reads live rather than answer from before the change.
   */
  const warmProfiles = async (organizationId: string, runtime: { id: string; client: HermesClientConfig; linkFeatures?: string[] }): Promise<void> => {
    if (runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_INVENTORY)) {
      try {
        await readThrough(snapshots, {
          organizationId, runtimeId: runtime.id, kind: "profiles", fresh: true, read: liveProfilesRead(ctx, runtime),
        });
        return;
      } catch (error) {
        await invalidateSnapshots(snapshots, organizationId, "profiles");
        throw error;
      }
    }
    await invalidateSnapshots(snapshots, organizationId, "profiles");
  };

  const run = (organizationId: string, runtimeId: string): Promise<void> => {
    const key = `${organizationId}\u0000${runtimeId}`;
    const work = (async () => {
      do {
        pending.delete(key);
        try {
          await readOnce(organizationId, runtimeId);
        } catch (error) {
          // `readRuntime` throws when the link is unreachable: nothing to reread.
          logger.warn({ event: "runtime.inventory_warm_failed", runtimeId, error: String(error) }, "runtime inventory warm failed");
        }
      } while (pending.has(key));
    })().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  };

  return {
    warm(organizationId, runtimeId) {
      const key = `${organizationId}\u0000${runtimeId}`;
      if (running.has(key)) {
        pending.add(key);
        return;
      }
      void run(organizationId, runtimeId);
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
  };
}

/**
 * `POST /internal/runtime-inventory/changed`: the signal of a separate link
 * gateway (`RUNTIME_LINK_MODE=separate`), which receives `inventory.changed`
 * in its own process and does not have the inventory composition. Same
 * secret: that of the inventory signal (`INVENTORY_INTERNAL_TOKEN`), not that
 * of the events. The body names only a runtime: the
 * reread goes through `readRuntime`, under the organization's tenant, and does
 * nothing if that runtime is no longer its active runtime.
 */
export function internalInventoryRoutes(internal: InternalSecretsWith<"inventory">, warmer: InventoryWarmer): Hono {
  const routes = new Hono();
  routes.post("/changed", async (context) => {
    const accepted = matchInternalBearer(internal, "inventory", context.req.header("Authorization"));
    internalAuthMetrics.recordBearer("inventory", accepted ? "role" : "refused", "/internal/runtime-inventory/changed");
    if (!accepted) throw new HttpError(401, "WORKER_AUTH_INVALID", "Authentification interne invalide.");
    const body = await jsonBody(context.req.raw) as { organizationId?: unknown; runtimeId?: unknown };
    if (typeof body.organizationId !== "string" || !isUuid(body.organizationId)
      || typeof body.runtimeId !== "string" || !isUuid(body.runtimeId)) {
      throw new HttpError(400, "INVENTORY_SIGNAL_INVALID", "Le signal d’inventaire est invalide.");
    }
    warmer.warm(body.organizationId, body.runtimeId);
    return context.body(null, 202);
  });
  return routes;
}
