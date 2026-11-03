import { Hono } from "hono";
import {
  type HermesCapabilityInventory,
  type HermesClientConfig,
  type HermesConnectorManagementProbe,
  type HermesHostToolsets,
  type HermesToolsetState,
} from "@openedbot/hermes";
import { FORBIDDEN_TOOLSETS } from "@openedbot/runtimes/domain/runtime-contract";
import type { RuntimeIntegrationInventoryDto, RuntimeIntegrationToolsetStateDto } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import {
  invalidateSnapshots,
  readThrough,
  wantsFreshRead,
  watchedReadPolicy,
} from "@openedbot/runtimes/application/runtime-read-snapshots";
import type { IntegrationRouteContext } from "./runtime-integration-context";
import {
  PublicInventoryError,
  publicWriteError,
  runtimeIntegrationInventory,
  withDeadline,
} from "./runtime-integration-public";
import { FEATURE_SKILLS_INVENTORY, FEATURE_TOOLSETS, TOOLSET_NAME_PATTERN } from "./runtime-integration-constants";

/** L’inventaire global du runtime et la bascule de ses toolsets. */
export function runtimeInventoryRoutes(ctx: IntegrationRouteContext): Hono<{ Variables: AppVariables }> {
  const {
    db,
    config,
    readRuntime,
    clientFactory,
    timeoutMs,
    now,
    snapshots,
    announcedFeatures,
    requireWritableRuntime,
  } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/integrations", async (context) => {
    const auth = context.get("auth");
    // Avant toute lecture DB ou réseau : un membre ne peut pas sonder la
    // topologie du runtime en provoquant des effets temporels observables.
    requireOperator(auth);

    const observedAt = now().toISOString();
    const runtime = await readRuntime(db, config, auth.organizationId);
    if (!runtime) {
      return context.json(runtimeIntegrationInventory({
        runtime: null,
        inventory: null,
        failure: new PublicInventoryError(
          "RUNTIME_REQUIRED",
          "Aucun runtime Hermes actif : l’inventaire ne peut pas être lu.",
        ),
        observedAt,
        canConfigure: true,
        managementProbe: null,
        hostFeatures: null,
        hostToolsets: null,
      }));
    }

    const dto = await readThrough(snapshots, {
      organizationId: auth.organizationId,
      runtimeId: runtime.id,
      kind: "integrations",
      fresh: wantsFreshRead(context.req.query("fresh")),
      keep: keepIntegrations,
      ...watchedReadPolicy(runtime.inventory),
      read: liveIntegrationsRead(ctx, runtime),
    });
    return context.json<RuntimeIntegrationInventoryDto>(dto);
  });

  routes.post("/integrations/toolsets/:name", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = context.req.param("name");
    if (!TOOLSET_NAME_PATTERN.test(name)) {
      throw new HttpError(400, "TOOLSET_INVALID", "Ce nom de toolset n’est pas valide.");
    }
    const body = await jsonBody(context.req.raw);
    if (typeof body.enabled !== "boolean") {
      throw new HttpError(400, "BODY_INVALID", "Le corps doit porter `enabled` (booléen).");
    }
    // Refusé ici ET sur l'hôte. Ce n'est pas une redondance : la règle
    // appartient au contrat openedbot, et l'opérateur la rejoue pour un hôte
    // administré autrement : mais elle doit se dire dans la langue de
    // l'utilisateur, avant l'aller réseau.
    if (body.enabled && FORBIDDEN_TOOLSETS.has(name)) {
      throw new HttpError(
        403,
        "TOOLSET_FORBIDDEN",
        "Ce toolset exécute du travail hors du run qu’openedbot pilote, budgète et journalise. "
        + "Il reste désactivé sur les runtimes openedbot.",
      );
    }
    const client = await requireWritableRuntime(auth.organizationId, FEATURE_TOOLSETS);
    let state: HermesToolsetState;
    try {
      state = await client.toolsetSet(name, body.enabled);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateSnapshots(snapshots, auth.organizationId, "integrations");
    }
    return context.json<RuntimeIntegrationToolsetStateDto>({
      name: state.name,
      enabled: state.enabled,
      requested: state.requested,
      applied: state.applied,
    });
  });

  return routes;
}

/** Ce que garde l'instantané : un inventaire que l'hôte a rendu sans erreur. */
export const keepIntegrations = (value: RuntimeIntegrationInventoryDto) => value.inventoryError === null;

/**
 * La lecture vivante de l'inventaire : les sondes de l'hôte, composées en DTO
 * public. La route la sert à travers l'instantané ; le réchauffage
 * (`runtime-inventory-warm.ts`) la rejoue quand l'hôte signale un changement.
 */
export function liveIntegrationsRead(
  ctx: IntegrationRouteContext,
  runtime: { id: string; name: string; client: HermesClientConfig; linkFeatures?: string[] },
): () => Promise<RuntimeIntegrationInventoryDto> {
  const { clientFactory, timeoutMs, now, announcedFeatures } = ctx;
  return async () => {
    const observedAt = now().toISOString();
    let inventory: HermesCapabilityInventory | null = null;
    let failure: unknown = null;
    let managementProbe: HermesConnectorManagementProbe | null = null;
    let hostFeatures: string[] | null = null;
    const client = clientFactory(runtime.client);
    const [inventoryResult, managementResult, featuresResult] = await Promise.allSettled([
      withDeadline(client.capabilityInventory(), timeoutMs),
      withDeadline(client.connectorManagementProbe(), timeoutMs),
      withDeadline(announcedFeatures(runtime, client), timeoutMs),
    ]);
    if (inventoryResult.status === "fulfilled") inventory = inventoryResult.value;
    else failure = inventoryResult.reason;
    if (managementResult.status === "fulfilled") managementProbe = managementResult.value;
    if (featuresResult.status === "fulfilled") hostFeatures = featuresResult.value;

    // `/v1/skills` répond 500 sur Hermes 0.21.3 à 0.22.6 (amont #142575) :
    // l'opérateur de l'hôte lit la même liste sans l'argument fautif. Son
    // échec laisse l'erreur d'origine affichée, jamais une liste vide.
    if (inventory?.skillsFailed && hostFeatures?.includes(FEATURE_SKILLS_INVENTORY)) {
      const [skillsResult] = await Promise.allSettled([withDeadline(client.hostSkills(), timeoutMs)]);
      if (skillsResult.status === "fulfilled" && skillsResult.value !== null) {
        inventory = { ...inventory, skills: skillsResult.value, skillsFailed: false };
      }
    }

    // La liste des toolsets réglables ne part QUE si l'hôte a annoncé la
    // capacité : un hôte sans opérateur répondrait `HERMES_OPERATOR_UNAVAILABLE`
    // à chaque ouverture de la page, ce qui coûte un aller pour rien et remplit
    // son journal d'un refus qui n'apprend rien. L'inventaire MCP, lui, n'est
    // pas ici du tout : il a sa route, lue quand son panneau s'ouvre.
    let hostToolsets: HermesHostToolsets | null = null;
    if (hostFeatures?.includes(FEATURE_TOOLSETS)) {
      const toolsetsResult = await Promise.allSettled([withDeadline(client.hostToolsets(), timeoutMs)]);
      if (toolsetsResult[0].status === "fulfilled") hostToolsets = toolsetsResult[0].value;
    }

    return runtimeIntegrationInventory({
      runtime: { id: runtime.id, name: runtime.name },
      inventory,
      failure,
      observedAt,
      canConfigure: true,
      managementProbe,
      hostFeatures,
      hostToolsets,
    });
  };
}
