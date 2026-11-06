import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthContext } from "./auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import {
  cancelAccountDeletion,
  readAccountDeletionState,
  scheduleAccountDeletion,
} from "@openedbot/identity/application/account-deletion";
import { requestOrganizationCancellationTx } from "@openedbot/execution/application/run-cancellation";
import { hasPendingAccountDeletion } from "@openedbot/identity/application/deletions";

const DELETE_CONFIRMATION = "DELETE";

export function accountDeletionWriteGuard(db: Db): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method) ||
      context.req.path === "/api/account/deletion/cancel" || context.req.path === "/api/auth/logout" ||
      context.req.path === "/api/pro/staff" || context.req.path.startsWith("/api/pro/staff/") ||
      context.req.path.startsWith("/api/hooks/") ||
      // Révoquer une session reste possible pendant une suppression en
      // attente : une passoire de sécurité ne doit pas être bloquée par une
      // demande de suppression. Le changement de mot de passe, lui, reste
      // couvert par le garde.
      context.req.path.startsWith("/api/account/security/sessions")) {
      return next();
    }
    const auth = context.get("auth") as AuthContext;
    if (await hasPendingAccountDeletion(db, auth.organizationId)) {
      throw new HttpError(409, "ACCOUNT_DELETION_PENDING", "Le compte est en attente de suppression. Annulez la demande avant toute modification.");
    }
    await next();
  };
}

/**
 * Self-serve account deletion, tenant-scoped: the rules and SQL live in
 * `@openedbot/identity/application/account-deletion`; this file keeps the HTTP.
 */
export function accountDeletionRoutes(
  db: Db,
  config: Pick<ApiConfig, "billingGraceDays">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    return context.json(await readAccountDeletionState(db, scope(auth)));
  });

  routes.post("/", async (context) => {
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    if (body.confirmation !== DELETE_CONFIRMATION && body.confirm !== DELETE_CONFIRMATION) {
      throw new HttpError(400, "DELETE_CONFIRMATION_REQUIRED", "Saisissez DELETE pour confirmer la suppression du compte.");
    }
    const deletion = await scheduleAccountDeletion(db, scope(auth), config.billingGraceDays, requestOrganizationCancellationTx);
    return context.json({ deletion, scheduled: true }, 202);
  });

  routes.post("/cancel", async (context) => {
    const auth = context.get("auth");
    return context.json(await cancelAccountDeletion(db, scope(auth)));
  });

  return routes;
}

function scope(auth: AuthContext): { organizationId: string; userId: string } {
  return { organizationId: auth.organizationId, userId: auth.userId };
}
