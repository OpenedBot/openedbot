import { Hono } from "hono";
import { isUuid } from "@openedbot/contracts-primitives";
import type { Db } from "@openedbot/platform-db";
import type { YoloLeaseSigningConfig } from "@openedbot/platform-config/yolo-lease-signing";
import { readOrganizationPermissionPolicy } from "@openedbot/identity/sql/permission-policy";
import {
  createYoloLeaseSigner,
  grantYoloLease,
  killYoloLeases,
  listYoloLeases,
  NO_YOLO_PUBLISHER,
  readYoloAudit,
  readYoloConsent,
  readYoloGrantInput,
  revokeYoloLease,
  saveYoloConsent,
  yoloLeaseKeys,
  type YoloLeaseDeps,
  type YoloLeasePublisher,
} from "@openedbot/execution/application/yolo-leases";
import type { AppVariables } from "./auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";

export type YoloRouteDeps = {
  signing: YoloLeaseSigningConfig;
  /** La poussée vers l'hôte ; branchée sur le lien en PR 4, sans effet d'ici là. */
  publisher?: YoloLeasePublisher;
  now?: () => number;
};

function optionalQueryUuid(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isUuid(value)) throw new HttpError(400, "YOLO_LEASE_INVALID", "Identifiant invalide.", {}, { field });
  return value;
}

/**
 * Mode YOLO : `/api/organization/yolo`. Tout membre lit les baux vivants (les
 * badges et les comptes à rebours) et les clés publiques ; owner et admin
 * octroient, révoquent, coupent tout et lisent l'audit ; l'octroi exige en
 * plus une session humaine (403 `YOLO_HUMAN_REQUIRED`). Une agence n'atteint
 * jamais ces routes (`agencyRequestAllowed` refuse `/api/organization*`, D-5).
 */
export function yoloRoutes(db: Db, routeDeps: YoloRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const deps: YoloLeaseDeps = {
    signer: createYoloLeaseSigner(routeDeps.signing),
    publisher: routeDeps.publisher ?? NO_YOLO_PUBLISHER,
    readPolicy: (tx, organizationId) => readOrganizationPermissionPolicy(tx, organizationId),
    now: routeDeps.now,
  };

  routes.get("/keys", (context) => context.json(yoloLeaseKeys(deps.signer)));

  routes.get("/leases", async (context) => {
    const filters = {
      runtimeId: optionalQueryUuid(context.req.query("runtimeId"), "runtimeId"),
      botId: optionalQueryUuid(context.req.query("botId"), "botId"),
      threadId: optionalQueryUuid(context.req.query("threadId"), "threadId"),
    };
    return context.json(await listYoloLeases(db, context.get("auth"), filters));
  });

  routes.post("/leases", async (context) => {
    const input = readYoloGrantInput(await jsonBody(context.req.raw));
    return context.json({ lease: await grantYoloLease(db, deps, context.get("auth"), input) }, 201);
  });

  routes.delete("/leases/:leaseId", async (context) => {
    const leaseId = context.req.param("leaseId");
    if (!isUuid(leaseId)) throw new HttpError(404, "YOLO_LEASE_NOT_FOUND", "Bail introuvable.");
    return context.json({ lease: await revokeYoloLease(db, deps, context.get("auth"), leaseId) });
  });

  routes.post("/kill", async (context) => context.json(await killYoloLeases(db, deps, context.get("auth"))));

  routes.get("/audit", async (context) => context.json(await readYoloAudit(db, context.get("auth"), {
    leaseId: context.req.query("leaseId") || null,
    cursor: context.req.query("cursor") || null,
  })));

  routes.get("/consent", async (context) => context.json(await readYoloConsent(db, context.get("auth"))));

  routes.put("/consent", async (context) => {
    const body = await jsonBody(context.req.raw);
    return context.json(await saveYoloConsent(db, context.get("auth"), body));
  });

  return routes;
}
