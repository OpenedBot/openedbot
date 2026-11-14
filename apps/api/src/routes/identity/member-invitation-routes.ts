import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import { previewMemberInvitation, respondToMemberInvitation } from "@openedbot/identity/application/member-invitation-consent";
import { attachSessionOrganization } from "@openedbot/identity/application/sessions";
import type { ApiConfig } from "../../infrastructure/config";
import { rateLimiter } from "../../interfaces/http/rate-limit";
import { authMiddleware, type AppVariables } from "./auth";
import { accountDeletionWriteGuard } from "./account-deletion-routes";

/**
 * `/api/invite/member/:token`, outside the session middleware: the preview is
 * anonymous (the token is the key), answering needs the invitee's session.
 * An invitee without an account signs up through the ordinary e-mail code
 * sign-in first; this route never creates an account nor a workspace.
 */
export function memberInvitationRoutes(
  db: Db,
  config: Pick<ApiConfig, "trustProxy">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", rateLimiter({
    "GET /api/invite/member/*": { max: 30, windowMs: 60_000 },
    "POST /api/invite/member/*": { max: 10, windowMs: 60_000 },
  }, { trustProxy: config.trustProxy }));
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });

  routes.get("/:token", async (context) => context.json(await previewMemberInvitation(db, context.req.param("token"))));

  // Mounted before the API's `/api/*` session and deletion guards, so both
  // run here, in the same order: an account whose closure is pending answers
  // 409 ACCOUNT_DELETION_PENDING like any other write, never the membership
  // trigger's 23514 as a 500.
  const deletionGuard = accountDeletionWriteGuard(db);
  for (const action of ["accept", "decline"] as const) {
    routes.post(`/:token/${action}`, authMiddleware(db), deletionGuard, async (context) => {
      const auth = context.get("auth");
      const response = await respondToMemberInvitation(db, {
        token: context.req.param("token"),
        userId: auth.userId,
        accept: action === "accept",
      });
      if (response.status === "accepted" && response.organizationId) {
        await attachSessionOrganization(db, auth.credentialHash, auth.sessionId, response.organizationId);
      }
      return context.json(response);
    });
  }

  return routes;
}
