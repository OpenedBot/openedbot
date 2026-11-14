import { consumeEmailLoginCode, requestEmailLoginCode, verifyEmailLoginCode } from "@openedbot/identity/application/email-login-code";
import { isEmailSyntaxValid, normalizeEmail } from "@openedbot/identity/domain/email-address";
import { isUuid } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { canOperateWorkspace, type AuthFailureCode, type AuthProvidersDto, type WorkspaceRole } from "@openedbot/contracts-api";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withCredential } from "@openedbot/platform-db";
import { hashCredential } from "../../infrastructure/crypto";
import { assertPassword, assertString, boundedTextBody, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { sessionDevice } from "./session-device";
export { sessionDevice } from "./session-device";
import { authFailureCode } from "@openedbot/identity/domain/signup";
import { createGoogleAuth } from "@openedbot/identity/application/google-auth";
import { createPostgresOAuthAttemptStore, OAuthAttemptTransitionError } from "@openedbot/identity/application/oauth-attempt-store";
import { firstLivingOrganization, recordUserLogin, verifyCredentials } from "@openedbot/identity/application/accounts";
import { resolveGoogleIdentity } from "@openedbot/identity/application/google-identity";
import { linkGoogleIdentity } from "@openedbot/identity/application/google-link";
import { readWorkspaceAccess } from "@openedbot/identity/application/workspace-access";
import {
  createWebSession,
  findLiveSession,
  revokeSessionOnLogout,
  touchSession,
  WEB_SESSION_TTL_MS,
} from "@openedbot/identity/application/sessions";
import { exchangeNativeAuthCode, issueNativeAuthCode, refreshNativeSession } from "@openedbot/identity/application/native-auth";
import { readAccountIdentityView, resolveSessionIdentity } from "@openedbot/identity/application/session-identity";
import { logger } from "@openedbot/platform-observability";
import { removeApnsDevice } from "@openedbot/notifications/application/apns-devices";
import { readApnsInstallationId } from "@openedbot/notifications/domain/apns";
import { readResolvedProductFeatures, sessionEntitlements } from "../../application/product-features";
import { SOLO_ENTITLEMENTS, type EntitlementSource } from "@openedbot/identity/application/entitlements";

import { assertWorkspaceId, EMPTY_WORKSPACE_ID, isAccountIdentityPath } from "@openedbot/identity/domain/workspace-access";

const SESSION_COOKIE = "openedbot_session";
const CSRF_COOKIE = "openedbot_csrf";

export type AuthContext = {
  sessionId: string;
  organizationId: string;
  userId: string;
  role: WorkspaceRole;
  kind: "web" | "native";
  credentialHash: string;
  /**
   * Who assists this session: a read-only session opened on the user's behalf
   * (column `sessions.impersonated_by_staff_user_id`), `null` otherwise. The
   * core opens none; it keeps one read-only and pinned to its workspace.
   * Absent only in legacy in-process callers.
   */
  assistedBy?: string | null;
};

export type AppVariables = { auth: AuthContext };

export const ORGANIZATION_HEADER = "X-OpenedBot-Organization";

export function authMiddleware(db: Db): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const authorization = context.req.header("Authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
    const cookie = getCookie(context, SESSION_COOKIE) ?? null;
    const credential = bearer || cookie;
    if (!credential) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
    const credentialHash = hashCredential(credential);
    const headerOrganization = context.req.header(ORGANIZATION_HEADER);
    const downloadOrganization = context.req.method === "GET" ? context.req.query("organizationId") : undefined;
    if (headerOrganization && downloadOrganization && headerOrganization !== downloadOrganization) {
      throw new HttpError(403, "TENANT_MISMATCH", "Les contextes d’espace ne correspondent pas.");
    }
    const requestedOrganization = headerOrganization || downloadOrganization;
    if (requestedOrganization) assertWorkspaceId(requestedOrganization);
    const accountPath = isAccountIdentityPath(context.req.path, context.req.method);

    const session = await withCredential(db, credentialHash, async (tx) => {
      const found = await findLiveSession(tx, credentialHash);
      if (!found) return null;
      const pinned = found.kind !== "web" || Boolean(found.assistedBy);
      // Native with no organization (0158): account routes like the web, in order to
      // define it; it stays pinned, no header opens another workspace.
      const ownClosure = ((context.req.method === "GET" || context.req.method === "POST") && context.req.path === "/api/account/deletion")
        || (context.req.method === "POST" && context.req.path === "/api/account/deletion/cancel");
      const accountReachable = !pinned || (found.kind === "native" && (!found.organizationId || ownClosure));
      if (requestedOrganization && requestedOrganization !== found.organizationId && (pinned || !isUuid(requestedOrganization))) {
        throw new HttpError(403, "TENANT_MISMATCH", "Cette session n’appartient pas à cette organisation.");
      }
      if (found.assistedBy && accountPath
        && context.req.path !== "/api/auth/me" && context.req.path !== "/api/auth/logout") {
        throw new HttpError(403, "IMPERSONATION_READ_ONLY", "L’assistance ne peut pas accéder aux autres espaces.");
      }
      const organizationId = requestedOrganization || found.organizationId || EMPTY_WORKSPACE_ID;
      await tx`select set_config('app.organization_id', ${organizationId}, true)`;
      await touchSession(tx, found.id);
      // Closing an identity runs outside any workspace: the account UI
      // deliberately sends no organization header.
      if (ownClosure && !requestedOrganization && !found.assistedBy) {
        return { ...found, organizationId: EMPTY_WORKSPACE_ID, role: "member" as const };
      }
      // A live direct membership: `workspace_access` is the only definition,
      // reread on every request.
      const role = (await readWorkspaceAccess(tx, found.userId, organizationId))?.role ?? null;
      if (!role) {
        if (accountPath && accountReachable && (context.req.path !== "/api/auth/me" || !requestedOrganization)) {
          return { ...found, organizationId: EMPTY_WORKSPACE_ID, role: "member" as const };
        }
        throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Vous n’avez plus accès à cet espace.");
      }
      return { ...found, organizationId, role };
    });
    if (!session) throw new HttpError(401, "SESSION_EXPIRED", "La session a expiré.");

    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
    if (!bearer && unsafe) {
      const csrf = context.req.header("X-CSRF-Token");
      if (!csrf || !session.csrfHash || hashCredential(csrf) !== session.csrfHash) {
        throw new HttpError(403, "CSRF_INVALID", "Le jeton CSRF est absent ou invalide.");
      }
    }

    // An assistance session serves to reproduce and inspect the state seen by the
    // member. It must never become a write shortcut in the name of the
    // person, even if their tenant role is owner/admin.
    if (unsafe && session.assistedBy && context.req.path !== "/api/auth/logout") {
      throw new HttpError(
        403,
        "IMPERSONATION_READ_ONLY",
        "Le mode assistance est en lecture seule.",
      );
    }

    const { id: sessionId, ...sessionContext } = session;
    context.set("auth", { ...sessionContext, sessionId, credentialHash });
    await next();
  };
}

