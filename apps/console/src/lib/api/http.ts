import { activeFleetId, activeOrganizationId, clearCloudSession, readCloudSession, readWebCsrfToken, reportWorkspaceRevoked } from "../session/cloud-session";
import { LOCALE_STORAGE_KEY } from "../i18n";
import { nativeBridge } from "../platform/native-bridge";
import { clearOnboardingDraft } from "../session/onboarding-draft";
import { rememberAccountWorkspaces } from "../workspace/workspace-directory";
import { ApiClientError } from "@openedbot/browser-api-client";
import { DEFAULT_LOCALE, normalizeLocale, t } from "@openedbot/browser-i18n";
import type { AccountWorkspacesDto } from "@openedbot/contracts-api";

declare global {
  interface Window {
    __OHB_API_ORIGIN__?: string;
  }
}

/**
 * Origine de l'API SaaS. En local elle est relative et Vite la sert depuis le
 * même environnement; en production elle est injectée par la configuration
 * web.
 */
export const API_ORIGIN = (globalThis.window?.__OHB_API_ORIGIN__ ?? import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/+$/, "");

/**
 * Ce module n'a pas de contexte React : la langue s'y relit directement dans
 * `localStorage` pour les erreurs réseau.
 */
export function currentLocale() {
  try {
    const raw = globalThis.window?.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw) return normalizeLocale(raw);
  } catch {
    // Une préférence illisible retombe sur le défaut, pas une erreur.
  }
  return undefined;
}

export function apiUnavailableMessage(): string {
  return t(currentLocale() ?? DEFAULT_LOCALE, "apiClient.cloudUnavailable");
}

/**
 * Une réponse sans corps JSON (proxy, API en cours de redémarrage, page
 * d'erreur) ne doit jamais se lire « HTTP 500 » : le statut est traduit en
 * une phrase, avec le numéro pour qui sait quoi en faire.
 */
export function httpStatusMessage(status: number): string {
  const locale = currentLocale() ?? DEFAULT_LOCALE;
  const key = status === 401
    ? "apiClient.httpUnauthorized"
    : status === 403
      ? "apiClient.httpForbidden"
      : status === 404
        ? "apiClient.httpNotFound"
        : status === 408 || status === 504
          ? "apiClient.httpTimeout"
          : status === 429
            ? "apiClient.httpRateLimited"
            : status === 502 || status === 503
              ? "apiClient.httpGateway"
              : status >= 500
                ? "apiClient.httpServerError"
                : "apiClient.httpRefused";
  return t(locale, key, { status });
}

export class ApiError extends ApiClientError {
  constructor(
    status: number,
    message: string,
    code?: string,
    /**
     * L'en-tête `X-Request-Id` de la réponse : le MÊME identifiant que la ligne
     * d'access-log et que celle du logger côté API.
     *
     * Sans lui, un opérateur qui voit « L'inventaire n'a pas pu être chargé »
     * n'a rien à donner à qui lit les journaux : le message est la même phrase
     * que l'API soit tombée, qu'elle ait rendu 500, ou que Hermes ait refusé.
     * `undefined` quand la requête n'a jamais atteint l'API.
     */
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(status, message, code, requestId);
    this.name = "ApiError";
  }
}

/** Les 401 qui veulent dire « cette fenêtre n'a pas (ou plus) de session cloud ». */
export const UNAUTHORIZED_CODES = new Set(["AUTH_REQUIRED", "UNAUTHORIZED", "SESSION_EXPIRED", "SESSION_REVOKED"]);

export function isUnauthorized(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401 && UNAUTHORIZED_CODES.has(error.code ?? "");
}

/** La réponse appartenait à un autre espace ou une autre session que ceux de la fenêtre. */
export function isWorkspaceChanged(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "WORKSPACE_CHANGED";
}

export function isApiUnavailable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "API_UNAVAILABLE";
}

/** Le 403 de la porte de l'alpha privee, pas un refus de l'API. */
export function isAlphaClosed(error: unknown): error is ApiError {
  // Ce 403 vient du reverse proxy qui garde l'alpha, pas de l'API : il ne dit
  // rien sur la session ni sur les droits de la personne.
  return error instanceof ApiError && error.status === 403 && error.code === "ALPHA_CLOSED";
}

