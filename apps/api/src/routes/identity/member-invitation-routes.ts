import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import {
  previewMemberInvitation,
  registerMemberInvitee,
  respondToMemberInvitation,
} from "@openedbot/identity/application/member-invitation-consent";
import { attachSessionOrganization, createWebSession } from "@openedbot/identity/application/sessions";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { rateLimiter } from "../../interfaces/http/rate-limit";
import { authMiddleware, type AppVariables, readOptionalSessionIdentity, sessionDevice, writeWebSessionCookies } from "./auth";

export function memberInvitationRoutes(
  db: Db,
  config: Pick<ApiConfig, "environment" | "trustProxy">,
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

  routes.post("/:token/register", async (context) => {
    if (await readOptionalSessionIdentity(db, context)) {
      throw new HttpError(409, "AUTH_ALREADY_SIGNED_IN", "Déconnectez-vous avant de créer un autre compte.");
    }
    const body = await jsonBody(context.req.raw);
    const user = await registerMemberInvitee(db, context.req.param("token"), body.password);
    const session = await createWebSession(db, null, user.userId, sessionDevice(context, config));
    writeWebSessionCookies(context, config, session);
    return context.json({ user: { id: user.userId, email: user.email }, organizationId: null, csrfToken: session.csrf }, 201);
  });

  for (const action of ["accept", "decline"] as const) {
    routes.post(`/:token/${action}`, authMiddleware(db), async (context) => {
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