export function authRoutes(db: Db, config: ApiConfig): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const google = createGoogleAuth(config, createPostgresOAuthAttemptStore(db, config.tokenEncryption));
  // Prod opens only Google. The password stays the door of dev and of
  // preprod (`OPENEDBOT_ENV=preprod`). A direct call is refused, not merely hidden.
  const passwordOpen = config.deployEnvironment !== "prod";

  // Auth responses contain attempt identifiers, one-shot
  // codes, or a session. No cache and no outgoing Referer must keep them.
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Pragma", "no-cache");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });

  routes.get("/providers", async (context) => {
    const configured = Boolean(config.google.clientId && config.google.clientSecret);
    const origin = requestOrigin(context);
    const google = !configured
      ? { enabled: false as const, reason: "not_configured" as const }
      : googleOriginSupported(config, origin)
        ? { enabled: true as const }
        : { enabled: false as const, reason: "origin_unsupported" as const };
    const providers: AuthProvidersDto = {
      emailCode: { enabled: true },
      google,
      password: passwordOpen ? { enabled: true } : { enabled: false },
    };
    // Seeded accounts leave the API only in development, and only
    // toward the door: elsewhere these fields do not even exist.
    if (config.devSignIn) providers.devSignIn = config.devSignIn;
    return context.json(providers);
  });

  routes.post("/google/start", async (context) => {
    if (!google.enabled) throw new HttpError(409, "AUTH_PROVIDER_DISABLED", "Google OAuth n’est pas configuré.");
    // An origin that cannot receive the callback's session must not
    // leave for Google only to come back without a cookie: the refusal is named here.
    if (!googleOriginSupported(config, requestOrigin(context))) {
      throw new HttpError(
        409,
        "AUTH_GOOGLE_ORIGIN_UNSUPPORTED",
        "Le SSO Google n’aboutit pas depuis cette origine : le callback OAuth est lié à API_PUBLIC_URL.",
      );
    }
    const body = await jsonBody(context.req.raw);
    const returnTo = typeof body.returnTo === "string" ? body.returnTo : null;
    // A `returnTo` from an origin outside WEB_APP_URL / CORS_ALLOWED_ORIGINS (e.g. LAN access by IP) must
    // not let the Google flow start only to fail later, out of
    // the operator's view: the refusal is immediate, here, on the click.
    if (returnTo) assertTrustedReturnOrigin(returnTo, config.webOrigins);
    return context.json(await google.start(returnTo));
  });

  routes.get("/google/callback", async (context) => {
    const result = await google.callback(new URL(context.req.url).searchParams);
    if (!result.ok) return refuseGoogleCallback(context, result.returnTo, result.code);
    try {
      if (result.link) {
        // Link from « Mon compte »: the user already has their session.
        // Nothing is opened here; the page that probes `link/claim` sees the outcome.
        await linkGoogleIdentity(db, result.link.userId, result.identity);
        await google.completeLink(result.attemptId);
        return context.html(callbackPage(true));
      }
      if (result.native) {
        // With no organization, the desktop opens it in onboarding (0158).
        const member = await resolveGoogleIdentity(db, result.identity);
        await google.completeNative(result.attemptId, member);
      } else {
        const member = await resolveGoogleIdentity(db, result.identity);
        await google.completeWeb(result.attemptId, member.user);
        const session = await createWebSession(db, member.organizationId, member.userId, sessionDevice(context, config));
        await recordUserLogin(db, member.userId);
        const issued = { ...session, user: member.user };
        writeWebSessionCookies(context, config, issued);
      }
    } catch (error) {
      // Without this net, the failure climbed to the global handler: raw JSON
      // at the API's origin, an attempt left `pending`, and a client that
      // probes into the void. The refusal is named, recorded, then returned to the app.
      const code = error instanceof OAuthAttemptTransitionError ? "AUTH_STATE_INVALID" : authFailureCode(error);
      await google.failAttempt(result.attemptId, code);
      logger.warn({ event: "auth.google.refused", code, error: String(error) }, "google sign-in refused");
      return refuseGoogleCallback(context, result.returnTo, code);
    }
    if (result.returnTo) return redirectGoogleCallback(context, result.returnTo);
    return context.html(callbackPage(true));
  });

  routes.post("/attempts/claim", async (context) => {
    const body = await jsonBody(context.req.raw);
    const attemptId = assertString(body.attemptId, "La tentative", { max: 200 });
    return context.json(await google.claim(attemptId));
  });

  routes.post("/native/google/start", async (context) => {
    const body = await jsonBody(context.req.raw);
    const codeChallenge = assertString(body.codeChallenge, "Le challenge PKCE", { min: 43, max: 128 });
    const redirectUri = assertString(body.redirectUri, "L’URI de retour", { max: 1_024 });
    const clientId = assertString(body.clientId, "Le client", { max: 100 });
    if (!config.nativeRedirectUris.includes(redirectUri)) {
      throw new HttpError(400, "REDIRECT_URI_INVALID", "Cette URI de retour n’est pas autorisée.");
    }
    if (!google.enabled) throw new HttpError(409, "AUTH_PROVIDER_DISABLED", "Google OAuth n’est pas configuré.");
    return context.json(await google.start(null, { codeChallenge, redirectUri, clientId }));
  });

  routes.post("/native/google/claim", async (context) => {
    const body = await jsonBody(context.req.raw);
    const attemptId = assertString(body.attemptId, "La tentative", { max: 200 });
    const codeVerifier = assertString(body.codeVerifier, "Le vérificateur PKCE", { min: 43, max: 128 });
    const redirectUri = assertString(body.redirectUri, "L’URI de retour", { max: 1_024 });
    const result = await google.claimNative(attemptId, codeVerifier, redirectUri);
    if (result.status !== "done") return context.json(result);

    const code = await issueNativeAuthCode(db, {
      organizationId: result.completion.organizationId,
      userId: result.completion.userId,
      codeChallenge: result.native.codeChallenge,
      redirectUri: result.native.redirectUri,
      clientId: result.native.clientId,
    });
    return context.json({ status: "done", code, user: result.completion.user });
  });

  routes.post("/login/code", async (context) => {
    const body = await jsonBody(context.req.raw);
    const email = loginEmail(body.email);
    await requestEmailLoginCode(db, { email, locale: body.locale === "en" || (!body.locale && context.req.header("accept-language")?.startsWith("en")) ? "en" : "fr" });
    return context.json({ sent: true });
  });

  routes.post("/login/code/verify", async (context) => {
    const body = await jsonBody(context.req.raw);
    const email = loginEmail(body.email);
    const code = assertString(body.code, "Le code", { max: 16 });
    const member = await verifyEmailLoginCode(db, { email, code });
    const session = await createWebSession(db, member.organizationId, member.userId, sessionDevice(context, config));
    await recordUserLogin(db, member.userId);
    writeWebSessionCookies(context, config, session);
    return context.json({ csrfToken: session.csrf, organizationId: member.organizationId, user: { id: member.userId, ...member.user } });
  });

  routes.post("/login", async (context) => {
    if (!passwordOpen) {
      throw new HttpError(409, "AUTH_PASSWORD_DISABLED", "La connexion par mot de passe n’est pas ouverte sur cet environnement.");
    }
    const body = await jsonBody(context.req.raw);
    const email = loginEmail(body.email);
    const password = assertPassword(body.password, "Le mot de passe");
    const organizationSlug = typeof body.organizationSlug === "string" ? body.organizationSlug.trim() : null;
    const selected = await verifyCredentials(db, email, password, organizationSlug);
    const emailCode = body.emailCode === undefined || body.emailCode === ""
      ? ""
      : assertString(body.emailCode, "Le code", { max: 16 });
    if (!emailCode) {
      await requestEmailLoginCode(db, {
        email,
        locale: body.locale === "en" || (!body.locale && context.req.header("accept-language")?.startsWith("en")) ? "en" : "fr",
      });
      return context.json({ status: "code_required" }, 202);
    }
    if (!await consumeEmailLoginCode(db, { email, code: emailCode })) {
      throw new HttpError(401, "EMAIL_LOGIN_CODE_INVALID", "Code invalide ou expiré.");
    }
    const session = await createWebSession(db, selected.organizationId, selected.userId, sessionDevice(context, config));
    await recordUserLogin(db, selected.userId);
    writeWebSessionCookies(context, config, session);
    return context.json({
      csrfToken: session.csrf,
      organizationId: selected.organizationId,
      user: { id: selected.userId, email },
    });
  });

  routes.post("/native/authorize", async (context) => {
    if (!passwordOpen) {
      throw new HttpError(409, "AUTH_PASSWORD_DISABLED", "La connexion par mot de passe n’est pas ouverte sur cet environnement.");
    }
    const body = await jsonBody(context.req.raw);
    const email = loginEmail(body.email);
    const password = assertPassword(body.password, "Le mot de passe");
    const codeChallenge = assertString(body.codeChallenge, "Le challenge PKCE", { min: 43, max: 128 });
    const redirectUri = assertString(body.redirectUri, "L’URI de retour", { max: 1_024 });
    const clientId = assertString(body.clientId, "Le client", { max: 100 });
    if (!config.nativeRedirectUris.includes(redirectUri)) {
      throw new HttpError(400, "REDIRECT_URI_INVALID", "Cette URI de retour n’est pas autorisée.");
    }
    const organizationSlug = typeof body.organizationSlug === "string" ? body.organizationSlug.trim() : null;
    const selected = await verifyCredentials(db, email, password, organizationSlug);
    const organizationId = selected.organizationId;
    if (!organizationId) {
      throw new HttpError(403, "MEMBERSHIP_REQUIRED", "Définissez d’abord votre organisation depuis l’application web.");
    }
    const emailCode = body.emailCode === undefined || body.emailCode === ""
      ? ""
      : assertString(body.emailCode, "Le code", { max: 16 });
    if (!emailCode) {
      await requestEmailLoginCode(db, {
        email,
        locale: body.locale === "en" || (!body.locale && context.req.header("accept-language")?.startsWith("en")) ? "en" : "fr",
      });
      return context.json({ status: "code_required" }, 202);
    }
    if (!await consumeEmailLoginCode(db, { email, code: emailCode })) {
      throw new HttpError(401, "EMAIL_LOGIN_CODE_INVALID", "Code invalide ou expiré.");
    }
    const code = await issueNativeAuthCode(db, {
      organizationId,
      userId: selected.userId,
      codeChallenge,
      redirectUri,
      clientId,
    });
    return context.json({ code, redirectUri });
  });

  routes.post("/native/token", async (context) => {
    const body = await jsonBody(context.req.raw);
    const grantType = assertString(body.grantType, "Le type de grant", { max: 64 });
    if (grantType === "authorization_code") {
      const code = assertString(body.code, "Le code", { max: 512 });
      const verifier = assertString(body.codeVerifier, "Le vérificateur PKCE", { min: 43, max: 128 });
      const redirectUri = assertString(body.redirectUri, "L’URI de retour", { max: 1_024 });
      return context.json(await exchangeNativeAuthCode(db, {
        code,
        codeVerifier: verifier,
        redirectUri,
        device: sessionDevice(context, config),
      }));
    }

    if (grantType === "refresh_token") {
      const refreshToken = assertString(body.refreshToken, "Le refresh token", { max: 512 });
      const refreshAttempt = body.refreshAttempt === undefined ? undefined
        : assertString(body.refreshAttempt, "La tentative de rafraîchissement", { min: 43, max: 43 });
      if (refreshAttempt !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(refreshAttempt)) {
        throw new HttpError(400, "VALIDATION_ERROR", "La tentative de rafraîchissement est invalide.");
      }
      return context.json(await refreshNativeSession(db, refreshToken, sessionDevice(context, config), refreshAttempt));
    }

    throw new HttpError(400, "GRANT_TYPE_INVALID", "Le type de grant n’est pas pris en charge.");
  });

  return routes;
}

