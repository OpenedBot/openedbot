import type { HermesClientConfig } from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import {
  invalidateSnapshots,
  postgresSnapshotStore,
  type SnapshotStore,
} from "@openedbot/runtimes/application/runtime-read-snapshots";
import type { InventoryClient, RuntimeReader } from "./runtime-integration-constants";
import { publicWriteError, safeTimeout } from "./runtime-integration-public";

export type IntegrationRouteDependencies = {
  readRuntime?: RuntimeReader;
  clientFactory?: (config: HermesClientConfig) => InventoryClient;
  timeoutMs?: number;
  now?: () => Date;
  snapshotStore?: SnapshotStore;
};

/**
 * What the runtime integration routes share: the organization's
 * runtime, its client, the read snapshots, and the write
 * gates (`requireWritableRuntime*`).
 */
export function integrationRouteContext(db: Db, config: ApiConfig, dependencies: IntegrationRouteDependencies) {
  const readRuntime = dependencies.readRuntime ?? readRuntimeSecret;
  const clientFactory = dependencies.clientFactory ?? runtimeAdminClient;
  const timeoutMs = safeTimeout(dependencies.timeoutMs);
  const now = dependencies.now ?? (() => new Date());
  const snapshots = dependencies.snapshotStore ?? postgresSnapshotStore(db);
  const invalidateIntegrationReads = (organizationId: string) => Promise.all([
    invalidateSnapshots(snapshots, organizationId, "mcp"),
    invalidateSnapshots(snapshots, organizationId, "integrations"),
    // A bot connection is recorded in its profile's configuration.
    invalidateSnapshots(snapshots, organizationId, "profiles"),
  ]);

  /**
   * What the host advertises, for a READ: the list the link has already
   * recorded (hello, capabilities frame, « Tester ») when the runtime goes
   * through the connector, otherwise a `hostCapabilities` round trip. Each round trip costs
   * a fresh Python probe on the host (about 1.5 s, measured on 2026-10-21);
   * the Marketplace and the model routes already read the recorded list. A
   * write, for its part, always asks the host again (`requireWritableRuntime`).
   */
  const announcedFeatures = (
    runtime: { linkFeatures?: string[] },
    client: InventoryClient,
  ): Promise<string[] | null> =>
    runtime.linkFeatures?.length ? Promise.resolve(runtime.linkFeatures) : client.hostCapabilities();

  /**
   * The organization's client, plus what its host advertises it can do.
   *
   * `hostCapabilities()` returns `null` when the host has no operator at all;
   * a missing capability is treated exactly like an absent host, because
   * a write one would attempt anyway would fail on the host after
   * having led the operator to believe it had been sent.
   */
  const requireWritableRuntime = async (
    organizationId: string,
    feature: string,
  ): Promise<InventoryClient> => (await requireWritableRuntimeWithId(organizationId, feature)).client;

  const requireWritableRuntimeWithId = async (
    organizationId: string,
    feature: string,
  ): Promise<{ client: InventoryClient; runtimeId: string; features: string[] }> => {
    const runtime = await readRuntime(db, config, organizationId);
    if (!runtime) {
      throw new HttpError(
        404,
        "RUNTIME_REQUIRED",
        "Aucun runtime Hermes actif : il n’y a rien à configurer.",
      );
    }
    const client = clientFactory(runtime.client);
    let features: string[] | null;
    try {
      features = await client.hostCapabilities();
    } catch (error) {
      throw publicWriteError(error);
    }
    if (!features?.includes(feature)) {
      throw new HttpError(
        409,
        "RUNTIME_ADMIN_UNAVAILABLE",
        "L’hôte de ce runtime n’expose pas cette écriture. "
        + "Mettez `edge-setup` à jour sur l’hôte pour que le lien annonce `"
        + feature + "`, ou faites le geste depuis sa console.",
      );
    }
    return { client, runtimeId: runtime.id, features };
  };

  return {
    db,
    config,
    readRuntime,
    clientFactory,
    timeoutMs,
    now,
    snapshots,
    invalidateIntegrationReads,
    announcedFeatures,
    requireWritableRuntime,
    requireWritableRuntimeWithId,
  };
}

export type IntegrationRouteContext = ReturnType<typeof integrationRouteContext>;
