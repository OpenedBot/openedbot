import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthContext } from "./auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import {
  cancelAccountClosure,
  readAccountClosureState,
  scheduleAccountClosure,
  pendingAccountClosure,
} from "@openedbot/identity/application/account-closure";
import { requestOrganizationCancellationTx } from "@openedbot/execution/application/run-cancellation";
import { hasPendingAccountDeletion } from "@openedbot/identity/application/deletions";

const DELETE_CONFIRMATION = "DELETE";

export function accountDeletionWriteGuard(db: Db): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method) ||
      (context.req.path === "/api/account/deletion/cancel" || context.req.path === "/api/account/deletion") || context.req.path === "/api/auth/logout" ||
      context.req.path.startsWith("/api/hooks/") ||
      // Revoking a session stays possible during a pending
      // deletion: closing a security hole must not be blocked by a
      // deletion request. The password change, for its part, stays
      // covered by the guard.
      context.req.path.startsWith("/api/account/security/sessions")) {
      return next();
    }
    // A request without a user session (a plug-in's own authentication on a
    // public mount) has no account whose deletion could be pending.
    const auth = context.get("auth") as AuthContext | undefined;
    if (!auth) return next();
    if (await pendingAccountClosure(db, auth.userId) || await hasPendingAccountDeletion(db, auth.organizationId)) {
      throw new HttpError(409, "ACCOUNT_DELETION_PENDING", "Le compte est en attente de suppression. Annulez la demande avant toute modification.");
    }
    await next();
  };
}

/**
 * Self-serve identity closure: the rules and SQL live in
 * `@openedbot/identity/application/account-closure`; this file keeps the HTTP.
 */
export function accountDeletionRoutes(
  db: Db,
  config: Pick<ApiConfig, "billingGraceDays">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    return context.json({ ...await readAccountClosureState(db, scope(auth)), graceDays: config.billingGraceDays });
  });

  routes.post("/", async (context) => {
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    if (body.confirmation !== DELETE_CONFIRMATION && body.confirm !== DELETE_CONFIRMATION) {
      throw new HttpError(400, "DELETE_CONFIRMATION_REQUIRED", "Saisissez DELETE pour confirmer la suppression du compte.");
    }
    const expectedGraceDays = body.expectedGraceDays;
    if (expectedGraceDays !== undefined) {
      if (typeof expectedGraceDays !== "number" || !Number.isInteger(expectedGraceDays) || expectedGraceDays < 0) {
        throw new HttpError(400, "ACCOUNT_DELETION_PREVIEW_INVALID", "Le délai de suppression est invalide.");
      }
      if (expectedGraceDays !== config.billingGraceDays) {
        throw new HttpError(409, "ACCOUNT_DELETION_CHANGED", "Le délai de suppression a changé. Actualisez et vérifiez la demande avant de confirmer.");
      }
    }
    const organizationIds = body.organizationIds;
    if (organizationIds !== undefined && (!Array.isArray(organizationIds) || organizationIds.some((id) => typeof id !== "string"))) {
      throw new HttpError(400, "ACCOUNT_DELETION_PREVIEW_INVALID", "La liste des espaces est invalide.");
    }
    const deletion = await scheduleAccountClosure(db, scope(auth), config.billingGraceDays, requestOrganizationCancellationTx, organizationIds as string[] | undefined);
    return context.json({ deletion, scheduled: true }, 202);
  });

  routes.post("/cancel", async (context) => {
    const auth = context.get("auth");
    return context.json(await cancelAccountClosure(db, scope(auth)));
  });

  return routes;
}

function scope(auth: AuthContext): { organizationId: string; userId: string } {
  return { organizationId: auth.organizationId, userId: auth.userId };
}