/**
 * Le texte d'une erreur tel qu'un humain doit le lire.
 *
 * `String(error)` rend « ApiError: … » : le nom de la classe se retrouvait
 * en tête du message d'échec dans les Réglages, devant une phrase déjà écrite
 * pour l'opérateur. Le préfixe n'apprend rien à qui lit l'écran et fait passer
 * un refus métier (un contrat d'outils non respecté, par exemple) pour un
 * plantage technique.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (isApiUnavailable(error)) return apiUnavailableMessage();
  const message = error instanceof Error ? error.message.trim() : "";
  return message || fallback;
}

/**
 * Comme `errorMessage`, mais seule l'API a le droit de parler.
 *
 * Une exception de programmation: une API navigateur absente, par exemple :
 * décrit notre code, pas le geste de l'opérateur : `crypto.randomUUID is not a
 * function` s'affichait tel quel au-dessus du composer. Un refus métier reste
 * lisible, tout le reste retombe sur la phrase écrite pour l'écran.
 */
export function userFacingError(error: unknown, fallback: string): string {
  if (isApiUnavailable(error)) return apiUnavailableMessage();
  if (!(error instanceof ApiError)) return fallback;
  return error.message.trim() || fallback;
}

export function authHeadersFor(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Le jeton du guichet, s'il y en a un.
 *
 * `null` n'est pas une erreur : un opérateur connecté n'a pas besoin de jeton,
 * son cookie de session ouvre ses propres fils (porte COMPTE, migration 0078).
 * Poser un en-tête vide serait pire que de ne pas le poser : le serveur le
 * lirait comme un jeton difforme.
 */
export function supportTokenHeader(token: string | null): Record<string, string> {
  return token ? { "X-OpenedBot-Support-Token": token } : {};
}

export function cloudHeaders(method: string, includeOrganization = true, native = false): Record<string, string> {
  const session = readCloudSession();
  const organizationId = session?.organizationId;
  const fleetId = includeOrganization ? activeFleetId() : null;
  // Un bearer natif n'a pas de CSRF à prouver : l'API ne l'exige que sur un cookie.
  const csrfToken = native ? null : (readWebCsrfToken() ?? session?.csrfToken);
  return {
    ...(includeOrganization && organizationId ? { "X-OpenedBot-Organization": organizationId } : {}),
    ...(fleetId ? { "X-OpenedBot-Fleet": fleetId } : {}),
    ...(csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)
      ? { "X-CSRF-Token": csrfToken }
      : {}),
  };
}

export function errorFrom(response: Response, body: unknown): ApiError {
  const nested = body && typeof body === "object" && "error" in body &&
    typeof (body as { error?: unknown }).error === "object" &&
    (body as { error?: unknown }).error !== null
    ? (body as { error: { message?: unknown; code?: unknown; details?: unknown } }).error
    : null;
  const message = typeof nested?.message === "string"
    ? nested.message
    : body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : httpStatusMessage(response.status);
  const code = typeof nested?.code === "string"
    ? nested.code
    : body && typeof body === "object" && "code" in body
      ? String((body as { code: unknown }).code)
      : undefined;
  return new ApiError(response.status, message, code, response.headers.get("X-Request-Id") ?? undefined, nested?.details);
}

export type RequestOptions = {
  /**
   * Un jeton à ESSAYER à la place de celui de la fenêtre: la sonde de l'étape
   * « Se connecter », ou les routes publiques du SSO (chaîne vide). Un 401 sur
   * cet appel-là est la réponse attendue à une question, pas une perte
   * d'identité : il ne prévient personne.
   */
  tokenOverride?: string;
  /**
   * `auth/me` is the identity bootstrap: the response is the authority that
   * refreshes the organization mirror. A value left in localStorage belongs to
   * the previous session and must not turn this first request into a tenant
   * mismatch before the server has identified the current session.
   */
  skipOrganizationHeader?: boolean;
  /** Bind agency client reads to either the selected client frame or its fleet frame. */
  fleetClientContext?: FleetClientRequestContext;
  /**
   * Échéance de l'appel, lecture du corps comprise. Par défaut
   * `READ_TIMEOUT_MS` pour une lecture, `WRITE_TIMEOUT_MS` pour une écriture ;
   * une opération longue connue (la compaction) passe la sienne.
   */
  timeoutMs?: number;
};

/**
 * Sans échéance, un proxy qui accepte la connexion sans jamais répondre
 * figeait l'appel : un garde de route sur `auth/me`, une déconnexion, une
 * mutation. Une lecture couvre l'inventaire le plus lent de l'API (60 s).
 * Une écriture peut attendre une mutation Hermes (jusqu'à 190 s) : sa borne
 * suit le plafond d'inactivité du serveur (`API_IDLE_TIMEOUT`, 255 s max),
 * au-delà duquel aucune réponse ne peut plus arriver.
 */
