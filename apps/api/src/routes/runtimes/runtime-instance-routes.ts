import { Hono } from "hono";
import { RELAY_CLOSE_REVOKED } from "@openedbot/contracts-connector";
import { withTenant } from "@openedbot/platform-db";
import { insertRuntimeLinkEvent } from "@openedbot/runtime-link/application/broker";
import type { AppVariables } from "../identity/auth";
import { effectiveAdminMode, readOrganizationRuntimeModeIn } from "@openedbot/runtimes/application/runtime-mode";
import { requireOperator } from "../identity/auth";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { updateRuntimeHealthForFailure } from "@openedbot/runtimes/application/runtime-health";
import { cleanupRevokedExposuresAfterCommit, revokeExposureForRuntime } from "@openedbot/runtimes/application/direct-exposure-lifecycle";
import type { RuntimeExposureRow } from "@openedbot/runtimes/application/runtime-exposures";
import { mapHermesError, probeRuntimeCapacityWith } from "@openedbot/runtimes/application/runtime-probe";
import { readAllRuntimeRows, readRuntimeRowById, type RuntimeRow } from "@openedbot/runtimes/application/runtime-rows";
import { assertLinkReachable, runtimeClientConfig } from "@openedbot/runtimes/application/runtime-access";
import type { RuntimeRouteContext } from "./runtime-routes";
import {
  assertReachabilityMutable,
  prepareDirectAccess,
  probeDirectCapacityWith,
  updateDirectAccess,
} from "./runtime-direct-access";
import { hostFeatureLiteral, linkPublication, publicRuntimeWithBots } from "./runtime-public";

