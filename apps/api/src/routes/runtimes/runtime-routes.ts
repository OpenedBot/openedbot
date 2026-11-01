import { Hono } from "hono";
import { type HermesClientConfig } from "@openedbot/hermes";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { readModelSelectionProof } from "@openedbot/runtimes/sql/model-selection-proofs";
import { defaultPermissionMode, readPermissionPipeline } from "@openedbot/roster/sql/bots";
import { readOrganizationPermissionPolicy } from "@openedbot/identity/sql/permission-policy";
import { readReviewProven } from "@openedbot/runtimes/sql/review-profiles";
import type { TransactionDb } from "@openedbot/platform-db";
import { runtimeLinks, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import { runtimeLinkLocator, type RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import type { AppVariables } from "../identity/auth";
import type { PermissionContextDto } from "@openedbot/contracts-api";
import {
  effectiveAdminMode,
  readModelAssignmentModeIn,
  readOrganizationRuntimeModeIn,
} from "@openedbot/runtimes/application/runtime-mode";
import { requireOperator } from "../identity/auth";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { assertSubscriptionAllowsRuntime } from "./runtime-subscription";
import { assertNoPendingReplacement } from "./runtime-replacement";
import { runtimeInstanceRoutes } from "./runtime-instance-routes";
import { runtimeLinkTokenRoutes } from "./runtime-link-token-routes";
import {
  assertReachabilityMutable,
  defaultProbeClient,
  directProbeResult,
  insertRuntime,
  prepareDirectAccess,
  probeDirectCapacityWith,
  updateDirectAccess,
} from "./runtime-direct-access";
import {
  linkPublication,
  publicRuntime,
  publicRuntimeWithBots,
  readActiveProviderIncidents,
  readRosterBotCount,
  runtimeBotCount,
} from "./runtime-public";
import {
  runtimeHealthStatusForError,
  updateRuntimeHealth,
  updateRuntimeHealthForFailure,
} from "@openedbot/runtimes/application/runtime-health";
import { readExposureSummaries } from "@openedbot/runtimes/sql/runtime-exposures";
import {
  mapHermesError,
  probeRuntimeWith,
  type RuntimeProbeClient,
} from "@openedbot/runtimes/application/runtime-probe";
import { readAllRuntimeRows, readRuntimeRowById, readRuntimeRows } from "@openedbot/runtimes/sql/runtime-rows";
import {
  directConfig,
  optionalDirectToken,
  readEdgeAuthInput,
  readRuntimeSecret,
  runtimeClientConfig,
} from "@openedbot/runtimes/application/runtime-access";

// Le verdict de santé vit dans `application/runtime-health` ; ces symboles
// restent exportés d'ici pour les appelants historiques.
export { RUNTIME_LINK_STALE_MS, runtimeHealthStatusForError, shouldMarkLinkDisconnected } from "@openedbot/runtimes/application/runtime-health";
// La sonde et la lecture des lignes `runtimes` vivent dans `application/` : la
// passerelle du lien les appelle sans charger ce routeur.
export { probeRuntimeCapacityWith, type RuntimeProbeClient } from "@openedbot/runtimes/application/runtime-probe";
export { readAllRuntimeRows, readRuntimeRowById, readRuntimeRows, type RuntimeRow } from "@openedbot/runtimes/sql/runtime-rows";

export type RuntimeRouteDeps = {
  /** Construit le client d'une sonde ; un faux dans les tests, `HermesClient` sinon. */
  clientFactory?: (clientConfig: HermesClientConfig) => RuntimeProbeClient;
  /** Où vit le lien ; le défaut est le locator installé au démarrage. */
  locator?: RuntimeLinkLocator;
};

export {
  directProbeResult,
  draftRuntimeToken,
  insertRuntime,
  prepareDirectAccess,
  probeDirectCapacityWith,
  probeDirectRuntime,
  type DirectRuntimeProbe,
} from "./runtime-direct-access";
export {
  linkPublication,
  publicRuntime,
  publicRuntimeWithBots,
  readActiveProviderIncidents,
  readRosterBotCount,
  readRuntimeBotCount,
  runtimeBotCount,
  runtimeManagement,
  type LinkPublication,
  type RuntimeManagement,
} from "./runtime-public";
export { LINK_TOKEN_GRACE_MINUTES } from "./runtime-link-token-routes";

/** Ce que partagent les routes d’un runtime, construit une fois par `runtimeRoutes`. */
export type RuntimeRouteContext = {
  db: Db;
  config: ApiConfig;
  links: RuntimeLinks;
  createClient: (clientConfig: HermesClientConfig) => RuntimeProbeClient;
  locator: RuntimeLinkLocator;
  connectorOnlyEnrollment: boolean;
};

/**
 * A link replacement briefly leaves the active runtime without a socket:
 * `edge-setup link` has already stopped the old connector while the broker is
 * probing the new one. A manual test during that window must wait for the
 * enrollment to finish instead of turning a normal transition into a red
 * failure toast.
 */
const RUNTIME_REPLACEMENT_WAIT_MS = 45_000;
const RUNTIME_REPLACEMENT_POLL_MS = 500;

type RecentConnectorEnrollment = {
  runtimeId: string | null;
};

async function readRecentConnectorEnrollment(
  db: Db,
  organizationId: string,
): Promise<RecentConnectorEnrollment | null> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<RecentConnectorEnrollment[]>`
      select runtime_id as "runtimeId"
        from runtime_enrollments
       where organization_id = ${organizationId}
         and reachability = 'connector'
         and claimed_at > now() - interval '5 minutes'
         and expires_at > now()
       order by claimed_at desc
       limit 1
    `;
    return rows[0] ?? null;
  });
}

