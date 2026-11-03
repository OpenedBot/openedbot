import { net, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import type { PasswordCredentials, SigninLocale, SigninState } from "../shared/bridge";
import type { DesktopConfig } from "./config";
import { trustedConsoleOrigins } from "./target";
import { log } from "./log";
import { clearTokens, isNativeTokens, loadTokens, saveTokens, type NativeTokens } from "./token-store";

// Refresh this long before expiry so a request in flight never carries a token
// that dies on the way.
const REFRESH_MARGIN_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;
const SIGNIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_POLL_FAILURES = 5;
const TRANSIENT_REFRESH_RETRY_MS = 30_000;
// setTimeout silently fires immediately above this bound.
const MAX_TIMER_MS = 2 ** 31 - 1;

export type AuthEvents = {
  onSignedIn(): void;
  onSignedOut(reason: "signed-out" | "session-lost"): void;
  onSigninState(state: SigninState): void;
};

/** What a token consumer other than the console (the hosted popup) gets: never the refresh token. */
export type AccessGrant = { accessToken: string; accessTokenExpiresAt: string; organizationId: string | null };

export type AuthService = {
  /** Loads the persisted session, if any. Call once after app ready (safeStorage needs it). */
  restore(): boolean;
  isSignedIn(): boolean;
  readAccessToken(): Promise<string | null>;
  refresh(): Promise<string | null>;
  /**
   * readAccessToken / refresh for the popup, through the same single-flight
   * rotation, with the expiry and tenant it needs. A forced read skips the
   * rotation when the token was already rotated since `servedToken` was handed
   * out (by the console's refresh, say): rotating again would only invalidate
   * the console's fresh token. null when signed out; throws on transient failure.
   */
  readAccess(options: { force: boolean; servedToken?: string | null }): Promise<AccessGrant | null>;
  /** Fire and forget: progress is reported through events.onSigninState. */
  startSignIn(): void;
  /** Email and password through POST /api/auth/native/authorize. Same reporting as startSignIn. Local fallback page only. */
  signInWithPassword(credentials: PasswordCredentials): void;
  /** Asks the API to e-mail a one-time code (POST /api/auth/login/code): sending, then code_sent or error. */
  requestEmailCode(email: string, locale: SigninLocale): void;
  /** Checks the code (POST /api/auth/native/code/verify, PKCE) and signs in: verifying, then error or onSignedIn. */
  verifyEmailCode(email: string, code: string): void;
  /** Drops the attempt in progress (Google, password or code) and goes back to idle. */
  cancelSignIn(): void;
  /** The browser step is over (deep link or loopback hit): poll now instead of waiting. */
  nudge(): void;
  signOut(): void;
  dispose(): void;
};

export type AuthDeps = {
  config: DesktopConfig;
  redirectUri: string;
  startLoopback(): Promise<void>;
  stopLoopback(): void;
  events: AuthEvents;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API ${status} ${code}`);
    this.name = "ApiError";
  }
}

// User-facing failure: a code the page translates, and its French wording.
class SignInError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

function createPkce(): { codeVerifier: string; codeChallenge: string } {
  // 32 random bytes -> 43 base64url chars, the minimum the API accepts.
  const codeVerifier = base64url(randomBytes(32));
  return { codeVerifier, codeChallenge: base64url(createHash("sha256").update(codeVerifier).digest()) };
}

// The console's own wording for the same refusals (`login.failed.*` in
// ../../contracts/i18n), so both doors say the same thing.
const FAILURE_MESSAGES: Record<string, string> = {
  CREDENTIALS_INVALID: "Adresse ou mot de passe incorrect.",
  AUTH_CREDENTIALS_INVALID: "Adresse ou mot de passe incorrect.",
  VALIDATION_ERROR: "L’adresse e-mail et le mot de passe sont requis.",
  MEMBERSHIP_REQUIRED:
    "Ce compte est reconnu, mais il n’appartient à aucune organisation active : demandez une invitation à un administrateur.",
  AUTH_NOT_A_MEMBER: "Ce compte n’a pas encore d’organisation : créez-la depuis l’application web, puis reconnectez-vous.",
  AUTH_DENIED: "Connexion annulée dans Google.",
  AUTH_EMAIL_NOT_VERIFIED: "Google ne certifie pas cet e-mail : utilisez un compte dont l’adresse est vérifiée.",
  AUTH_EMAIL_NOT_ALLOWED:
    "Cette adresse n’est pas encore ouverte sur openedbot : inscrivez-vous à la liste d’attente, nous vous écrirons dès que votre accès sera validé.",
  AUTH_PROVIDER_DISABLED: "Le SSO Google est désactivé sur cet environnement.",
  RATE_LIMITED: "Trop de tentatives : patientez une minute.",
  EMAIL_LOGIN_CODE_INVALID: "Code invalide ou expiré. Demandez un nouveau code.",
  EMAIL_LOGIN_CODE_COOLDOWN: "Patientez une minute avant de demander un nouveau code.",
  EMAIL_LOGIN_CODE_UNSENT: "Le code n’a pas pu être envoyé. Réessayez.",
  REDIRECT_URI_INVALID: "Cette version de l’application n’est pas autorisée par le serveur.",
  AUTH_PASSWORD_DISABLED: "La connexion par mot de passe n’est pas ouverte sur cet environnement.",
};

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof SignInError) return { code: error.code, message: error.message };
  if (error instanceof ApiError) {
    const known = FAILURE_MESSAGES[error.code];
    return known
      ? { code: error.code, message: known }
      : { code: "UNKNOWN", message: "La connexion a échoué. Réessayez, et prévenez le support si cela se reproduit." };
  }
  return { code: "NETWORK", message: "La connexion a échoué. Vérifiez votre réseau puis réessayez." };
}

export function createAuthService(deps: AuthDeps): AuthService {
  const { config, redirectUri, events } = deps;

  let tokens: NativeTokens | null = null;
  let refreshInFlight: Promise<string | null> | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let attempt: AbortController | null = null;
  let wakePoll: (() => void) | null = null;

  async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    // net.fetch (not global fetch) so the OS proxy settings apply on managed Windows machines.
    const response = await net.fetch(`${config.apiOrigin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as { error?: { code?: unknown } } | null)?.error;
      throw new ApiError(response.status, typeof error?.code === "string" ? error.code : "API_ERROR");
    }
    return payload as T;
  }

  async function exchangeTokens(body: Record<string, string>, signal?: AbortSignal): Promise<NativeTokens> {
    const result = await postJson<unknown>("/api/auth/native/token", body, signal);
    if (!isNativeTokens(result)) throw new ApiError(502, "BAD_TOKEN_RESPONSE");
    return result;
  }

  function expiresInMs(value: NativeTokens): number {
    const expiresAt = Date.parse(value.accessTokenExpiresAt);
    // An unparseable date counts as already expired: refresh rather than trust it.
    return Number.isNaN(expiresAt) ? -1 : expiresAt - Date.now();
  }

  function scheduleRefresh(delayOverride?: number): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!tokens) return;
    const delay = delayOverride ?? Math.max(0, expiresInMs(tokens) - REFRESH_MARGIN_MS);
    refreshTimer = setTimeout(() => {
      refresh().catch((error: unknown) => {
        // Network trouble or a 5xx: the refresh token is still valid, try again later.
        log.warn(`proactive refresh failed, retrying (${error instanceof Error ? error.message : "error"})`);
        scheduleRefresh(TRANSIENT_REFRESH_RETRY_MS);
      });
    }, Math.min(delay, MAX_TIMER_MS));
    refreshTimer.unref();
  }

  function setTokens(next: NativeTokens): void {
    // Memory first: the rotated refresh token is the only valid one now, so
    // even if persisting fails the running session must use it.
    tokens = next;
    try {
      saveTokens(next);
    } catch (error) {
      log.error("could not persist tokens", error);
    }
    scheduleRefresh();
  }

  function dropSession(reason: "signed-out" | "session-lost"): void {
    tokens = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    clearTokens();
    events.onSignedOut(reason);
  }

  async function performRefresh(): Promise<string | null> {
    const used = tokens;
    if (!used) return null;
    try {
      const next = await exchangeTokens({ grantType: "refresh_token", refreshToken: used.refreshToken });
      // Signed out (or re-signed in) while the request was in flight: the
      // answer belongs to a dead session, do not resurrect it.
      if (tokens !== used) return tokens?.accessToken ?? null;
      setTokens(next);
      return next.accessToken;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (tokens === used) dropSession("session-lost");
        return null;
      }
      throw error;
    }
  }

  // One rotation at a time: the server revokes the old refresh token on use,
  // so two parallel refreshes would make the loser look like a lost session.
  function refresh(): Promise<string | null> {
    refreshInFlight ??= performRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function readAccessToken(): Promise<string | null> {
    if (!tokens) return null;
    if (expiresInMs(tokens) > REFRESH_MARGIN_MS) return tokens.accessToken;
    try {
      return await refresh();
    } catch (error) {
      // Transient failure: a token still inside its real lifetime beats an error.
      if (tokens && expiresInMs(tokens) > 0) return tokens.accessToken;
      throw error;
    }
  }

  const grant = (value: NativeTokens): AccessGrant => ({
    accessToken: value.accessToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    organizationId: value.organizationId,
  });

  async function readAccess({ force, servedToken }: { force: boolean; servedToken?: string | null }): Promise<AccessGrant | null> {
    if (!tokens) return null;
    if (!force) {
      const accessToken = await readAccessToken();
      return accessToken && tokens ? grant(tokens) : null;
    }
    const rotatedSince = servedToken != null && tokens.accessToken !== servedToken && expiresInMs(tokens) > REFRESH_MARGIN_MS;
    if (!rotatedSince) await refresh();
    return tokens ? grant(tokens) : null;
  }

  function assertAuthorizeUrl(raw: string): URL {
    const url = new URL(raw);
    const apiHost = new URL(config.apiOrigin).host;
    const consoleHosts = trustedConsoleOrigins(config.consoleUrl).map((origin) => new URL(origin).host);
    const allowedHosts = ["accounts.google.com", apiHost, ...consoleHosts];
    const secure = url.protocol === "https:" || (url.protocol === "http:" && url.origin === config.apiOrigin);
    if (!secure || !allowedHosts.includes(url.host)) {
      throw new SignInError("AUTHORIZE_URL_UNEXPECTED", "Le serveur a renvoyé une adresse de connexion inattendue.");
    }
    return url;
  }

  function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        wakePoll = null;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      signal.addEventListener("abort", finish, { once: true });
      wakePoll = finish;
    });
  }

  async function runSignIn(current: AbortController): Promise<void> {
    const { signal } = current;
    const { codeVerifier, codeChallenge } = createPkce();
    try {
      events.onSigninState({ status: "waiting" });
      await deps.startLoopback().catch(() => {
        throw new SignInError("LOOPBACK_BUSY", "Le port local 47813 est occupé : fermez l'application qui l'utilise puis réessayez.");
      });
      const started = await postJson<{ attemptId?: unknown; authorizeUrl?: unknown }>(
        "/api/auth/native/google/start",
        { codeChallenge, redirectUri, clientId: config.clientId },
        signal,
      );
      if (typeof started.attemptId !== "string" || typeof started.authorizeUrl !== "string") {
        throw new SignInError("BAD_RESPONSE", "Réponse inattendue du serveur de connexion.");
      }
      const authorizeUrl = assertAuthorizeUrl(started.authorizeUrl);
      await shell.openExternal(authorizeUrl.toString());

      const deadline = Date.now() + SIGNIN_TIMEOUT_MS;
      let failures = 0;
      while (!signal.aborted) {
        if (Date.now() >= deadline) throw new SignInError("TIMEOUT", "Délai dépassé : la connexion n'a pas abouti en 5 minutes.");
        await pause(POLL_INTERVAL_MS, signal);
        if (signal.aborted) return;
        let claim: { status?: unknown; code?: unknown; failureCode?: unknown };
        try {
          claim = await postJson("/api/auth/native/google/claim", {
            attemptId: started.attemptId,
            codeVerifier,
            redirectUri,
          }, signal);
          failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          // A 4xx will not heal by itself; network errors and 5xx get a few more tries.
          const fatal = error instanceof ApiError && error.status >= 400 && error.status < 500;
          if (fatal || ++failures > MAX_POLL_FAILURES) throw error;
          continue;
        }
        if (claim.status === "done" && typeof claim.code === "string") {
          const next = await exchangeTokens(
            { grantType: "authorization_code", code: claim.code, codeVerifier, redirectUri },
            signal,
          );
          setTokens(next);
          events.onSignedIn();
          return;
        }
        if (claim.status === "failed") {
          const known = typeof claim.code === "string" ? FAILURE_MESSAGES[claim.code] : undefined;
          throw known && typeof claim.code === "string"
            ? new SignInError(claim.code, known)
            : new SignInError("GOOGLE_REFUSED", "La connexion Google a été refusée ou a expiré. Réessayez.");
        }
        // "pending" and any unknown status are non-terminal: keep polling.
      }
    } catch (error) {
      if (signal.aborted) return;
      log.error("sign-in failed", error);
      events.onSigninState({ status: "error", ...failure(error) });
    } finally {
      if (attempt === current) {
        attempt = null;
        deps.stopLoopback();
      }
    }
  }

  // One attempt at a time: a pending Google tab must not land a second
  // session. The previous attempt is aborted before this one starts.
  function beginAttempt(run: (current: AbortController) => Promise<void>): void {
    cancelSignIn();
    const current = new AbortController();
    attempt = current;
    void run(current);
  }

  // The non-Google doors: report a failure unless the attempt was dropped.
  // ApiError messages carry the status and code only, never the body; nothing
  // here logs the e-mail, the password or the code.
  async function runAttempt(current: AbortController, label: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    try {
      await work(current.signal);
    } catch (error) {
      if (current.signal.aborted) return;
      log.error(`${label} failed`, error);
      events.onSigninState({ status: "error", ...failure(error) });
    } finally {
      if (attempt === current) attempt = null;
    }
  }

  // The PKCE authorization code an API door handed back, exchanged like the Google one.
  async function completeSignIn(code: unknown, codeVerifier: string, signal: AbortSignal): Promise<void> {
    if (typeof code !== "string") throw new SignInError("BAD_RESPONSE", "Réponse inattendue du serveur de connexion.");
    const next = await exchangeTokens({ grantType: "authorization_code", code, codeVerifier, redirectUri }, signal);
    if (signal.aborted) return;
    setTokens(next);
    events.onSignedIn();
  }

  // The API checks the password and e-mail code before handing back the PKCE
  // authorization code.
  function runPasswordSignIn(current: AbortController, credentials: PasswordCredentials): Promise<void> {
    return runAttempt(current, "password sign-in", async (signal) => {
      const { codeVerifier, codeChallenge } = createPkce();
      events.onSigninState({ status: "submitting" });
      const authorized = await postJson<{ status?: unknown; code?: unknown }>(
        "/api/auth/native/authorize",
        {
          email: credentials.email,
          password: credentials.password,
          emailCode: credentials.emailCode,
          codeChallenge,
          redirectUri,
          clientId: config.clientId,
        },
        signal,
      );
      if (authorized?.status === "code_required") {
        events.onSigninState({ status: "code_required" });
        return;
      }
      await completeSignIn(authorized?.code, codeVerifier, signal);
    });
  }

  // E-mail code, step one: the same request as the web /login, the code goes
  // to the inbox. Nothing comes back but the acknowledgement.
  function runEmailCodeRequest(current: AbortController, email: string, locale: SigninLocale): Promise<void> {
    return runAttempt(current, "e-mail code request", async (signal) => {
      events.onSigninState({ status: "sending" });
      await postJson<unknown>("/api/auth/login/code", { email, locale }, signal);
      if (signal.aborted) return;
      events.onSigninState({ status: "code_sent", email });
    });
  }

  // E-mail code, step two: the API checks the code and, instead of the web
  // cookie, hands back a PKCE authorization code for this verifier.
  function runEmailCodeVerify(current: AbortController, email: string, code: string): Promise<void> {
    return runAttempt(current, "e-mail code sign-in", async (signal) => {
      const { codeVerifier, codeChallenge } = createPkce();
      events.onSigninState({ status: "verifying" });
      const verified = await postJson<{ code?: unknown }>(
        "/api/auth/native/code/verify",
        { email, code, codeChallenge, redirectUri, clientId: config.clientId },
        signal,
      );
      await completeSignIn(verified?.code, codeVerifier, signal);
    });
  }

  function cancelSignIn(): void {
    attempt?.abort();
    attempt = null;
    deps.stopLoopback();
  }

  return {
    restore(): boolean {
      tokens = loadTokens();
      // An expired access token gets refreshed right away (delay 0).
      scheduleRefresh();
      return tokens !== null;
    },

    isSignedIn: () => tokens !== null,
    readAccessToken,
    refresh,
    readAccess,

    startSignIn(): void {
      // A second click restarts: the first browser tab may have been closed.
      cancelSignIn();
      const current = new AbortController();
      attempt = current;
      void runSignIn(current);
    },

    signInWithPassword(credentials: PasswordCredentials): void {
      beginAttempt((current) => runPasswordSignIn(current, credentials));
    },

    requestEmailCode(email: string, locale: SigninLocale): void {
      beginAttempt((current) => runEmailCodeRequest(current, email, locale));
    },

    verifyEmailCode(email: string, code: string): void {
      beginAttempt((current) => runEmailCodeVerify(current, email, code));
    },

    cancelSignIn(): void {
      cancelSignIn();
      events.onSigninState({ status: "idle" });
    },

    nudge: () => wakePoll?.(),

    signOut(): void {
      cancelSignIn();
      dropSession("signed-out");
    },

    dispose(): void {
      cancelSignIn();
      if (refreshTimer) clearTimeout(refreshTimer);
    },
  };

}
