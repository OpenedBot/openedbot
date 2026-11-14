import { activeOrganizationId, clearCloudSession, readCloudSession, readWebCsrfToken, reportWorkspaceRevoked } from "../session/cloud-session";
import { LOCALE_STORAGE_KEY } from "../i18n";
import { clientHeaders, nativeBridge } from "../platform";
import { CLIENT_UPDATE_REQUIRED, reportClientUpdateRequired, reportingClientUpdate } from "../platform/client-update";
import { clearOnboardingDraft } from "../session/onboarding-draft";
import { rememberAccountWorkspaces } from "../workspace/workspace-directory";
import { ApiClientError } from "@openedbot/browser-api-client";
import { DEFAULT_LOCALE, normalizeLocale, readInitialLocale, t } from "@openedbot/browser-i18n";
import type { AccountWorkspacesDto } from "@openedbot/contracts-api";

declare global {
  interface Window {
    __OPENEDBOT_API_ORIGIN__?: string;
  }
}

/**
 * Origin of the SaaS API. Locally it is relative and Vite serves it from the
 * same environment; in production it is injected by the web
 * configuration.
 */
export const API_ORIGIN = (globalThis.window?.__OPENEDBOT_API_ORIGIN__ ?? import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/+$/, "");

/**
 * The `fetch` of calls that do not go through `request` (an attachment's
 * bytes): a `426` there shows the update screen instead of a broken image.
 */
export const rawApiFetch = reportingClientUpdate((input, init) => globalThis.fetch(input, init));

/**
 * This module has no React context: the language is reread directly from
 * `localStorage` for network errors.
 */
export function currentLocale() {
  try {
    const raw = globalThis.window?.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw) return normalizeLocale(raw);
  } catch {
    // An unreadable preference falls back to the default, not an error.
  }
  return undefined;
}

export function apiUnavailableMessage(): string {
  return t(currentLocale() ?? DEFAULT_LOCALE, "apiClient.cloudUnavailable");
}

/**
 * A response with no JSON body (proxy, API restarting, error
 * page) must never read as « HTTP 500 »: the status is turned into
 * a sentence, with the number for whoever knows what to do with it.
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
     * The response's `X-Request-Id` header: the SAME identifier as the
     * access-log line and the API-side logger line.
     *
     * Without it, an operator who sees « L'inventaire n'a pas pu être chargé »
     * has nothing to give whoever reads the logs: the message is the same sentence
     * whether the API is down, returned 500, or Hermes refused.
     * `undefined` when the request never reached the API.
     */
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(status, message, code, requestId);
    this.name = "ApiError";
  }
}

/** The 401s that mean « cette fenêtre n'a pas (ou plus) de session cloud ». */
export const UNAUTHORIZED_CODES = new Set(["AUTH_REQUIRED", "UNAUTHORIZED", "SESSION_EXPIRED", "SESSION_REVOKED"]);

export function isUnauthorized(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401 && UNAUTHORIZED_CODES.has(error.code ?? "");
}

/** The response belonged to a space or a session other than the window's. */
export function isWorkspaceChanged(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "WORKSPACE_CHANGED";
}

export function isApiUnavailable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "API_UNAVAILABLE";
}

/** The 403 from the private-alpha gate, not a refusal from the API. */
export function isAlphaClosed(error: unknown): error is ApiError {
  // This 403 comes from the reverse proxy that guards the alpha, not from the API: it says
  // nothing about the session or the person's rights.
  return error instanceof ApiError && error.status === 403 && error.code === "ALPHA_CLOSED";
}

/**
 * The text of an error as a human must read it.
 *
 * `String(error)` yields « ApiError: … »: the class name used to land
 * at the head of the failure message in Settings, in front of a sentence already written
 * for the operator. The prefix teaches nothing to whoever reads the screen and makes
 * a domain refusal (a tool contract not respected, for example) look like a
 * technical crash.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (isApiUnavailable(error)) return apiUnavailableMessage();
  const message = error instanceof Error ? error.message.trim() : "";
  return message || fallback;
}

/**
 * Like `errorMessage`, but only the API is allowed to speak.
 *
 * A programming exception: a missing browser API, for example:
 * describes our code, not the operator's gesture: `crypto.randomUUID is not a
 * function` used to show as-is above the composer. A domain refusal stays
 * readable; everything else falls back to the sentence written for the screen.
 */
export function userFacingError(error: unknown, fallback: string): string {
  if (isApiUnavailable(error)) return apiUnavailableMessage();
  if (!(error instanceof ApiError)) return fallback;
  return error.message.trim() || fallback;
}

