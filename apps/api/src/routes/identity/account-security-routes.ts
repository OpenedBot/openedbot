import { Hono } from "hono";
import type { AuthStartDto, ChangePasswordDto, GoogleLinkClaimDto, GoogleUnlinkDto, RevokeSessionsDto } from "@openedbot/contracts-api";
import {
  changeOwnPassword,
  readAccountSecurityView,
  revokeOtherOwnSessions,
  revokeOwnSession,
} from "@openedbot/identity/application/account-security";
import { unlinkGoogle } from "@openedbot/identity/application/google-link";
import type { LinkClaimResult, LinkOptions } from "@openedbot/identity/application/oauth-attempt-store";
import type { AppVariables } from "./auth";
import type { Db } from "@openedbot/platform-db";
import { assertPassword, assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";

/** The part of `createGoogleAuth` the link needs: a double is enough for the tests. */
export type GoogleLinker = {
  enabled: boolean;
  start(returnTo: string | null, native: null, link: LinkOptions): Promise<AuthStartDto>;
  claimLink(attemptId: string, userId: string): Promise<LinkClaimResult>;
};

/**
 * « Sécurité du compte » screen: its own sessions and its sign-in
 * method. Neighbor of `account-deletion-routes.ts`, same shape; the logic
 * and the SQL live in `@openedbot/identity/application/account-security`.
 *
 * Linking Google starts here (an OAuth attempt bound to `auth.userId`) and comes back through
 * the shared Google callback of `auth.ts`, which sets the link without opening a
 * session; the page polls `google/link/claim` until the outcome.
 */
export function accountSecurityRoutes(
  db: Db,
  options: { google?: GoogleLinker } = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const google = options.google ?? null;

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    return context.json(await readAccountSecurityView(db, { userId: auth.userId, currentSessionId: auth.sessionId }));
  });

  routes.delete("/sessions/:sessionId", async (context) => {
    const auth = context.get("auth");
    const sessionId = assertString(context.req.param("sessionId"), "L’identifiant de session", { max: 64 });
    await revokeOwnSession(db, { userId: auth.userId, currentSessionId: auth.sessionId, sessionId });
    return context.body(null, 204);
  });

  routes.post("/sessions/revoke-others", async (context) => {
    const auth = context.get("auth");
    const dto: RevokeSessionsDto = {
      revoked: await revokeOtherOwnSessions(db, { userId: auth.userId, currentSessionId: auth.sessionId }),
    };
    return context.json(dto);
  });

  routes.post("/password", async (context) => {
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    const currentPassword = assertPassword(body.currentPassword, "Le mot de passe actuel");
    const newPassword = assertPassword(body.newPassword, "Le nouveau mot de passe");
    const dto: ChangePasswordDto = {
      revokedOtherSessions: await changeOwnPassword(db, {
        userId: auth.userId,
        currentSessionId: auth.sessionId,
        currentPassword,
        newPassword,
      }),
    };
    return context.json(dto);
  });

  routes.post("/google/link/start", async (context) => {
    const auth = context.get("auth");
    if (!google?.enabled) throw new HttpError(409, "AUTH_PROVIDER_DISABLED", "Google OAuth n’est pas configuré.");
    const dto: AuthStartDto = await google.start(null, null, { userId: auth.userId });
    return context.json(dto);
  });

  routes.post("/google/link/claim", async (context) => {
    const auth = context.get("auth");
    if (!google) throw new HttpError(409, "AUTH_PROVIDER_DISABLED", "Google OAuth n’est pas configuré.");
    const body = await jsonBody(context.req.raw);
    const attemptId = assertString(body.attemptId, "La tentative", { max: 200 });
    const dto: GoogleLinkClaimDto = await google.claimLink(attemptId, auth.userId);
    return context.json(dto);
  });

  routes.post("/google/unlink", async (context) => {
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    const currentPassword = assertPassword(body.currentPassword, "Le mot de passe actuel");
    const dto: GoogleUnlinkDto = {
      revokedOtherSessions: await unlinkGoogle(db, {
        userId: auth.userId,
        currentSessionId: auth.sessionId,
        currentPassword,
      }),
    };
    return context.json(dto);
  });

  return routes;
}
