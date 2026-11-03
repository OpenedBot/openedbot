import { HermesClient, type HermesClientConfig } from "@openedbot/hermes";
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
 * Ce que partagent les routes d’intégration du runtime : le runtime de
 * l’organisation, son client, les instantanés de lecture, et les portes
 * d’écriture (`requireWritableRuntime*`).
 */
export function integrationRouteContext(db: Db, config: ApiConfig, dependencies: IntegrationRouteDependencies) {
  const readRuntime = dependencies.readRuntime ?? readRuntimeSecret;
  const clientFactory = dependencies.clientFactory ?? ((clientConfig) => new HermesClient(clientConfig));
  const timeoutMs = safeTimeout(dependencies.timeoutMs);
  const now = dependencies.now ?? (() => new Date());
  const snapshots = dependencies.snapshotStore ?? postgresSnapshotStore(db);
  const invalidateIntegrationReads = (organizationId: string) => Promise.all([
    invalidateSnapshots(snapshots, organizationId, "mcp"),
    invalidateSnapshots(snapshots, organizationId, "integrations"),
    // Une connexion de bot s'inscrit dans la configuration de son profil.
    invalidateSnapshots(snapshots, organizationId, "profiles"),
  ]);

  /**
   * Ce que l'hôte annonce, pour une LECTURE : la liste que le lien a déjà
   * enregistrée (hello, trame capabilities, « Tester ») quand le runtime passe
   * par le connecteur, sinon un aller `hostCapabilities`. Chaque aller coûte
   * une sonde Python neuve sur l'hôte (environ 1,5 s, mesuré le 2026-10-21) ;
   * la Marketplace et les routes modèle lisent déjà la liste enregistrée. Une
   * écriture, elle, redemande toujours à l'hôte (`requireWritableRuntime`).
   */
  const announcedFeatures = (
    runtime: { linkFeatures?: string[] },
    client: InventoryClient,
  ): Promise<string[] | null> =>
    runtime.linkFeatures?.length ? Promise.resolve(runtime.linkFeatures) : client.hostCapabilities();

  /**
   * Le client de l'organisation, plus ce que son hôte annonce savoir faire.
   *
   * `hostCapabilities()` rend `null` quand l'hôte n'a pas d'opérateur du tout ;
   * une capacité absente est traitée exactement comme un hôte absent, parce
   * qu'une écriture qu'on tenterait quand même échouerait sur l'hôte après
   * avoir laissé croire à l'opérateur qu'elle était partie.
   */
  const requireWritableRuntime = async (
    organizationId: string,
    feature: string,
  ): Promise<InventoryClient> => (await requireWritableRuntimeWithId(organizationId, feature)).client;

  const requireWritableRuntimeWithId = async (
    organizationId: string,
    feature: string,
  ): Promise<{ client: InventoryClient; runtimeId: string }> => {
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
    return { client, runtimeId: runtime.id };
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