export function protectedAuthRoutes(
  db: Db,
  entitlements: EntitlementSource = SOLO_ENTITLEMENTS,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/me", async (context) => {
    const original = context.get("auth");
    const fallback = original.organizationId === EMPTY_WORKSPACE_ID && !original.assistedBy
      ? await firstLivingOrganization(db, original.userId) : null;
    const auth = { ...original, organizationId: fallback ?? original.organizationId };
    const identity = await readAccountIdentityView(db, { userId: auth.userId, organizationId: auth.organizationId });
    return context.json({
      features: await readResolvedProductFeatures(db, auth),
      entitlements: await sessionEntitlements(entitlements, auth),
      user: identity.user,
      organization: identity.organization,
      role: identity.role,
      impersonation: auth.assistedBy ? { readOnly: true as const } : null,
      mustChangePassword: identity.mustChangePassword,
    });
  });

  routes.post("/logout", async (context) => {
    const auth = context.get("auth");
    const installationId = await readLogoutInstallationId(context.req.raw);
    // iOS (DEV-308): the native client names its installation, and its APNs
    // registration in this organization goes before the session does, so a
    // signed-out phone stops ringing. A failure here fails the logout: the
    // client retries rather than keep a device that still receives pushes.
    // An assistance session never touches the member's devices.
    if (installationId && !auth.assistedBy) {
      await removeApnsDevice(db, { organizationId: auth.organizationId, userId: auth.userId, installationId });
    }
    await revokeSessionOnLogout(db, auth.credentialHash, auth.sessionId);
    deleteCookie(context, SESSION_COOKIE, { path: "/" });
    deleteCookie(context, CSRF_COOKIE, { path: "/" });
    return context.body(null, 204);
  });
  return routes;
}