/** Un runtime nommé : diagnostic, accès direct, activation, remplacement et suppression. */
export function runtimeInstanceRoutes(ctx: RuntimeRouteContext): Hono<{ Variables: AppVariables }> {
  const { db, config, links, createClient, locator } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:runtimeId/diagnostics", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const limit = Number(context.req.query("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, "VALIDATION_ERROR", "La limite doit être comprise entre 1 et 100.");
    }
    const diagnostics = await withTenant(db, auth.organizationId, async (tx) => {
      const runtimes = await tx<Array<{ id: string }>>`
        select id from runtimes where id = ${runtimeId} and organization_id = ${auth.organizationId} and revoked_at is null
      `;
      if (!runtimes.length) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      return tx`
        select event_id as "eventId", component, state, code, message, stack,
               occurred_at as "occurredAt", received_at as "receivedAt",
               receiver_instance_id as "receiverInstanceId", receiver_generation::text as "receiverGeneration"
          from runtime_link_diagnostics
         where organization_id = ${auth.organizationId} and runtime_id = ${runtimeId}
         order by received_at desc, id desc limit ${limit}
      `;
    });
    return context.json({ diagnostics });
  });

  routes.put("/:runtimeId/access", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const id = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const body = await jsonBody(context.req.raw);
    const runtime = await withTenant(db, auth.organizationId, async (tx) => {
      await tx`select id from runtimes where organization_id = ${auth.organizationId} and id = ${id} for update`;
      const target = (await readRuntimeRowById(tx, auth.organizationId, id))[0];
      if (!target) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      assertReachabilityMutable(target);
      return updateDirectAccess(tx, auth.organizationId, id, prepareDirectAccess(body, target, config), config);
    });
    return context.json(await publicRuntimeWithBots(db, auth.organizationId, runtime, "disabled", [], config.connectorVersions, null, linkPublication(config)));
  });

  /**
   * La bascule libre entre runtimes est retirée : un bot n'est rattaché à
   * aucun runtime, et son profil Hermes n'existe que sur l'hôte où il a été
   * créé. Activer un autre runtime faisait tourner tous les bots sur un hôte
   * où leurs profils n'existaient pas. Le seul geste restant est le
   * remplacement, qui révoque l'ancien (`POST /:runtimeId/replace`).
   */
  routes.post("/:runtimeId/activate", async (context) => {
    requireOperator(context.get("auth"));
    throw new HttpError(410, "RUNTIME_ACTIVATE_RETIRED", "La bascule entre runtimes est retirée : remplacez le runtime.");
  });

  /**
   * Remplace le runtime qui sert les runs par un runtime déjà déclaré et
   * encore inactif : une organisation n'a qu'UN runtime.
   *
   * La sonde passe AVANT la bascule : basculer vers un runtime injoignable
   * arrêterait les runs de l'organisation sans qu'aucun écran ne l'annonce.
   * La révocation de l'ancien et l'activation du nouveau partagent une
   * transaction : il n'existe jamais d'instant à deux actifs ni à zéro actif.
   * L'ancien est révoqué comme par `DELETE` (lien fermé, publication retirée) :
   * désactivé seulement, il restait un second runtime vivant, rattrapable par
   * une bascule qui n'existe plus.
   */
  routes.post("/:runtimeId/replace", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const target = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRowById(tx, auth.organizationId, runtimeId);
      return rows[0] ?? null;
    });
    if (!target) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");

    // Même sonde par le tuyau qu'à l'enrôlement : un lien fermé (503) ou un
    // hôte qui ne répond plus n'est pas activé, et le badge le dit.
    let hostFeatures: string[] | null = null;
    try {
      if (target.reachability === "connector") await assertLinkReachable(target.id, links, locator);
      const client = createClient(runtimeClientConfig(target, config, links));
      if (target.reachability === "direct") await probeDirectCapacityWith(client);
      else await probeRuntimeCapacityWith(client);
    } catch (error) {
      const mapped = mapHermesError(error);
      await updateRuntimeHealthForFailure(db, auth.organizationId, target, mapped);
      throw mapped;
    }

    // Les tunnels gérés des runtimes remplacés partent APRÈS le commit.
    const exposureCleanups: RuntimeExposureRow[] = [];
    const { runtime, retired, mode } = await withTenant(db, auth.organizationId, async (tx) => {
      if (target.reachability === "direct") {
        await tx`select id from runtimes where organization_id = ${auth.organizationId} and id = ${runtimeId} for update`;
        const current = (await readRuntimeRowById(tx, auth.organizationId, runtimeId))[0];
        if (!current || current.endpoint !== target.endpoint || current.tokenCiphertext !== target.tokenCiphertext
          || current.edgeAuthCiphertext !== target.edgeAuthCiphertext) {
          throw new HttpError(409, "RUNTIME_ACCESS_CHANGED", "Les accès ont changé pendant la sonde. Retestez avant d’activer.");
        }
      }
      const previous = await tx<Array<{ id: string; reachability: string }>>`
        select id, reachability from runtimes
         where organization_id = ${auth.organizationId} and is_active and id <> ${runtimeId}
         for update
      `;
      // `is_active = false` dans le MÊME update que `revoked_at` :
      // `runtimes_active_not_revoked` (0013) interdit une ligne à la fois
      // active et révoquée.
      await tx`
        update runtimes set revoked_at = now(), is_active = false, updated_at = now()
         where organization_id = ${auth.organizationId} and is_active and id <> ${runtimeId}
      `;
      for (const row of previous) {
        if (row.reachability === "connector") await insertRuntimeLinkEvent(tx, auth.organizationId, row.id, "revoked");
        if (row.reachability === "direct") {
          const pending = await revokeExposureForRuntime(tx, config, auth.organizationId, row.id);
          if (pending) exposureCleanups.push(pending);
        }
      }
      const rows = await tx<RuntimeRow[]>`
        update runtimes
           set is_active = true, last_health_status = 'healthy', last_health_error = null,
               last_probed_at = now(), updated_at = now(),
               link_features = coalesce(${hostFeatureLiteral(hostFeatures)}::text[], link_features)
         where organization_id = ${auth.organizationId} and id = ${runtimeId} and revoked_at is null
        returning id, name, endpoint, token_ciphertext as "tokenCiphertext", token_nonce as "tokenNonce",
                  token_tag as "tokenTag", token_key_id as "tokenKeyId",
           edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId", capacity, last_health_status as "lastHealthStatus",
                  last_health_error as "lastHealthError", last_probed_at as "lastProbedAt",
                  selected_provider as "selectedProvider", selected_model as "selectedModel",
                  reasoning_effort as "reasoningEffort", is_active as "isActive",
                  created_at as "createdAt", updated_at as "updatedAt",
                  reachability, link_connected_at as "linkConnectedAt", link_last_seen_at as "linkLastSeenAt",
           link_generation::text as "linkGeneration",
           link_features as "linkFeatures",
           link_agent as "linkAgent", link_agent_seen_at as "linkAgentSeenAt", link_hermes_version as "linkHermesVersion",
           link_origin as "linkOrigin",
           link_token_rotated_at as "linkRotatedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'replaced') as "linkLastReplacedAt",
           (select max(e.occurred_at) from runtime_link_events e
             where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'hijack_suspected') as "linkHijackSuspectedAt"
      `;
      // Le remplaçant a pu être retiré pendant la sonde : rien n'est révoqué
      // sans lui, sinon l'organisation resterait sans runtime.
      if (!rows[0]) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      return {
        runtime: rows[0],
        retired: previous,
        mode: await readOrganizationRuntimeModeIn(tx, config, auth.organizationId),
      };
    });
    await cleanupRevokedExposuresAfterCommit(db, config, exposureCleanups);
    // Comme pour `DELETE` : le lien de l'ancien se ferme sur-le-champ (4004),
    // relayé à l'instance propriétaire s'il ne vit pas dans ce processus.
    for (const row of retired) {
      if (row.reachability === "connector" && !links.revoke(row.id)) {
        await locator.forwardClose(row.id, RELAY_CLOSE_REVOKED, "LINK_REVOKED");
      }
    }
    return context.json({ runtime: await publicRuntimeWithBots(db, auth.organizationId, runtime, effectiveAdminMode(config, mode), [], config.connectorVersions, null, linkPublication(config)) });
  });

  /**
   * Retire un runtime déclaré. Révocation logique : les runs passés gardent la
   * ligne qu'ils référencent.
   *
   * Le runtime actif se retire aussi, mais jamais par accident : il faut le
   * corps `{ "confirm": true }`. Sans lui, un simple clic sur « supprimer »
   * laisserait l'organisation sans runtime servant. Avec lui, c'est un choix
   * assumé : jeton de lien compromis, machine perdue : et l'organisation
   * repart sans runtime tant qu'elle n'en appaire pas un nouveau. Changer de
   * machine passe par le remplacement, qui ne laisse jamais ce trou.
   */
  routes.delete("/:runtimeId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const confirmed = await readDeleteConfirmation(context.req.raw);
    const exposureCleanups: RuntimeExposureRow[] = [];
    const removed = await withTenant(db, auth.organizationId, async (tx) => {
      const declared = await readAllRuntimeRows(tx, auth.organizationId);
      const target = declared.find((row) => row.id === runtimeId) ?? null;
      if (!target) return null;
      if (target.isActive && !confirmed) {
        throw new HttpError(
          409,
          "RUNTIME_ACTIVE",
          "Confirmez le retrait du runtime qui sert les runs : l’organisation n’en aura plus aucun tant qu’un nouveau n’est pas appairé.",
        );
      }
      // `is_active = false` dans le MÊME update : `runtimes_active_not_revoked`
      // (0013) interdit une ligne à la fois active et révoquée, et le worker
      // joint `runtimes` sans ORDER BY en se fiant à cet invariant. Poser
      // `revoked_at` seul faisait échouer la contrainte, donc toute la
      // transaction.
      await tx`
        update runtimes set revoked_at = now(), is_active = false, updated_at = now()
         where organization_id = ${auth.organizationId} and id = ${runtimeId}
      `;
      if (target.reachability === "connector") {
        await insertRuntimeLinkEvent(tx, auth.organizationId, target.id, "revoked");
      }
      // Un tunnel géré part avec son runtime ; une publication sur
      // le compte du client est révoquée ici et nettoyée par lui.
      if (target.reachability === "direct") {
        const pending = await revokeExposureForRuntime(tx, config, auth.organizationId, target.id);
        if (pending) exposureCleanups.push(pending);
      }
      return target;
    });
    await cleanupRevokedExposuresAfterCommit(db, config, exposureCleanups);
    if (!removed) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
    // Un runtime `connector` révoqué perd son lien sur-le-champ (4004) : le
    // jeton n'ouvre plus rien, et l'hôte l'apprend sans attendre un timeout.
    // `links.revoke` ne ferme que la socket de CE processus : si le lien vit
    // sur la passerelle (`separate`) ou sur un autre réplica, la fermeture est
    // relayée à l'instance propriétaire, comme pour la rotation d'urgence. Un
    // relais perdu n'annule rien (`revoked_at` est écrit, le jeton est refusé
    // à la montée suivante) : seul le 4004 qui arrête l'hôte manque.
    if (removed.reachability === "connector" && !links.revoke(removed.id)) {
      await locator.forwardClose(removed.id, RELAY_CLOSE_REVOKED, "LINK_REVOKED");
    }
    return context.json({ ok: true });
  });

  return routes;
}

/**
 * `DELETE` n'a pas toujours de corps : sans JSON, pas de confirmation. Un
 * corps présent doit être du JSON valide, et seule la valeur `true` compte.
 */
async function readDeleteConfirmation(request: Request): Promise<boolean> {
  const declaredLength = request.headers.get("content-length");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json") || declaredLength === "0") return false;
  const body = await jsonBody(request);
  return body.confirm === true;
}
