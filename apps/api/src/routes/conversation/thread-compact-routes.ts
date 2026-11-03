import { Hono } from "hono";
import { HermesClient, type HermesClientConfig } from "@openedbot/hermes";
import type { ThreadCompactResult } from "@openedbot/contracts-api";
import { isUuid } from "@openedbot/contracts-primitives";
import { logger } from "@openedbot/platform-observability";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertEntitled } from "@openedbot/identity/domain/entitlement";
import { compactThreadNow, type CompactHermes } from "@openedbot/conversation/application/compact-thread";
import { readRoomCompactionTarget } from "@openedbot/conversation/application/compact-room-request";
import { applyRuntimeModelSelection } from "@openedbot/execution/application/runner/provider-recovery";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { runtimeLinks, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import { runtimeLinkLocator, type RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError } from "../../interfaces/http/http-error";
import { requireOperator, type AppVariables } from "../identity/auth";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";

/**
 * Jusqu'à quatre passes de résumé d'une minute chacune (`COMPACT_NOW_MAX_PASSES`
 * et `COMPACT_DEADLINE_MS` du module) : au-delà, la requête est abandonnée.
 */
const COMPACT_REQUEST_DEADLINE_MS = 250_000;

export type ThreadCompactRouteDeps = {
  clientFactory?: (config: HermesClientConfig) => CompactHermes;
  links?: RuntimeLinks;
  locator?: RuntimeLinkLocator;
  now?: () => Date;
};

/**
 * Compacte l'historique d'un salon à la demande (DEV-332).
 *
 * La route ne fait que garder (droits, abonnement, salon, runs, seuil), choisir
 * le client et le modèle, puis déléguer à `compactThreadNow` : le mécanisme est
 * celui de la compaction automatique (DEV-331), seul le déclencheur change.
 */
export function threadCompactRoutes(
  db: Db,
  config: ApiConfig,
  deps: ThreadCompactRouteDeps = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const createClient = deps.clientFactory ?? ((clientConfig: HermesClientConfig) => new HermesClient(clientConfig));
  const links = deps.links ?? runtimeLinks();
  const locator = deps.locator ?? runtimeLinkLocator();
  const now = deps.now ?? (() => new Date());
  // Un seul résumé à la fois par fil dans CE processus : deux clics (ou deux
  // onglets) ne doivent pas ouvrir deux sessions de résumé concurrentes.
  const inFlight = new Set<string>();

  routes.post("/:threadId/compact", async (context) => {
    const auth = context.get("auth");
    // Avant toute lecture en base : un membre simple n'apprend rien du salon.
    requireOperator(auth);
    const threadId = context.req.param("threadId");
    if (!isUuid(threadId)) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");

    // Un résumé coûte des jetons sur le runtime du client, comme un run.
    const subscription = await withTenant(db, auth.organizationId, async (tx) => {
      const plan = await subscriptionPort().read(tx, auth.organizationId);
      return plan ? { status: plan.status } : undefined;
    });
    assertEntitled(
      config.billingEnforced,
      subscription,
      "Le résumé est bloqué tant que l’abonnement n’est pas actif.",
    );

    const key = `${auth.organizationId}:${threadId}`;
    if (inFlight.has(key)) {
      throw new HttpError(409, "COMPACTION_IN_PROGRESS", "Un résumé de ce salon est déjà en cours.");
    }
    inFlight.add(key);
    try {
      const target = await readRoomCompactionTarget(db, auth.organizationId, threadId);
      if (target.kind === "not_found") throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
      if (target.kind === "not_room") {
        throw new HttpError(404, "THREAD_NOT_ROOM", "Seul l’historique d’un salon se résume à la demande.");
      }
      if (target.kind === "run_active") {
        throw new HttpError(409, "RUN_IN_PROGRESS", "Un membre répond encore : attendez la fin du tour pour résumer.");
      }
      if (target.kind === "below_threshold") {
        throw new HttpError(422, "COMPACTION_BELOW_THRESHOLD", "L’historique est encore trop court pour être résumé.");
      }

      const runtime = await readRuntimeSecret(db, config, auth.organizationId, links, locator);
      if (!runtime) {
        throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de résumer l’historique.");
      }
      // Un lien connecteur sert le profil du membre (`/p/<slug>`), comme son
      // run ; un runtime direct n'a pas de profil (même règle que le worker).
      const clientConfig: HermesClientConfig = "transport" in runtime.client
        ? { ...runtime.client, profile: target.speaker.profile }
        : runtime.client;
      const selection = applyRuntimeModelSelection(
        { model: target.speaker.model, reasoningEffort: target.speaker.reasoningEffort },
        { provider: runtime.selectedProvider, model: runtime.selectedModel, reasoningEffort: runtime.reasoningEffort },
        target.assignmentMode,
      );
      const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(COMPACT_REQUEST_DEADLINE_MS)]);
      const result = await compactThreadNow(
        db,
        createClient(clientConfig),
        {
          organizationId: auth.organizationId,
          threadId,
          model: selection.model,
          provider: selection.provider,
          reasoningEffort: selection.reasoningEffort,
          operatorName: target.operatorName,
        },
        signal,
      );
      if (!result.compacted || result.compactedThroughSequence === null) {
        logger.warn(
          { event: "api.thread_compact_failed", threadId, runtimeId: runtime.id },
          "on-demand room compaction produced no summary",
        );
        throw new HttpError(
          502,
          "COMPACTION_FAILED",
          "Le résumé n’a pas pu être produit par le runtime. Réessayez dans un instant.",
        );
      }
      const body: ThreadCompactResult = {
        compacted: true,
        summarizedCount: result.summarizedCount,
        compactedThroughSequence: result.compactedThroughSequence,
        compactedAt: now().toISOString(),
      };
      return context.json(body);
    } finally {
      inFlight.delete(key);
    }
  });

  return routes;
}
