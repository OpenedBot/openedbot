import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import { verifyEmailLoginCode } from "@openedbot/identity/application/email-login-code";
import { issueNativeAuthCode } from "@openedbot/identity/application/native-auth";
import type { ApiConfig } from "../../infrastructure/config";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { loginEmail, type AppVariables } from "./auth";

/**
 * Native sign-in by email code alone: the desktop's passwordless
 * door, mounted under `/api/auth/native/code` (therefore without a session).
 *
 * The code is requested via `POST /api/auth/login/code`, as on the web. Its
 * verification is that of `/login/code/verify` (same errors, same
 * open account creation), but the end differs: instead of a
 * cookie, an authorization code bound to the PKCE challenge, which the client exchanges
 * via `/native/token`, as after `/native/authorize`.
 *
 * No `recordUserLogin` here: `exchangeNativeAuthCode` dates the sign-in at
 * the exchange, and dating it also at issuance would count the same
 * sign-in twice. No `passwordOpen` guard either: no password is involved.
 *
 * Lives outside `auth.ts`, which is at its size ceiling (600-line ratchet).
 */
export function nativeCodeLoginRoutes(
  db: Db,
  config: Pick<ApiConfig, "nativeRedirectUris">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // Same guard as `authRoutes`: the response carries a one-shot code.
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Pragma", "no-cache");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });

  routes.post("/verify", async (context) => {
    const body = await jsonBody(context.req.raw);
    const email = loginEmail(body.email);
    const emailCode = assertString(body.code, "Le code", { max: 16 });
    const codeChallenge = assertString(body.codeChallenge, "Le challenge PKCE", { min: 43, max: 128 });
    const redirectUri = assertString(body.redirectUri, "L’URI de retour", { max: 1_024 });
    const clientId = assertString(body.clientId, "Le client", { max: 100 });
    // Refused before touching the code: a URI outside the list does not burn an attempt.
    if (!config.nativeRedirectUris.includes(redirectUri)) {
      throw new HttpError(400, "REDIRECT_URI_INVALID", "Cette URI de retour n’est pas autorisée.");
    }
    const member = await verifyEmailLoginCode(db, { email, code: emailCode });
    // An account without an organization (new, or whose workspace has disappeared) still
    // receives its code, like its web session: it sets its organization
    // in the console onboarding, inside the desktop window (0158).
    const code = await issueNativeAuthCode(db, {
      organizationId: member.organizationId,
      userId: member.userId,
      codeChallenge,
      redirectUri,
      clientId,
    });
    return context.json({ code, redirectUri });
  });

  return routes;
}
