import { consumeEmailLoginCode, requestEmailLoginCode, verifyEmailLoginCode } from "@openedbot/identity/application/email-login-code";
import { isEmailSyntaxValid, normalizeEmail } from "@openedbot/identity/domain/email-address";
import { isUuid } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { canOperateWorkspace, type AuthFailureCode, type AuthProvidersDto, type OrganizationKind, type WorkspaceRole } from "@openedbot/contracts-api";
import type { ApiConfig } from "../../infrastructure/config";
import { requestHeader, requestQuery } from "../../application/compat-aliases";
import type { Db } from "@openedbot/platform-db";
import { withCredential } from "@openedbot/platform-db";
import { hashCredential } from "../../infrastructure/crypto";
import { assertPassword, assertString, boundedTextBody, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { requestClientIp } from "../../interfaces/http/rate-limit";
import { authFailureCode } from "@openedbot/identity/domain/signup";
import { createGoogleAuth } from "@openedbot/identity/application/google-auth";
import { createPostgresOAuthAttemptStore, OAuthAttemptTransitionError } from "@openedbot/identity/application/oauth-attempt-store";
import { firstLivingOrganization, recordUserLogin, verifyCredentials } from "@openedbot/identity/application/accounts";
import { resolveGoogleIdentity } from "@openedbot/identity/application/google-identity";
import { linkGoogleIdentity } from "@openedbot/identity/application/google-link";
import { agencyAccessAllowed, readWorkspaceAccess } from "@openedbot/identity/application/workspace-access";
import {
  createWebSession,
  findLiveSession,
  revokeSessionOnLogout,
  touchSession,
  WEB_SESSION_TTL_MS,
  type SessionDevice,
} from "@openedbot/identity/application/sessions";
import { exchangeNativeAuthCode, issueNativeAuthCode, refreshNativeSession } from "@openedbot/identity/application/native-auth";
import { readAccountIdentityView, resolveSessionIdentity } from "@openedbot/identity/application/session-identity";
import type { ImpersonationSource } from "@openedbot/platform-plugins";
import { logger } from "@openedbot/platform-observability";
import { removeApnsDevice } from "@openedbot/notifications/application/apns-devices";
import { readApnsInstallationId } from "@openedbot/notifications/domain/apns";
import { fleetWorkspacesEnabled, readResolvedProductFeatures, sessionEntitlements, waitlistEnabled, type ProductFeatureSource } from "../../application/product-features";

import { agencyRequestAllowed, assertWorkspaceId, EMPTY_WORKSPACE_ID, isAccountIdentityPath } from "@openedbot/identity/domain/workspace-access";

const SESSION_COOKIE = "openedbot_session";
const CSRF_COOKIE = "openedbot_csrf";

export type AuthContext = {
  sessionId: string;
  organizationId: string;
  userId: string;
  role: WorkspaceRole;
  /** Explicit mandate used for this request; personal membership privileges do not apply. */
  actingFleetId?: string;
  /** Type of the session's organization; absent when the session has no organization yet. */
  organizationKind?: OrganizationKind;
  kind: "web" | "native";
  credentialHash: string;
  /** Absent only in legacy in-process callers; authenticated DB sessions always set it. */
  impersonatedByStaffUserId?: string | null;
};

export type AppVariables = { auth: AuthContext };

/** The request header naming the fleet organization acting for the client (a mandate). */
export const FLEET_HEADER = "X-OpenedBot-Fleet";
export const ORGANIZATION_HEADER = "X-OpenedBot-Organization";
/** Its query form, for a GET that cannot set a header (a download link). */
export const FLEET_QUERY = "fleetId";

/**
 * `user-agent` tronqué à 256, et l'IP par la règle CANONIQUE du dépôt :
 * `requestClientIp`, celle qui sert déjà à la limitation de débit.
 *
 * Cette fonction en réimplémentait une moitié : le dernier hop de
 * `x-forwarded-for` sous `trustProxy`, et `null` sinon. Elle oubliait le
 * repli que `rate-limit.ts` a toujours eu : l'IP de SOCKET. Hors production
 * `API_TRUST_PROXY` est faux (il n'est obligatoire que derrière le proxy TLS,
 * `assertProductionConfig`) : aucune session locale n'avait donc jamais
 * d'adresse, et l'écran « Sécurité » affichait « Inconnu » sur toutes les
 * lignes. Ce n'était pas une donnée absente, c'était une donnée jamais lue.
 *
 * La règle de non-falsifiabilité ne bouge pas : sans proxy de confiance,
 * `x-forwarded-for` reste ignoré : il est posé par le client. Ce qu'on ajoute
 * est l'adresse de la socket, que le client ne choisit pas.
 *
 * `"unknown"` (pas de socket exposée, cas des tests montés sur `app.request`)
 * redevient `null` : la colonne `sessions.ip` est un `inet`, pas du texte.
 */
export function sessionDevice(context: Context, config: Pick<ApiConfig, "trustProxy">): SessionDevice {
  const userAgent = context.req.header("user-agent")?.slice(0, 256) ?? null;
  const server = context.env as
    | { requestIP?: (request: Request) => { address: string } | null }
    | undefined;
  const ip = requestClientIp(context.req.raw, server, config.trustProxy);
  return { userAgent, ip: ip === "unknown" ? null : ip };
}

/** Ce qu'une route PUBLIQUE peut apprendre d'une session, quand il y en a une. */
export type OptionalSessionIdentity = {
  userId: string;
  organizationId: string;
  email: string;
};

/**
 * Résout la session d'une requête sans l'exiger.
 *
 * `authMiddleware` jette : c'est ce qu'on veut d'une porte. Une route publique
 * a besoin de l'inverse, reconnaître qui est là SANS refuser ceux qui ne sont
 * personne. Le guichet de support s'en sert : un opérateur connecté n'a pas à
 * retaper l'adresse que son compte porte déjà.
 *
 * L'identité vient de la BASE, jamais du corps de la requête. Un client qui
 * annoncerait son adresse se ferait passer pour quelqu'un d'autre en une ligne
 * de `curl`.
 *
 * Trois refus, et un seul est bruyant :
 *
 * - aucun justificatif, ou un justificatif qui n'ouvre plus rien : `null`.
 *   Une session périmée ne doit pas casser une route publique, elle doit
 *   simplement ne pas identifier ;
 * - une adhésion absente : `null` de même. Un compte sans organisation n'a
 *   pas d'identité produit ;
 * - un cookie sur une méthode non sûre sans jeton CSRF valide : 403. Là on
 *   parle, parce que le client légitime en envoie toujours un et que le
 *   silence laisserait croire à une session absente. `SameSite=Lax` bloque
 *   déjà le cookie sur un POST inter-site ; cette vérification est la
 *   seconde garde, celle qui ne dépend pas du navigateur.
 */
export async function readOptionalSessionIdentity(
  db: Db,
  context: Context,
): Promise<OptionalSessionIdentity | null> {
  const authorization = context.req.header("Authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  const cookie = getCookie(context, SESSION_COOKIE) ?? null;
  const credential = bearer || cookie;
  if (!credential) return null;
  const credentialHash = hashCredential(credential);

  const session = await resolveSessionIdentity(db, credentialHash);
  if (!session) return null;

  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
  if (!bearer && unsafe) {
    const csrf = context.req.header("X-CSRF-Token");
    if (!csrf || !session.csrfHash || hashCredential(csrf) !== session.csrfHash) {
      throw new HttpError(403, "CSRF_INVALID", "Le jeton CSRF est absent ou invalide.");
    }
  }
  return { userId: session.userId, organizationId: session.organizationId, email: session.email };
}

/**
 * `accountIdentity`: the request is an account action whatever its path (as
 * `isAccountIdentityPath`), for a plug-in route lent the session through
 * `fleetHost` (an invitation accepted before the invitee has a workspace).
 */
export function authMiddleware(
  db: Db,
  agencyEnabled: ProductFeatureSource = false,
  options: { readonly accountIdentity?: boolean } = {},
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const authorization = context.req.header("Authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
    const cookie = getCookie(context, SESSION_COOKIE) ?? null;
    const credential = bearer || cookie;
    if (!credential) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
    const credentialHash = hashCredential(credential);
    const headerOrganization = requestHeader(context, ORGANIZATION_HEADER);
    const downloadOrganization = context.req.method === "GET" ? context.req.query("organizationId") : undefined;
    if (headerOrganization && downloadOrganization && headerOrganization !== downloadOrganization) {
      throw new HttpError(403, "TENANT_MISMATCH", "Les contextes d’espace ne correspondent pas.");
    }
    const requestedOrganization = headerOrganization || downloadOrganization;
    if (requestedOrganization) assertWorkspaceId(requestedOrganization);
    // `X-OpenedBot-Fleet` / `?fleetId=` (step 11.2); an old name only through an alias (`requestHeader`).
    const headerFleet = requestHeader(context, FLEET_HEADER);
    const queryFleet = context.req.method === "GET" ? requestQuery(context, FLEET_QUERY) : undefined;
    if (headerFleet && queryFleet && headerFleet !== queryFleet) {
      throw new HttpError(403, "TENANT_MISMATCH", "Les contextes d’agence ne correspondent pas.");
    }
    const actingFleetId = headerFleet || queryFleet || undefined;
    if (actingFleetId) {
      assertWorkspaceId(actingFleetId);
    }
    const accountPath = options.accountIdentity === true || isAccountIdentityPath(context.req.path);

    const session = await withCredential(db, credentialHash, async (tx) => {
      const found = await findLiveSession(tx, credentialHash);
      if (!found) return null;
      const agencyAvailable = await fleetWorkspacesEnabled(agencyEnabled, found);
      if (actingFleetId && !agencyAvailable) throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Le contexte agence n’est plus disponible.");
      const pinned = found.kind !== "web" || Boolean(found.impersonatedByStaffUserId);
      // Native sans organisation (0158) : routes de compte comme le web, pour
      // la définir ; elle reste épinglée, aucun en-tête n'ouvre un autre espace.
      const accountReachable = !pinned || (found.kind === "native" && !found.organizationId);
      if (actingFleetId && pinned) {
        throw new HttpError(403, "TENANT_MISMATCH", "Cette session ne peut pas agir pour une agence.");
      }
      if (requestedOrganization && requestedOrganization !== found.organizationId && (pinned || !isUuid(requestedOrganization))) {
        throw new HttpError(403, "TENANT_MISMATCH", "Cette session n’appartient pas à cette organisation.");
      }
      if (found.impersonatedByStaffUserId && accountPath
        && context.req.path !== "/api/auth/me" && context.req.path !== "/api/auth/logout") {
        throw new HttpError(403, "IMPERSONATION_READ_ONLY", "L’assistance ne peut pas accéder aux autres espaces.");
      }
      const organizationId = requestedOrganization || found.organizationId || EMPTY_WORKSPACE_ID;
      await tx`select set_config('app.organization_id', ${organizationId}, true)`;
      await touchSession(tx, found.id);
      // Membership directe ou grant d'agence vivant : `workspace_access` (0086)
      // est la seule définition, relue à chaque requête.
      const access = await readWorkspaceAccess(tx, found.userId, organizationId);
      if (actingFleetId && (access?.kind !== "personal" || !access.viaAgencyIds.includes(actingFleetId))) {
        throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Le mandat de cette agence n’est plus actif.");
      }
      const role = actingFleetId ? "agency" : access?.role ?? null;
      if (!access || !role || !agencyAccessAllowed(access, agencyAvailable)) {
        const selectedDisabledAgency = !agencyAvailable && access?.kind === "agency";
        if (accountPath && accountReachable && (
          (context.req.path !== "/api/auth/me" || !requestedOrganization) || selectedDisabledAgency
        )) return { ...found, organizationId: EMPTY_WORKSPACE_ID, role: "member" as const };
        throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Vous n’avez plus accès à cet espace.");
      }
      return { ...found, organizationId, role, organizationKind: access.kind, actingFleetId };
    });
    if (!session) throw new HttpError(401, "SESSION_EXPIRED", "La session a expiré.");
    if (session.role === "agency" && !agencyRequestAllowed(context.req.method, context.req.path, new URL(context.req.url).searchParams)) {
      throw new HttpError(403, "ROLE_REQUIRED", "Cette action est réservée au client propriétaire.");
    }

    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
    if (!bearer && unsafe) {
      const csrf = context.req.header("X-CSRF-Token");
      if (!csrf || !session.csrfHash || hashCredential(csrf) !== session.csrfHash) {
        throw new HttpError(403, "CSRF_INVALID", "Le jeton CSRF est absent ou invalide.");
      }
    }

    // Une session d'assistance sert à reproduire et inspecter l'état vu par le
    // membre. Elle ne doit jamais devenir un raccourci d'écriture au nom de la
    // personne, même si son rôle tenant est owner/admin.
    if (unsafe && session.impersonatedByStaffUserId && context.req.path !== "/api/auth/logout") {
      throw new HttpError(
        403,
        "IMPERSONATION_READ_ONLY",
        "Le mode assistance est en lecture seule.",
      );
    }

    const { id: sessionId, ...sessionContext } = session;
    context.set("auth", { ...sessionContext, sessionId, credentialHash });
    await next();
    if (actingFleetId && unsafe) {
      logger.info({ event: "fleet.action", actorUserId: session.userId, organizationId: session.organizationId,
        actingFleetId, method: context.req.method, path: context.req.routePath, status: context.res.status }, "fleet action");
    }
  };
}

export function authRoutes(
  db: Db,
  config: ApiConfig,
  agencyFeature: ProductFeatureSource = false,
  /**
   * Who opens an assisted session from a one-shot code: the plug-in that
   * runs the backoffice. `null` (solo): no assisted session, the claim route
   * answers like an unknown route.
   */
  impersonation: ImpersonationSource | null = null,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const google = createGoogleAuth(config, createPostgresOAuthAttemptStore(db, config.tokenEncryption));
  // Prod n'ouvre que Google. Le mot de passe reste la porte de dev et de
  // preprod (`OPENEDBOT_ENV=preprod`). Un appel direct est refusé, pas seulement caché.
  const passwordOpen = config.deployEnvironment !== "prod";

  // Les réponses d'auth contiennent des identifiants de tentative, des codes
  // one-shot ou une session. Aucun cache ni Referer sortant ne doit les garder.
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
      waitlist: { required: await waitlistEnabled(agencyFeature) },
    };
    // Les comptes semés ne quittent l'API qu'en développement, et seulement
    // vers la porte : ailleurs ces champs n'existent même pas.
    if (config.devSignIn) providers.devSignIn = config.devSignIn;
    return context.json(providers);
  });

  routes.post("/google/start", async (context) => {
    if (!google.enabled) throw new HttpError(409, "AUTH_PROVIDER_DISABLED", "Google OAuth n’est pas configuré.");
    // Une origine qui ne peut pas recevoir la session du callback ne doit pas
    // partir vers Google pour revenir sans cookie : le refus est nommé ici.
    if (!googleOriginSupported(config, requestOrigin(context))) {
      throw new HttpError(
        409,
        "AUTH_GOOGLE_ORIGIN_UNSUPPORTED",
        "Le SSO Google n’aboutit pas depuis cette origine : le callback OAuth est lié à API_PUBLIC_URL.",
      );
    }
    const body = await jsonBody(context.req.raw);
    const returnTo = typeof body.returnTo === "string" ? body.returnTo : null;
    // Un `returnTo` d'une origine hors WEB_APP_URL / CORS_ALLOWED_ORIGINS (ex. accès LAN par IP) ne
    // doit pas laisser le flux Google démarrer pour échouer plus tard, hors
    // vue de l'opérateur : le refus est immédiat, ici, au clic.
    if (returnTo) assertTrustedReturnOrigin(returnTo, config.webOrigins);
    return context.json(await google.start(returnTo));
  });

  routes.get("/google/callback", async (context) => {
    const result = await google.callback(new URL(context.req.url).searchParams);
    if (!result.ok) return refuseGoogleCallback(context, result.returnTo, result.code);
    const waitlistRequired = await waitlistEnabled(agencyFeature);
    try {
      if (result.link) {
        // Liaison depuis « Mon compte » : l'utilisateur a déjà sa session.
        // Rien n'est ouvert ici ; la page qui sonde `link/claim` voit l'issue.
        await linkGoogleIdentity(db, result.link.userId, result.identity);
        await google.completeLink(result.attemptId);
        return context.html(callbackPage(true));
      }
      if (result.native) {
        // Sans organisation, le desktop l'ouvre dans l'onboarding (0158).
        const member = await resolveGoogleIdentity(db, result.identity, { waitlistRequired });
        await google.completeNative(result.attemptId, member);
      } else {
        const member = await resolveGoogleIdentity(db, result.identity, { waitlistRequired });
        await google.completeWeb(result.attemptId, member.user);
        const session = await createWebSession(db, member.organizationId, member.userId, sessionDevice(context, config));
        await recordUserLogin(db, member.userId);
        const issued = { ...session, user: member.user };
        writeWebSessionCookies(context, config, issued);
      }
    } catch (error) {
      // Sans ce filet, l'échec remontait au gestionnaire global : du JSON brut
      // à l'origine de l'API, une tentative laissée `pending` et un client qui
      // sonde dans le vide. Le refus est nommé, posé, puis rendu à l'app.
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

  // Dated debt (open-core step 11.4, until 2026-12-31): the claim stays a
  // core route because it writes the core's web session cookies; the plug-in
  // only checks the code (`ImpersonationSource`). Its pre-11.4 path is the
  // plug-in's exact alias, never the core's.
  routes.post("/assisted-sessions/claim", async (context) => {
    if (!impersonation) return context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404);
    const adminOrigin = config.adminUrl ? new URL(config.adminUrl).origin : null;
    if (!adminOrigin || requestOrigin(context) !== adminOrigin) {
      throw new HttpError(403, "ASSISTED_SESSION_ORIGIN_INVALID", "Cette origine ne peut pas ouvrir le mode assistance.");
    }
    const contentType = context.req.header("Content-Type")?.toLowerCase() ?? "";
    const body = contentType.startsWith("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(await context.req.text()))
      : await jsonBody(context.req.raw);
    const code = assertString(body.code, "Le code d’assistance", { max: 512 });
    const session = await impersonation.claim(db, hashCredential(code), sessionDevice(context, config));
    if (!session) {
      throw new HttpError(400, "ASSISTED_SESSION_CLAIM_INVALID", "Ce lien d’assistance est invalide ou expiré.");
    }
    writeWebSessionCookies(context, config, session, session.ttlMs / 1_000);
    return context.redirect(config.webUrl, 303);
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
    const member = await verifyEmailLoginCode(db, { email, code, waitlistRequired: await waitlistEnabled(agencyFeature) });
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
      return context.json(await refreshNativeSession(db, refreshToken, sessionDevice(context, config)));
    }

    throw new HttpError(400, "GRANT_TYPE_INVALID", "Le type de grant n’est pas pris en charge.");
  });

  return routes;
}

export function protectedAuthRoutes(
  db: Db,
  agencyFeature: ProductFeatureSource = false,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/me", async (context) => {
    const original = context.get("auth");
    const agencyAvailable = await fleetWorkspacesEnabled(agencyFeature, original);
    const fallback = original.organizationId === EMPTY_WORKSPACE_ID && !original.impersonatedByStaffUserId
      ? await firstLivingOrganization(db, original.userId, agencyAvailable) : null;
    const auth = { ...original, organizationId: fallback ?? original.organizationId };
    const identity = await readAccountIdentityView(db, { userId: auth.userId, organizationId: auth.organizationId });
    return context.json({
      features: await readResolvedProductFeatures(db, auth),
      entitlements: await sessionEntitlements(agencyFeature, auth),
      user: identity.user,
      organization: identity.organization,
      role: identity.role,
      impersonation: auth.impersonatedByStaffUserId ? { readOnly: true as const } : null,
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
    if (installationId && !auth.impersonatedByStaffUserId && auth.role !== "agency") {
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

/** Un refus rend la main à l'application ; la page nue ne sert que la coque native. */
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
 * Refuse tout `returnTo` dont l'origine n'est ni WEB_APP_URL ni dans CORS_ALLOWED_ORIGINS : URL
 * invalide comprise. `google-auth.ts#start()` fait la même vérification en
 * défense en profondeur, mais en silence (elle retombe sur `returnTo: null`
 * et laisse le flux Google démarrer quand même). Ici, l'échec est nommé et
 * immédiat : sans ce refus, un accès LAN par IP (hors de ces origines) ne casse
 * qu'après l'échange Google, sur un `AUTH_ATTEMPT_UNKNOWN` opaque.
 */
/** L'origine de la page appelante, telle que le navigateur la déclare. */
export function requestOrigin(context: Context): string | null {
  const origin = context.req.header("Origin");
  if (origin && origin !== "null") return origin;
  // Une navigation same-origin (le proxy Vite) n'envoie pas toujours `Origin`
  // sur un GET ; le `Referer` porte alors la même information.
  const referer = context.req.header("Referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * Le callback Google atterrit sur `API_PUBLIC_URL` et y pose la session ; un
 * cookie est lié à son hôte, pas à son port. En développement, la SPA appelle
 * l'API en relatif à travers le proxy Vite : ouvrir la page depuis une autre
 * hôte (l'IP LAN du poste, depuis un téléphone) reviendrait avec un cookie posé
 * sur `localhost`, donc sans session. Et Google refuse d'enregistrer une IP
 * privée comme URI de redirection : il n'y a rien à corriger côté client, le
 * chemin est l'e-mail et le mot de passe.
 *
 * Hors développement, l'API a sa propre origine (`VITE_API_ORIGIN`) et le
 * cookie voyage avec les requêtes : aucune contrainte d'hôte à poser.
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