export const READ_TIMEOUT_MS = 75_000;
export const WRITE_TIMEOUT_MS = 260_000;

/**
 * Délai dépassé. Une écriture n'est JAMAIS rejouée d'office : le serveur a pu
 * l'appliquer, et le message le dit à qui voudrait recommencer.
 */
function timeoutError(method: string): ApiError {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  return new ApiError(0, t(currentLocale() ?? DEFAULT_LOCALE, write ? "apiClient.writeTimeout" : "apiClient.readTimeout"), "API_TIMEOUT");
}

/**
 * Un 2xx dont le corps n'est pas le JSON attendu (page HTML d'un proxy, JSON
 * tronqué) : le traiter comme `null` déclenchait les succès des mutations sans
 * opération confirmée et rangeait `null` dans le cache.
 */
function invalidResponseError(response: Response): ApiError {
  return new ApiError(
    response.status,
    t(currentLocale() ?? DEFAULT_LOCALE, "apiClient.invalidResponse", { status: response.status }),
    "INVALID_RESPONSE",
    response.headers.get("X-Request-Id") ?? undefined,
  );
}

/** Les statuts qui n'ont, par définition, aucun corps à lire. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

export type FleetClientRequestContext = {
  frameOrganizationId: string;
  frameFleetId: string | null;
  clientOrganizationId: string;
  fleetId: string;
  identity: { userId: string | null; csrfToken: string | null };
  revokeClientFrame: boolean;
};

export function fleetClientRequestContext(fleetId: string, clientOrganizationId: string): FleetClientRequestContext {
  const session = readCloudSession();
  const frameOrganizationId = activeOrganizationId() ?? "";
  const frameFleetId = activeFleetId();
  const revokeClientFrame = frameOrganizationId === clientOrganizationId && frameFleetId === fleetId;
  const fleetFrame = frameOrganizationId === fleetId && frameFleetId === null;
  if (!revokeClientFrame && !fleetFrame) {
    throw new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED");
  }
  return {
    frameOrganizationId,
    frameFleetId,
    clientOrganizationId,
    fleetId,
    identity: { userId: session?.userId ?? null, csrfToken: session?.csrfToken ?? null },
    revokeClientFrame,
  };
}

export function fleetAuditRequestContext(fleetId: string, clientOrganizationId: string): FleetClientRequestContext {
  const context = fleetClientRequestContext(fleetId, clientOrganizationId);
  if (!context.revokeClientFrame) throw new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED");
  return context;
}

export function assertFleetClientRequestContext(context: FleetClientRequestContext): void {
  const session = readCloudSession();
  if (
    context.frameOrganizationId !== activeOrganizationId() ||
    context.frameFleetId !== activeFleetId() ||
    context.identity.userId !== (session?.userId ?? null) ||
    context.identity.csrfToken !== (session?.csrfToken ?? null)
  ) {
    throw new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED");
  }
}

/**
 * Le web s'authentifie par le cookie HttpOnly de session ; la coque native
 * (`lib/platform/native-bridge.ts`) par un bearer lu sur le pont ; le token override
 * reste réservé aux tests unitaires.
 */
export async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  return attempt<T>(path, options.tokenOverride ?? "", init, options);
}

/**
 * One network read for callers that ask for the same resource at once. Three
 * cache keys read `GET /api/runtime` and two route guards read the workspace
 * directory one after the other: without this, one page load paid for each.
 * `reuseMs` also hands a just-resolved answer to a caller that comes right
 * after; leave it at 0 wherever a write may have changed the answer.
 */
export const sharedReads = new Map<string, { promise: Promise<unknown>; settledAt: number | null }>();

export function sharedRead<T>(key: string, read: () => Promise<T>, reuseMs = 0): Promise<T> {
  const current = sharedReads.get(key);
  if (current && (current.settledAt === null || Date.now() - current.settledAt < reuseMs)) {
    return current.promise as Promise<T>;
  }
  const entry: { promise: Promise<unknown>; settledAt: number | null } = { promise: Promise.resolve(), settledAt: null };
  entry.promise = read().then(
    (value) => {
      if (reuseMs > 0) entry.settledAt = Date.now();
      else if (sharedReads.get(key) === entry) sharedReads.delete(key);
      return value;
    },
    (error: unknown) => {
      if (sharedReads.get(key) === entry) sharedReads.delete(key);
      throw error;
    },
  );
  sharedReads.set(key, entry);
  return entry.promise as Promise<T>;
}

