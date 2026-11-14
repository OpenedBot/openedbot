import { Hono } from "hono";
import { RELAY_CLOSE_UNAUTHORIZED } from "@openedbot/contracts-connector";
import { withTenant } from "@openedbot/platform-db";
import { invalidateProvenRuntimeModels } from "@openedbot/runtimes/application/model-selection-proof";
import { hashCredential, randomCredential } from "../../infrastructure/crypto";
import { insertRuntimeLinkEvent, type LinkEventKind } from "@openedbot/runtime-link/application/broker";
import type { AppVariables } from "../identity/auth";
import type { RuntimeLinkRotationMode, RuntimeLinkVerifyDto } from "@openedbot/contracts-api";
import { requireOperator } from "../identity/auth";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { logger } from "@openedbot/platform-observability";
import { recordRuntimeHealthObservation } from "@openedbot/runtimes/application/runtime-health";
import { mapHermesError, probeRuntimeWith } from "@openedbot/runtimes/application/runtime-probe";
import { readRuntimeRowById } from "@openedbot/runtimes/application/runtime-rows";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import type { RuntimeRouteContext } from "./runtime-routes";
import { toIso } from "./runtime-public";

/** A runtime's link token: rotation, verification and the event log. */
export function runtimeLinkTokenRoutes(ctx: RuntimeRouteContext): Hono<{ Variables: AppVariables }> {
  const { db, config, links, createClient, locator } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Rotation of a `connector` runtime's link token (0027, modeled on
   * hermes-agent's `gateway/relay/auth.py`: several secrets, a grace
   * window). Two modes, body `{ "mode": "maintenance" | "emergency" }`:
   *
   * - `maintenance` (default): the current hash slides into
   *   `link_token_previous_hash`, valid for ten minutes, and the new token is
   *   pushed as `link.rotate` on the link if it is open on this instance.
   * - `emergency` (link suspected hijacked): NO grace, NO push: the
   *   connection to the registry may be the hijacker's: and the current link
   *   is closed 4401 `LINK_ROTATED`. The user sets the token by hand.
   *
   * The token is returned ONCE here; never logged, never cached.
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
                   link_token_rotation_unconfirmed_at = null,
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
                   link_token_rotation_unconfirmed_at = null,
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
      // An uncertain delivery stays "not pushed" here: the token is returned to the operator.
      if (!pushed) pushed = (await locator.forwardRotate(runtimeId, { t: "link.rotate", runtimeId, linkToken })) === true;
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
   * « Vérifier le lien »: native WebSocket ping on the instance that holds the
   * socket, then, if the link answers, a gateway probe through it. A ping
   * with neither pong nor frame hangs up the probed connection (4005) and the host redials;
   * the screen then waits for a new generation and checks again.
   *
   * The generation read here bounds everything: the probe does not close a more
   * recent connection, and the gateway's health is written only on the observed lease.
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

  /** A runtime's link log, from newest to oldest. */
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

/** Grace window of the previous token after rotation (`link_token_previous_expires_at`). */
export const LINK_TOKEN_GRACE_MINUTES = 10;

/** `{ "mode": "maintenance" | "emergency" }`, `maintenance` with no body; any other value is a 400. */
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