export function authHeadersFor(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function cloudHeaders(method: string, includeOrganization = true, native = false): Record<string, string> {
  const session = readCloudSession();
  const organizationId = session?.organizationId;
  // A native bearer has no CSRF to prove: the API requires it only on a cookie.
  const csrfToken = native ? null : (readWebCsrfToken() ?? session?.csrfToken);
  return {
    // The desktop app states its version: below the minimum, the API answers 426.
    ...(native ? clientHeaders() : {}),
    ...(includeOrganization && organizationId ? { "X-OpenedBot-Organization": organizationId } : {}),
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
   * A token to TRY in place of the window's: the probe of the
   * « Se connecter » step, or the public SSO routes (empty string). A 401 on
   * that call is the expected answer to a question, not a loss
   * of identity: it notifies no one.
   */
  tokenOverride?: string;
  /**
   * `auth/me` is the identity bootstrap: the response is the authority that
   * refreshes the organization mirror. A value left in localStorage belongs to
   * the previous session and must not turn this first request into a tenant
   * mismatch before the server has identified the current session.
   */
  skipOrganizationHeader?: boolean;
  /**
   * Deadline of the call, body read included. By default
   * `READ_TIMEOUT_MS` for a read, `WRITE_TIMEOUT_MS` for a write;
   * a known long operation (compaction) passes its own.
   */
  timeoutMs?: number;
};

/**
 * Without a deadline, a proxy that accepts the connection and never answers
 * used to freeze the call: a route guard on `auth/me`, a sign-out, a
 * mutation. A read covers the API's slowest inventory (60 s).
 * A write may wait on a Hermes mutation (up to 190 s): its bound
 * follows the server's idle ceiling (`API_IDLE_TIMEOUT`, 255 s max),
 * past which no response can arrive anymore.
 */
export const READ_TIMEOUT_MS = 75_000;
export const WRITE_TIMEOUT_MS = 260_000;

/**
 * Deadline exceeded. A write is NEVER retried on its own: the server may have
 * applied it, and the message says so to whoever would start again.
 */
function timeoutError(method: string): ApiError {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  return new ApiError(0, t(currentLocale() ?? DEFAULT_LOCALE, write ? "apiClient.writeTimeout" : "apiClient.readTimeout"), "API_TIMEOUT");
}

/**
 * A 2xx whose body is not the expected JSON (a proxy's HTML page, truncated
 * JSON): treating it as `null` fired mutation successes with no
 * confirmed operation and stored `null` in the cache.
 */
function invalidResponseError(response: Response): ApiError {
  return new ApiError(
    response.status,
    t(currentLocale() ?? DEFAULT_LOCALE, "apiClient.invalidResponse", { status: response.status }),
    "INVALID_RESPONSE",
    response.headers.get("X-Request-Id") ?? undefined,
  );
}

/** The statuses that, by definition, have no body to read. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

/**
 * The web authenticates with the HttpOnly session cookie; the native shell
 * (`lib/platform/native-bridge.ts`) with a bearer read from the bridge; the token override
 * stays reserved for unit tests.
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
  const capturedIdentity = readCloudSession()?.csrfToken;
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
        // Native shell: no cookie travels, the identity is the bearer.
        credentials: bridge ? "omit" : "include",
        headers: {
          "Content-Type": "application/json",
          // The console's own language, not the browser's: the API writes in
          // it what it phrases for a reader (a routine approval's `detail`).
          "Accept-Language": currentLocale() ?? readInitialLocale(),
          ...cloudHeaders(method, !options.skipOrganizationHeader, bridge !== null),
          ...authHeadersFor(bearer),
          ...init?.headers,
        },
      });
      // The deadline also covers the body: a server can send its
      // headers and then go silent.
      if (!BODYLESS_STATUSES.has(response.status)) text = await response.text();
    } catch {
      if (deadline.signal.aborted) throw timeoutError(method);
      throw new ApiError(0, apiUnavailableMessage(), "API_UNAVAILABLE");
    }
  } finally {
    clearTimeout(timer);
  }

  if (!options.skipOrganizationHeader && capturedOrganization !== activeOrganizationId()) {
    throw new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED");
  }
  if (capturedIdentity && capturedIdentity !== readCloudSession()?.csrfToken) {
    throw new ApiError(409, "La session a changé.", "WORKSPACE_CHANGED");
  }
  if (BODYLESS_STATUSES.has(response.status)) return undefined as T;
  // An empty body is a response with no content; an unreadable body is
  // not. On a refusal, it falls back to the status sentence (`errorFrom`).
  let body: unknown = null;
  let unreadable = false;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      unreadable = true;
    }
  }
  if (!options.skipOrganizationHeader && capturedOrganization !== activeOrganizationId()) {
    throw new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED");
  }
  if (capturedIdentity && capturedIdentity !== readCloudSession()?.csrfToken) {
    throw new ApiError(409, "La session a changé.", "WORKSPACE_CHANGED");
  }
  if (!response.ok) {
    const error = errorFrom(response, body);
    if (response.status === 426 && error.code === CLIENT_UPDATE_REQUIRED) reportClientUpdateRequired(error.details);
    // Expired native bearer: a rotation, then the same call. A refusal of the
    // rotation falls back to the ordinary 401, which clears the session.
    if (bridge && nativeRetry && !token && isUnauthorized(error)) {
      const refreshed = await bridge.refresh();
      if (refreshed) return attempt<T>(path, "", init, options, false);
    }
    if (!options.skipOrganizationHeader && error.code === "WORKSPACE_ACCESS_REVOKED" && capturedOrganization) {
      reportWorkspaceRevoked(capturedOrganization);
    }
    // A named 401, on the window's session: the router is what brings us back
    // to the « Se connecter » step (`route-tree.tsx`), not each screen.
    if (options.tokenOverride === undefined && isUnauthorized(error)) {
      // The onboarding draft leaves with the session: otherwise the next
      // person, on the same browser, would pick up the previous person's
      // bot sheet. A session that expires does not call `signOut`.
      clearOnboardingDraft();
      clearCloudSession();
    }
    throw error;
  }
  if (unreadable) throw invalidResponseError(response);
  return body as T;
}