async function waitForRecentConnectorEnrollment(
  db: Db,
  organizationId: string,
): Promise<string | null> {
  const deadline = Date.now() + RUNTIME_REPLACEMENT_WAIT_MS;
  while (true) {
    const enrollment = await readRecentConnectorEnrollment(db, organizationId);
    if (!enrollment) return null;
    if (enrollment.runtimeId) return enrollment.runtimeId;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RUNTIME_REPLACEMENT_POLL_MS, remaining)));
  }
}

/** PERM2-3: the facts the console needs to show a bot's effective permission mode. */
async function readPermissionContext(tx: TransactionDb, organizationId: string): Promise<PermissionContextDto> {
  const pipeline = await readPermissionPipeline(tx, organizationId);
  const policy = await readOrganizationPermissionPolicy(tx, organizationId);
  return {
    pipeline,
    maxMode: policy?.maxMode ?? null,
    enforceReview: policy?.enforceReview ?? false,
    reviewProven: pipeline === "v2" ? await readReviewProven(tx, organizationId) : false,
  };
}

export function runtimeRoutes(
  db: Db,
  config: ApiConfig,
  links: RuntimeLinks = runtimeLinks(),
  deps: RuntimeRouteDeps = {},
  connectorOnlyEnrollment = false,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const createClient = deps.clientFactory ?? defaultProbeClient;
  const locator = deps.locator ?? runtimeLinkLocator();
  routes.get("/", async (context) => {
    const auth = context.get("auth");
    const { runtime, mode, assignment, incidents, exposures, modelSelection, permissionDefault, permissionContext, botCount } = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRows(tx, auth.organizationId);
      const runtime = rows[0] ?? null;
      return {
        runtime,
        mode: await readOrganizationRuntimeModeIn(tx, config, auth.organizationId),
        assignment: await readModelAssignmentModeIn(tx, auth.organizationId),
        incidents: runtime ? await readActiveProviderIncidents(tx, auth.organizationId, runtime.id) : [],
        exposures: runtime?.reachability === "direct" ? await readExposureSummaries(tx, auth.organizationId) : new Map(),
        modelSelection: runtime ? await readModelSelectionProof(tx, auth.organizationId, runtime.id) : null,
        permissionDefault: await defaultPermissionMode(tx, auth.organizationId),
        permissionContext: await readPermissionContext(tx, auth.organizationId),
        botCount: runtime ? await readRosterBotCount(tx, auth.organizationId) : 0,
      };
    });
    const adminMode = effectiveAdminMode(config, mode);
    return context.json({
      runtime: runtime ? {
        ...publicRuntime(runtime, adminMode, incidents, config.connectorVersions, exposures.get(runtime.id) ?? null, linkPublication(config)),
        botCount: runtimeBotCount(runtime, botCount),
        modelSelection: modelSelection ? {
          status: modelSelection.status, provider: modelSelection.provider, model: modelSelection.model,
          reasoningEffort: modelSelection.reasoning_effort, requestedAt: modelSelection.requested_at.toISOString(),
          attempts: modelSelection.attempts, nextAttemptAt: modelSelection.next_attempt_at?.toISOString() ?? null,
          error: modelSelection.error,
        } : null,
      } : null,
      runtimeMode: mode,
      modelAssignmentMode: assignment,
      defaultPermissionMode: permissionDefault,
      permissionContext,
      adminMode,
      devDefaults: null,
      managedTunnelAvailable: config.managedTunnel !== null,
      tailscaleFunnelAvailable: config.tailscaleFunnelEnabled,
    });
  });

  /** The old organization-level mode is retired, including for old clients. */
  routes.put("/mode", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    throw new HttpError(410, "RUNTIME_MODE_RETIRED", "Le mode intégré/externe est retiré. Ajoutez un runtime par lien openedbot ou accès direct.");
  });

  routes.put("/", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const name = assertString(body.name, "Le nom du runtime", { max: 100 });
    const existing = await withTenant(db, auth.organizationId, async (tx) => (await readRuntimeRows(tx, auth.organizationId))[0] ?? null);
    assertReachabilityMutable(existing);
    await assertSubscriptionAllowsRuntime(db, auth.organizationId, config.billingEnforced);
    const access = prepareDirectAccess(body, existing, config);
    const capacity = await probeDirectCapacityWith(createClient(access.client));
    const runtime = await withTenant(db, auth.organizationId, async (tx) => {
      if (existing) return updateDirectAccess(tx, auth.organizationId, existing.id, access, config, name);
      return (await insertRuntime(tx, { organizationId: auth.organizationId, name, endpoint: access.endpoint,
        encrypted: access.encrypted, edge: access.edge, keyId: config.tokenEncryption.current.id,
        capacity, hostFeatures: [], active: true }))[0]!;
    });
    return context.json({ runtime: await publicRuntimeWithBots(db, auth.organizationId, runtime, "disabled", [], config.connectorVersions, null, linkPublication(config)), runtimeMode: "external", adminMode: "disabled" });
  });

  /**
   * Vérifie un brouillon AVANT tout enregistrement.
   *
   * `POST /test` exige un runtime déjà en base : pendant l'accueil il n'en
   * existe aucun, donc la seule preuve de connexion possible était de créer
   * le runtime et le premier bot d'un coup : et de découvrir une URL ou un
   * token faux au moment le plus coûteux. Cette route sonde et ne persiste
   * rien : ni runtime, ni état de santé.
   */
  routes.post("/test-draft", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const url = assertString(body.url, "L’URL Hermes", { max: 2_048 });
    const token = optionalDirectToken(body.token);
    const edge = readEdgeAuthInput(body.edgeAuth);
    const result = await directProbeResult(() => createClient(directConfig(url, token, edge, config)), edge !== null);
    return context.json(result);
  });

  routes.on("POST", ["/test", "/:runtimeId/test"], async (context) => {
    const auth = context.get("auth");
    // Un runtime `connector` dont le lien est fermé sort d'ici en 503
    // `RUNTIME_LINK_UNAVAILABLE`, sauf pendant une relève d'enrôlement où la
    // sonde attend le nouveau runtime avant de conclure.
    const active = await withTenant(db, auth.organizationId, async (tx) => {
      const id = context.req.param("runtimeId");
      const rows = id ? await readRuntimeRowById(tx, auth.organizationId, id) : await readRuntimeRows(tx, auth.organizationId);
      return rows[0] ?? null;
    });
    if (!active) throw new HttpError(404, "RUNTIME_NOT_CONFIGURED", "Aucun runtime Hermes n’est configuré.");
    if (active.reachability === "direct") {
      const result = await directProbeResult(() => createClient(runtimeClientConfig(active, config, links)), !!active.edgeAuthCiphertext);
      await withTenant(db, auth.organizationId, (tx) => tx`
        update runtimes set last_health_status = ${result.ok ? "healthy" : "unreachable"},
          last_health_error = ${result.ok ? null : result.steps.find((step) => step.ok === false)?.code ?? "RUNTIME_PROBE_INDETERMINATE"},
          last_probed_at = now(), updated_at = now()
          where organization_id = ${auth.organizationId} and id = ${active.id} and revoked_at is null
            and endpoint = ${active.endpoint} and token_ciphertext = ${active.tokenCiphertext}
            and edge_auth_ciphertext is not distinct from ${active.edgeAuthCiphertext ?? null}
      `);
      return context.json(result);
    }
    let runtime: Awaited<ReturnType<typeof readRuntimeSecret>>;
    try {
      runtime = await readRuntimeSecret(db, config, auth.organizationId, links, locator, active.id);
    } catch (error) {
      // During `edge-setup link`, the old active runtime is stopped before
      // the new enrollment is consumed. Keep the test pending while that
      // deliberate hand-off completes, then probe the newly issued runtime.
      if (
        !context.req.param("runtimeId")
        && active.reachability === "connector"
        && error instanceof HttpError
        && error.code === "RUNTIME_LINK_UNAVAILABLE"
      ) {
        const replacementId = await waitForRecentConnectorEnrollment(db, auth.organizationId);
        if (replacementId) {
          runtime = await readRuntimeSecret(db, config, auth.organizationId, links, locator, replacementId);
          if (runtime) {
            // Continue with the normal probe below. The successful response
            // now reflects the runtime created by the link command.
          } else {
            await updateRuntimeHealthForFailure(db, auth.organizationId, active, error);
            throw error;
          }
        } else {
          await updateRuntimeHealthForFailure(db, auth.organizationId, active, error);
          throw error;
        }
      } else {
        if (error instanceof HttpError) {
          await updateRuntimeHealthForFailure(db, auth.organizationId, active, error);
        }
        throw error;
      }
    }
    if (!runtime) throw new HttpError(404, "RUNTIME_NOT_CONFIGURED", "Aucun runtime Hermes n’est configuré.");
    const client = createClient(runtime.client);
    let probe: { health: unknown; capabilities: unknown };
    try {
      probe = await probeRuntimeWith(client);
    } catch (error) {
      // Sonde en échec : la santé change, les capacités hôte restent ce
      // qu'elles étaient : on n'a rien relu.
      const mapped = mapHermesError(error);
      await updateRuntimeHealth(db, auth.organizationId, runtime.id, runtimeHealthStatusForError(mapped), mapped.message);
      throw mapped;
    }
    await updateRuntimeHealth(db, auth.organizationId, runtime.id, "healthy", null);
    return context.json({ ok: true, capabilities: probe.capabilities });
  });

  /**
   * Tous les runtimes déclarés par l'organisation.
   *
   * `GET /` reste l'alias du runtime actif : l'accueil, l'onboarding et les
   * clients antérieurs au multi-runtime continuent de l'interroger sans savoir
   * qu'il en existe d'autres.
   */
  routes.get("/list", async (context) => {
    const auth = context.get("auth");
    const { rows, mode, exposures, botCount } = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readAllRuntimeRows(tx, auth.organizationId);
      return {
        rows,
        mode: await readOrganizationRuntimeModeIn(tx, config, auth.organizationId),
        exposures: rows.some((row) => row.reachability === "direct") ? await readExposureSummaries(tx, auth.organizationId) : new Map(),
        botCount: rows.some((row) => row.isActive) ? await readRosterBotCount(tx, auth.organizationId) : 0,
      };
    });
    const adminMode = effectiveAdminMode(config, mode);
    return context.json({
      runtimes: rows.map((row) => ({
        ...publicRuntime(row, adminMode, [], config.connectorVersions, exposures.get(row.id) ?? null, linkPublication(config)),
        botCount: runtimeBotCount(row, botCount),
      })),
      runtimeMode: mode,
      adminMode,
    });
  });

  /**
   * Declares a direct runtime. With no runtime serving, it serves at once;
   * otherwise it is the pending replacement, swapped in by `POST /:id/replace`.
   */
  routes.post("/", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    if (connectorOnlyEnrollment) throw new HttpError(409, "CONNECTOR_REQUIRED", "Les nouveaux Edges utilisent le lien sortant.");
    const body = await jsonBody(context.req.raw);
    const name = assertString(body.name, "Le nom du runtime", { max: 100 });
    const access = prepareDirectAccess(body, null, config);
    const { endpoint, encrypted, edge } = access;
    await assertSubscriptionAllowsRuntime(db, auth.organizationId, config.billingEnforced);
    const capacity = await probeDirectCapacityWith(createClient(access.client));
    const hostFeatures: string[] = [];
    const { runtime } = await withTenant(db, auth.organizationId, async (tx) => {
      const existing = await readAllRuntimeRows(tx, auth.organizationId);
      if (existing.some((row) => row.endpoint === endpoint)) {
        throw new HttpError(409, "RUNTIME_ALREADY_DECLARED", "Ce runtime est déjà déclaré.");
      }
      await assertNoPendingReplacement(tx, auth.organizationId);
      const rows = await insertRuntime(tx, {
        organizationId: auth.organizationId,
        name,
        endpoint,
        encrypted,
        keyId: config.tokenEncryption.current.id,
        capacity,
        hostFeatures: hostFeatures ?? [],
        active: !existing.some((row) => row.isActive),
        edge,
      });
      return {
        runtime: rows[0]!,
        mode: await readOrganizationRuntimeModeIn(tx, config, auth.organizationId),
      };
    });
    return context.json(await publicRuntimeWithBots(db, auth.organizationId, runtime, "disabled", [], config.connectorVersions, null, linkPublication(config)), 201);
  });

  const ctx: RuntimeRouteContext = { db, config, links, createClient, locator, connectorOnlyEnrollment };
  routes.route("/", runtimeInstanceRoutes(ctx));
  routes.route("/", runtimeLinkTokenRoutes(ctx));

  return routes;
}
