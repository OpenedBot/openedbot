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

/** La part de `createGoogleAuth` dont la liaison a besoin : un double suffit aux tests. */
export type GoogleLinker = {
  enabled: boolean;
  start(returnTo: string | null, native: null, link: LinkOptions): Promise<AuthStartDto>;
  claimLink(attemptId: string, userId: string): Promise<LinkClaimResult>;
};

/**
 * Écran « Sécurité du compte » : ses propres sessions et sa méthode de
 * connexion. Voisin d'`account-deletion-routes.ts`, même gabarit ; la logique
 * et le SQL vivent dans `@openedbot/identity/application/account-security`.
 *
 * Lier Google part d'ici (tentative OAuth liée à `auth.userId`) et revient par
 * le callback Google commun d'`auth.ts`, qui pose le lien sans ouvrir de
 * session ; la page sonde `google/link/claim` jusqu'à l'issue.
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