/**
 * The optional logout body: none, `{}`, or `{ "installationId": "<id>" }`.
 * A body that is present but unreadable is refused, never ignored.
 */
async function readLogoutInstallationId(request: Request): Promise<string | null> {
  const text = (await boundedTextBody(request, 4_096)).trim();
  if (!text) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Le corps JSON est invalide.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_JSON", "Le corps JSON est invalide.");
  }
  const value = (body as Record<string, unknown>).installationId;
  if (value === undefined || value === null) return null;
  return readApnsInstallationId(value);
}

/** Operational rights, deliberately separate from membership and billing administration. */
export function requireOperator(auth: AuthContext, message = "Droits insuffisants."): void {
  if (!canOperateWorkspace(auth.role)) throw new HttpError(403, "ROLE_REQUIRED", message);
}

/** A refusal hands control back to the application; the bare page serves only the native shell. */
function refuseGoogleCallback(
  context: Context,
  returnTo: string | null,
  code: AuthFailureCode,
): Response {
  if (returnTo) return redirectGoogleCallback(context, returnTo);
  return context.html(callbackPage(false, code), 401);
}

/**
 * Redirect through the Hono context that owns the session cookies.
 * A separate `Response` drops the existing `Set-Cookie` headers and leaves the
 * browser unauthenticated after an otherwise successful Google callback.
 */
