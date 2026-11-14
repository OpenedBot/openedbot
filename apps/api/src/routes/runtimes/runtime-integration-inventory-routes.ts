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
import { TOOLSET_NAME_PATTERN } from "./runtime-integration-constants";
import { RELAY_FEATURE_SKILLS_INVENTORY, RELAY_FEATURE_TOOLSET_MANAGEMENT } from "@openedbot/contracts-connector/features";

/** The runtime's global inventory and the toggle of its toolsets. */
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
    // Before any DB or network read: a member cannot probe the
    // runtime's topology by causing observable timing effects.
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
    // Refused here AND on the host. This is not redundancy: the rule
    // belongs to the openedbot contract, and the operator replays it for a host
    // administered otherwise: but it must be said in the user's
    // language, before the network round trip.
    if (body.enabled && FORBIDDEN_TOOLSETS.has(name)) {
      throw new HttpError(
        403,
        "TOOLSET_FORBIDDEN",
        "Ce toolset exécute du travail hors du run qu’openedbot pilote, budgète et journalise. "
        + "Il reste désactivé sur les runtimes openedbot.",
      );
    }
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_TOOLSET_MANAGEMENT);
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

/** What the snapshot keeps: an inventory the host returned without error. */
export const keepIntegrations = (value: RuntimeIntegrationInventoryDto) => value.inventoryError === null;

/**
 * The live read of the inventory: the host's probes, composed into a public
 * DTO. The route serves it through the snapshot; the warm-up
 * (`runtime-inventory-warm.ts`) replays it when the host signals a change.
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

    // `/v1/skills` answers 500 on Hermes 0.21.3 through 0.23.0 at least (upstream #142575):
    // the host's operator reads the same list without the faulty argument. Its
    // failure leaves the original error displayed, never an empty list.
    if (inventory?.skillsFailed && hostFeatures?.includes(RELAY_FEATURE_SKILLS_INVENTORY)) {
      const [skillsResult] = await Promise.allSettled([withDeadline(client.hostSkills(), timeoutMs)]);
      if (skillsResult.status === "fulfilled" && skillsResult.value !== null) {
        inventory = { ...inventory, skills: skillsResult.value, skillsFailed: false };
      }
    }

    // The list of configurable toolsets leaves ONLY if the host has advertised the
    // capability: a host without an operator would answer `HERMES_OPERATOR_UNAVAILABLE`
    // on every page open, which costs a round trip for nothing and fills
    // its log with a refusal that teaches nothing. The MCP inventory, for its part, is
    // not here at all: it has its own route, read when its panel opens.
    let hostToolsets: HermesHostToolsets | null = null;
    if (hostFeatures?.includes(RELAY_FEATURE_TOOLSET_MANAGEMENT)) {
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
