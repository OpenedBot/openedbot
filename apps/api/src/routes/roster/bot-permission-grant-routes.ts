import { isUuid, isoInstant } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import type { BotPermissionGrantDto } from "@openedbot/contracts-api";
import { listActiveBotPermissionGrants, revokeBotPermissionGrantTx } from "@openedbot/roster/application/permission-grants";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";

/**
 * PERM2-4: the "Always for this tool on this bot" grants, listed and revoked
 * in the bot's settings. A revocation raises the bot's permission revision
 * (0140): it counts from the next forwarding claim on.
 */
export function botPermissionGrantRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:botId/permission-grants", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const botId = readUuid(context.req.param("botId"));
    const grants = await withTenant(db, auth.organizationId, async (tx) => {
      await requireBot(tx, auth.organizationId, botId);
      return listActiveBotPermissionGrants(tx, auth.organizationId, botId);
    });
    return context.json(grants.map((grant): BotPermissionGrantDto => ({ ...grant, createdAt: isoInstant(grant.createdAt) })));
  });

  routes.post("/:botId/permission-grants/:grantId/revoke", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const botId = readUuid(context.req.param("botId"));
    const grantId = readUuid(context.req.param("grantId"));
    const body = await jsonBody(context.req.raw);
    const reason = body.reason === undefined || body.reason === null ? null : body.reason;
    if (reason !== null && (typeof reason !== "string" || !reason.trim() || reason.trim().length > 200)) {
      throw new HttpError(400, "PERMISSION_GRANT_REASON_INVALID", "Le motif doit faire entre 1 et 200 caractères.");
    }
    const revoked = await withTenant(db, auth.organizationId, async (tx) => {
      await requireBot(tx, auth.organizationId, botId);
      return revokeBotPermissionGrantTx(tx, {
        organizationId: auth.organizationId, botId, grantId, actor: { userId: auth.userId }, reason: reason?.trim() ?? null,
      });
    });
    if (!revoked) throw new HttpError(404, "PERMISSION_GRANT_NOT_FOUND", "Cette autorisation permanente n’existe plus ou a déjà été retirée.");
    return context.body(null, 204);
  });

  return routes;
}

async function requireBot(tx: TransactionDb, organizationId: string, botId: string): Promise<void> {
  const rows = await tx<Array<{ id: string }>>`select id from bots where organization_id = ${organizationId} and id = ${botId}`;
  if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
}

function readUuid(value: string | undefined): string {
  if (!value || !isUuid(value)) throw new HttpError(400, "ID_INVALID", "Identifiant invalide.");
  return value.toLowerCase();
}
