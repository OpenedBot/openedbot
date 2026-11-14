import type { RuntimePublicDto } from "@openedbot/contracts-api";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "@openedbot/browser-i18n";
import { ApiError, isApiUnavailable, isUnauthorized } from "../api";

/** Transient host failures share the offline notice and its automatic retry. */
export function isRuntimeUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "RUNTIME_LINK_UNAVAILABLE" || error.code === "HERMES_UNREACHABLE");
}

const LABEL_KEY: Record<RuntimeHealthStatus, MessageKey> = {
  healthy: "runtimeHealth.healthy",
  unreachable: "runtimeHealth.unreachable",
  unauthorized: "runtimeHealth.unauthorized",
  missing_feature: "runtimeHealth.missingFeature",
  // Reachable and authenticated, and yet no bot will answer. Calling it
  // « prêt » here would be the same lie as the « Tester » button.
  no_provider: "runtimeHealth.noProvider",
  // Runtime joined by the connector whose host has not opened its link.
  disconnected: "runtimeHealth.disconnected",
  unknown: "runtimeHealth.unknown",
};

/**
 * The status alone, without the runtime around it.
 *
 * A caller that already holds a status (a readiness verdict, a log
 * line) does not have to build a fake `RuntimePublicDto` to get its
 * label. Same table as `runtimeHealthLabel`: two places that show the
 * same state cannot name it differently.
 */
export function runtimeHealthStatusLabel(
  status: RuntimeHealthStatus,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return t(locale, LABEL_KEY[status]);
}

/**
 * Rework-flux-api step 5d: the read is past the horizon the API gave it
 * (`link.validUntil`). Within it, a link that died would have been pushed
 * (`runtime.changed`); past it, nothing says the link still holds.
 */
export function runtimeVerdictExpired(runtime: RuntimePublicDto | null | undefined, now = Date.now()): boolean {
  const until = runtime?.link?.validUntil;
  if (!until) return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && at <= now;
}

/** Verdicts the database holds on its own: an expired read keeps them, it does not turn them into « inconnu ». */
const KNOWN_FAILURES = new Set<RuntimeHealthStatus>(["unauthorized", "unreachable", "missing_feature", "no_provider"]);

/**
 * The state to display, not only `lastHealthStatus`.
 *
 * On a `connector` runtime, the open socket (`link.connected`) is the
 * freshest fact of the same DTO: the broker sets `disconnected` at the same
 * time as it closes the link, but an older probe status must
 * not display « prêt » on a host that is no longer there.
 *
 * The reverse too: a `disconnected` in the database while `link.connected`
 * is true is a stale liveness (enrollment bye, a sweep before
 * the next hello). The open link wins, otherwise the Runtime screen stays down
 * until « Vérifier le lien ».
 */
export function displayedRuntimeHealth(
  runtime: RuntimePublicDto | null | undefined,
  error?: unknown,
  now = Date.now(),
): RuntimeHealthStatus | "not_configured" {
  if (isApiUnavailable(error)) return "unreachable";
  // A 401 here is not about the Hermes runtime but the cloud API itself: the
  // window has no identity with it (or no longer does). The router sends it back
  // to the « Se connecter » step; here, say so rather than send
  // the user to a form that cannot help.
  if (isUnauthorized(error)) return "unauthorized";
  if (!runtime?.configured) return "not_configured";
  if (runtime.reachability === "connector" && runtime.link) {
    // `live` (5d): open AND alive, owner included; an older API only says `connected`.
    if (!(runtime.link.live ?? runtime.link.connected)) return "disconnected";
    // An expired read is unknown, never « prêt »; a known failure stays what it is.
    if (runtimeVerdictExpired(runtime, now)) {
      return KNOWN_FAILURES.has(runtime.lastHealthStatus) ? runtime.lastHealthStatus : "unknown";
    }
    if (runtime.lastHealthStatus === "disconnected" || runtime.lastHealthStatus === "unknown") {
      return "healthy";
    }
  }
  return runtime.lastHealthStatus;
}

/**
 * A conversation may remain readable while its runtime is down, but it must
 * not offer a composer that can only fail. During the initial runtime query,
 * keep the decision pending so the screen does not flash an error before the
 * health response arrives.
 */
export function runtimeBlocksConversation(
  runtime: RuntimePublicDto | null | undefined,
  querySettled: boolean,
): boolean {
  if (!querySettled) return false;
  const status = displayedRuntimeHealth(runtime);
  return !runtime || status !== "healthy" && status !== "unknown";
}

/**
 * The runtime state in one line, as it is shown everywhere in the app.
 *
 * Shared between the sidebar footer and the help page: two places
 * that show the same state must not be able to name it differently.
 *
 * The error counts as much as the data. Without it, an unavailable cloud API
 * with its retries exhausted read as « runtime à configurer », because the
 * request fails and `undefined` looks like « pas encore configuré ». The
 * message then sent the user to fill in a form that was already filled, in
 * an application where no API answers anymore.
 *
 * `locale` defaults to `DEFAULT_LOCALE` (no required parameter): callers
 * that do not yet have an i18n context (none today, but the
 * signature stays backward compatible) keep receiving French.
 */
export function runtimeHealthLabel(
  runtime: RuntimePublicDto | null | undefined,
  error?: unknown,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const status = displayedRuntimeHealth(runtime, error);
  if (status === "not_configured") return t(locale, "runtimeHealth.notConfigured");
  return t(locale, LABEL_KEY[status]);
}