export function redirectGoogleCallback(context: Context, returnTo: string): Response {
  return context.redirect(returnTo, 303);
}

function callbackPage(ok: boolean, code?: string): string {
  const title = ok ? "Connexion réussie" : "Connexion refusée";
  const message = ok ? "Vous pouvez revenir à openedbot." : `Cause : ${code ?? "AUTH_FAILED"}.`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

export function requireRole(
  auth: AuthContext,
  allowed: AuthContext["role"][],
  message = "Droits insuffisants.",
): void {
  if (!allowed.includes(auth.role)) throw new HttpError(403, "ROLE_REQUIRED", message);
}

/**
 * Refuses any `returnTo` whose origin is neither WEB_APP_URL nor in CORS_ALLOWED_ORIGINS: an invalid
 * URL included. `google-auth.ts#start()` does the same check in
 * depth, but silently (it falls back to `returnTo: null`
 * and lets the Google flow start anyway). Here, the failure is named and
 * immediate: without this refusal, LAN access by IP (outside these origins) breaks
 * only after the Google exchange, on an opaque `AUTH_ATTEMPT_UNKNOWN`.
 */
/** The calling page's origin, as the browser declares it. */
export function requestOrigin(context: Context): string | null {
  const origin = context.req.header("Origin");
  if (origin && origin !== "null") return origin;
  // A same-origin navigation (the Vite proxy) does not always send `Origin`
  // on a GET; the `Referer` then carries the same information.
  const referer = context.req.header("Referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * The Google callback lands on `API_PUBLIC_URL` and sets the session there; a
 * cookie is bound to its host, not to its port. In development, the SPA calls
 * the API relatively through the Vite proxy: opening the page from another
 * host (the machine's LAN IP, from a phone) would come back with a cookie set
 * on `localhost`, therefore with no session. And Google refuses to register a
 * private IP as a redirect URI: there is nothing to fix on the client side, the
 * path is email and password.
 *
 * Outside development, the API has its own origin (`VITE_API_ORIGIN`) and the
 * cookie travels with the requests: no host constraint to set.
 */
export function googleOriginSupported(config: ApiConfig, origin: string | null): boolean {
  if (config.environment !== "development" || !origin) return true;
  try {
    return new URL(origin).hostname === new URL(config.publicUrl).hostname;
  } catch {
    return false;
  }
}

export function assertTrustedReturnOrigin(returnTo: string, webOrigins: readonly string[]): void {
  let origin: string;
  try {
    origin = new URL(returnTo).origin;
  } catch {
    throw new HttpError(400, "AUTH_RETURN_ORIGIN_UNTRUSTED", "Cette adresse de retour n’est pas autorisée.");
  }
  if (!webOrigins.includes(origin)) {
    throw new HttpError(400, "AUTH_RETURN_ORIGIN_UNTRUSTED", "Cette adresse de retour n’est pas autorisée.");
  }
}

export function writeWebSessionCookies(
  context: Parameters<typeof setCookie>[0],
  config: Pick<ApiConfig, "environment">,
  session: { token: string; csrf: string },
  maxAgeSeconds = WEB_SESSION_TTL_MS / 1_000,
): void {
  const secure = config.environment === "production";
  setCookie(context, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
  setCookie(context, CSRF_COOKIE, session.csrf, {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function loginEmail(value: unknown): string {
  const email = normalizeEmail(assertString(value, "L’adresse email", { max: 320 }));
  if (!isEmailSyntaxValid(email)) throw new HttpError(400, "EMAIL_INVALID", "Adresse email invalide.");
  return email;
}
