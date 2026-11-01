import { Hono } from "hono";
import { RELAY_CLOSE_UNAUTHORIZED } from "@openedbot/contracts-connector";
import { withTenant } from "@openedbot/platform-db";
import { invalidateProvenRuntimeModels } from "@openedbot/runtimes/sql/model-selection-proofs";
import { hashCredential, randomCredential } from "../../infrastructure/crypto";
import { insertRuntimeLinkEvent, type LinkEventKind } from "@openedbot/runtime-link/application/broker";
import type { AppVariables } from "../identity/auth";
import type { RuntimeLinkRotationMode, RuntimeLinkVerifyDto } from "@openedbot/contracts-api";
import { requireOperator } from "../identity/auth";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { logger } from "@openedbot/platform-observability";
import { recordRuntimeHealthObservation } from "@openedbot/runtimes/application/runtime-health";
import { mapHermesError, probeRuntimeWith } from "@openedbot/runtimes/application/runtime-probe";
import { readRuntimeRowById } from "@openedbot/runtimes/sql/runtime-rows";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import type { RuntimeRouteContext } from "./runtime-routes";
import { toIso } from "./runtime-public";

/** Le jeton du lien d’un runtime : rotation, vérification et journal des événements. */
export function runtimeLinkTokenRoutes(ctx: RuntimeRouteContext): Hono<{ Variables: AppVariables }> {
  const { db, config, links, createClient, locator } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Rotation du jeton de lien d'un runtime `connector` (0027, calqué sur
   * `gateway/relay/auth.py` de hermes-agent : plusieurs secrets, fenêtre de
   * grâce). Deux modes, corps `{ "mode": "maintenance" | "emergency" }` :
   *
   * - `maintenance` (défaut) : le hash courant glisse en
   *   `link_token_previous_hash`, valable dix minutes, et le nouveau jeton est
   *   poussé `link.rotate` sur le lien s'il est ouvert sur cette instance.
   * - `emergency` (lien soupçonné détourné) : AUCUNE grâce, AUCUN push : la
   *   connexion au registre peut être celle du détourneur : et le lien courant
   *   est fermé 4401 `LINK_ROTATED`. L'utilisateur pose le jeton à la main.
   *
   * Le jeton est rendu UNE fois ici ; jamais journalisé, jamais mis en cache.
   */
  routes.post("/:runtimeId/link/rotate", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const mode = await readRotationMode(context.req.raw);
    const linkToken = randomCredential(32);
    const tokenHash = hashCredential(linkToken);
    const rotated = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRowById(tx, auth.organizationId, runtimeId);
      const target = rows[0] ?? null;
      if (!target) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      if (target.reachability !== "connector") {
        throw new HttpError(409, "RUNTIME_NOT_CONNECTOR", "Seul un runtime joint par le connecteur a un jeton de lien.");
      }
      const updated = mode === "emergency"
        ? await tx<Array<{ id: string; expiresPreviousAt: Date | string | null }>>`
            update runtimes
               set link_token_previous_hash = null,
                   link_token_previous_expires_at = null,
                   link_token_rotated_at = now(),
                   link_token_hash = ${tokenHash},
                   updated_at = now()
             where organization_id = ${auth.organizationId} and id = ${runtimeId}
               and reachability = 'connector' and revoked_at is null
            returning id, link_token_previous_expires_at as "expiresPreviousAt"
          `
        : await tx<Array<{ id: string; expiresPreviousAt: Date | string | null }>>`
            update runtimes
               set link_token_previous_hash = link_token_hash,
                   link_token_previous_expires_at = now() + (${LINK_TOKEN_GRACE_MINUTES} * interval '1 minute'),
                   link_token_rotated_at = now(),
                   link_token_hash = ${tokenHash},
                   updated_at = now()
             where organization_id = ${auth.organizationId} and id = ${runtimeId}
               and reachability = 'connector' and revoked_at is null
            returning id, link_token_previous_expires_at as "expiresPreviousAt"
          `;
      const row = updated[0];
      if (!row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      await insertRuntimeLinkEvent(tx, auth.organizationId, runtimeId, "rotated");
      await invalidateProvenRuntimeModels(tx, auth.organizationId, runtimeId);
      return row;
    });
    let pushed = false;
    if (mode === "emergency") {
      if (!links.close(runtimeId, RELAY_CLOSE_UNAUTHORIZED, "LINK_ROTATED")) {
        await locator.forwardClose(runtimeId, RELAY_CLOSE_UNAUTHORIZED, "LINK_ROTATED");
      }
    } else {
      pushed = links.notifyRotation(runtimeId, { t: "link.rotate", runtimeId, linkToken });
      if (!pushed) pushed = await locator.forwardRotate(runtimeId, { t: "link.rotate", runtimeId, linkToken });
    }
    logger.info({ event: "api.runtime_link_rotated", runtimeId, mode, pushed }, "runtime link rotated");
    context.header("Cache-Control", "no-store");
    return context.json({
      linkToken,
      runtimeId,
      mode,
      pushed,
      expiresPreviousAt: toIso(rotated.expiresPreviousAt),
    });
  });

  /**
   * « Vérifier le lien » : ping WebSocket natif sur l'instance qui tient la
   * socket, puis, si le lien répond, sonde du gateway à travers lui. Un ping
   * sans pong ni trame raccroche la connexion sondée (4005) et l'hôte redial ;
   * l'écran attend alors une nouvelle génération et revérifie.
   *
   * La génération lue ici borne tout : la sonde ne ferme pas une connexion plus
   * récente, et la santé du gateway ne s'écrit que sur le bail observé.
   */
  routes.post("/:runtimeId/link/verify", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const target = await withTenant(db, auth.organizationId, async (tx) => (await readRuntimeRowById(tx, auth.organizationId, runtimeId))[0] ?? null);
    if (!target) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
    if (target.reachability !== "connector") {
      throw new HttpError(409, "RUNTIME_NOT_CONNECTOR", "Seul un runtime joint par le connecteur a un lien à vérifier.");
    }
    const expectedGeneration = target.linkConnectedAt !== null ? target.linkGeneration ?? null : null;
    const probe = await (links.probe?.(runtimeId, expectedGeneration) ?? locator.forwardProbe(runtimeId, expectedGeneration));
    let gateway: RuntimeLinkVerifyDto["gateway"] = null;
    if (probe.outcome === "alive") {
      const observed = { id: runtimeId, linkLastSeenAt: target.linkLastSeenAt, linkGeneration: probe.generation ?? expectedGeneration };
      try {
        const runtime = await readRuntimeSecret(db, config, auth.organizationId, links, locator, runtimeId);
        if (!runtime) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
        await probeRuntimeWith(createClient(runtime.client));
        await recordRuntimeHealthObservation(db, auth.organizationId, observed, null);
        gateway = { ok: true };
      } catch (error) {
        const mapped = error instanceof HttpError ? error : mapHermesError(error);
        await recordRuntimeHealthObservation(db, auth.organizationId, observed, mapped);
        gateway = { ok: false, code: mapped.code, message: mapped.message };
      }
    }
    logger.info({ event: "api.runtime_link_verified", runtimeId, outcome: probe.outcome }, "runtime link verified");
    context.header("Cache-Control", "no-store");
    const body: RuntimeLinkVerifyDto = {
      runtimeId,
      outcome: probe.outcome,
      generation: "generation" in probe ? probe.generation : null,
      rttMs: probe.outcome === "alive" ? probe.rttMs : null,
      gateway,
      lastSeenAt: toIso(target.linkLastSeenAt),
      lastHealthError: target.lastHealthError,
    };
    return context.json(body);
  });

  /** Le journal du lien d'un runtime, du plus récent au plus ancien. */
  routes.get("/:runtimeId/link/events", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const requested = Number(context.req.query("limit") ?? "50");
    const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(200, requested)) : 50;
    const events = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRowById(tx, auth.organizationId, runtimeId);
      if (!rows[0]) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      return tx<Array<{ id: string; kind: LinkEventKind; ip: string | null; agent: string | null; previousIp: string | null; occurredAt: Date | string; meta: Record<string, unknown> }>>`
        select id, kind, ip, agent, previous_ip as "previousIp", occurred_at as "occurredAt", meta
          from runtime_link_events
         where organization_id = ${auth.organizationId} and runtime_id = ${runtimeId}
         order by occurred_at desc
         limit ${limit}
      `;
    });
    return context.json({
      events: events.map((event) => ({ ...event, occurredAt: toIso(event.occurredAt) })),
    });
  });

  return routes;
}

/** Fenêtre de grâce de l'ancien jeton après rotation (`link_token_previous_expires_at`). */
export const LINK_TOKEN_GRACE_MINUTES = 10;

/** `{ "mode": "maintenance" | "emergency" }`, `maintenance` sans corps ; toute autre valeur est un 400. */
async function readRotationMode(request: Request): Promise<RuntimeLinkRotationMode> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json") || request.headers.get("content-length") === "0") {
    return "maintenance";
  }
  const body = await jsonBody(request);
  if (body.mode === undefined || body.mode === null) return "maintenance";
  if (body.mode !== "maintenance" && body.mode !== "emergency") {
    throw new HttpError(400, "VALIDATION_ERROR", "Le mode de rotation doit être maintenance ou emergency.");
  }
  return body.mode;
}