/** Best effort: without it, the route guard reads the directory again on the next navigation. */
export async function primeWorkspaceDirectory(): Promise<void> {
  const account = await request<AccountWorkspacesDto>("/api/account/workspaces", undefined, { skipOrganizationHeader: true }).catch(() => null);
  if (account) rememberAccountWorkspaces(account);
}

export async function attempt<T>(
  path: string,
  token: string,
  init: RequestInit | undefined,
  options: RequestOptions,
  nativeRetry = true,
): Promise<T> {
  const bridge = nativeBridge();
  const bearer = token || (bridge ? (await bridge.readAccessToken()) ?? "" : "");
  const capturedOrganization = activeOrganizationId();
  const capturedFleet = activeFleetId();
  const capturedIdentity = readCloudSession()?.csrfToken;
  if (options.fleetClientContext) assertFleetClientRequestContext(options.fleetClientContext);
  const method = (init?.method ?? "GET").toUpperCase();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    options.timeoutMs ?? (["GET", "HEAD", "OPTIONS"].includes(method) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
  );
  let response: Response;
  let text: string | null = null;
  try {
    try {
      response = await fetch(`${API_ORIGIN}${path}`, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal,
        // Coque native : aucun cookie ne voyage, l'identité est le bearer.
        credentials: bridge ? "omit" : "include",
        headers: {
          "Content-Type": "application/json",
          ...cloudHeaders(method, !options.skipOrganizationHeader, bridge !== null),
          ...authHeadersFor(bearer),
          ...init?.headers,
        },
      });
      // L'échéance couvre aussi le corps : un serveur peut envoyer ses
      // en-têtes puis se taire.
      if (!BODYLESS_STATUSES.has(response.status)) text = await response.text();
    } catch {
      if (deadline.signal.aborted) throw timeoutError(method);
      throw new ApiError(0, apiUnavailableMessage(), "API_UNAVAILABLE");
    }
  } finally {
    clearTimeout(timer);
  }

  if (options.fleetClientContext) assertFleetClientRequestContext(options.fleetClientContext);
  else if (!options.skipOrganizationHeader && (capturedOrganization !== activeOrganizationId() || capturedFleet !== activeFleetId())) {
    throw new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED");
  }
  if (capturedIdentity && capturedIdentity !== readCloudSession()?.csrfToken) {
    throw new ApiError(409, "La session a changé.", "WORKSPACE_CHANGED");
  }
  if (BODYLESS_STATUSES.has(response.status)) return undefined as T;
  // Un corps vide est une réponse sans contenu ; un corps illisible n'en est
  // pas une. Sur un refus, il retombe sur la phrase du statut (`errorFrom`).
  let body: unknown = null;
  let unreadable = false;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      unreadable = true;
    }
  }
  if (options.fleetClientContext) assertFleetClientRequestContext(options.fleetClientContext);
  else if (!options.skipOrganizationHeader && (capturedOrganization !== activeOrganizationId() || capturedFleet !== activeFleetId())) {
    throw new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED");
  }
  if (capturedIdentity && capturedIdentity !== readCloudSession()?.csrfToken) {
    throw new ApiError(409, "La session a changé.", "WORKSPACE_CHANGED");
  }
  if (!response.ok) {
    const error = errorFrom(response, body);
    // Bearer natif périmé : une rotation, puis le même appel. Un refus de la
    // rotation retombe sur le 401 ordinaire, qui efface la session.
    if (bridge && nativeRetry && !token && isUnauthorized(error)) {
      const refreshed = await bridge.refresh();
      if (refreshed) return attempt<T>(path, "", init, options, false);
    }
    if (options.fleetClientContext) {
      if (options.fleetClientContext.revokeClientFrame && error.code === "WORKSPACE_ACCESS_REVOKED") {
        reportWorkspaceRevoked(options.fleetClientContext.clientOrganizationId, options.fleetClientContext.frameFleetId);
      }
    } else if (!options.skipOrganizationHeader && error.code === "WORKSPACE_ACCESS_REVOKED" && capturedOrganization) {
      reportWorkspaceRevoked(capturedOrganization);
    }
    // Un 401 nommé, sur la session de la fenêtre : c'est le routeur qui ramène
    // à l'étape « Se connecter » (`route-tree.tsx`), pas chaque écran.
    if (options.tokenOverride === undefined && isUnauthorized(error)) {
      // Le brouillon d'accueil part avec la session : sinon la personne
      // suivante, sur le même navigateur, reprendrait la fiche de bot de la
      // précédente. Une session qui expire n'appelle pas `signOut`.
      clearOnboardingDraft();
      clearCloudSession();
    }
    throw error;
  }
  if (unreadable) throw invalidResponseError(response);
  return body as T;
}
