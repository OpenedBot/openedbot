import { useSyncExternalStore } from "react";
import { providerLabel } from "../components/provider-icon";

/**
 * A run whose provider refused the bot's login (expired or revoked OAuth,
 * dead key). The worker never re-routes it to another provider: the
 * `run.error` payload names `provider`, the one to reconnect.
 *
 * Same value as `PROVIDER_AUTH_REQUIRED_CODE` of `@openedbot/contracts-errors`,
 * a dev dependency only here, like `MODEL_UNAVAILABLE`: a test pins the
 * equality.
 */
export const PROVIDER_AUTH_REQUIRED = "PROVIDER_AUTH_REQUIRED";

export function isProviderAuthRequiredCode(code: unknown): boolean {
  return code === PROVIDER_AUTH_REQUIRED;
}

type RunEventLike = { runId: string; type: string; payload: Readonly<Record<string, unknown>> };

/**
 * The provider a failed run's `run.error` event names, for the toast and the
 * composer banner: `RunDto` carries no provider. `null` while that event has
 * not arrived (the run status can land first) or names none.
 */
export function runProviderAuthSlug(events: readonly RunEventLike[] | undefined, runId: string): string | null {
  let slug: string | null = null;
  for (const event of events ?? []) {
    if (event.runId === runId && event.type === "run.error") slug = providerAuthRequiredSlug(event.payload) ?? slug;
  }
  return slug;
}

/** {@link runProviderAuthSlug} as the provider's readable name. */
export function runProviderAuthLabel(events: readonly RunEventLike[] | undefined, runId: string): string | null {
  const slug = runProviderAuthSlug(events, runId);
  return slug ? providerLabel(slug) : null;
}

/** The provider slug a `PROVIDER_AUTH_REQUIRED` run error names, if any. */
export function providerAuthRequiredSlug(payload: Readonly<Record<string, unknown>>): string | null {
  const provider = payload.provider;
  return typeof provider === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider) ? provider : null;
}

/**
 * "Reconnect <provider>" from a failed turn: Models opens that provider's
 * connection dialog, not only the screen. The request lives in memory, not in
 * the URL, because the desktop shell opens Models as an overlay with a masked
 * path (`settings-overlay.ts`).
 *
 * Models takes the request once its catalogue is read and clears it on
 * close, on connect, or when the catalogue does not list that provider. A
 * request is only honoured for {@link PROVIDER_RECONNECT_TTL_MS}: Settings
 * closed before the catalogue loaded must not pop the dialog on a much later
 * visit.
 */
export type ProviderReconnectRequest = {
  provider: string;
  at: number;
  /**
   * Its dialog is open: the TTL only keeps a stale request from opening one
   * later, it never closes a login the operator is in the middle of.
   */
  opened?: boolean;
};

export const PROVIDER_RECONNECT_TTL_MS = 120_000;

let reconnectRequest: ProviderReconnectRequest | null = null;
const reconnectListeners = new Set<() => void>();

function notifyReconnect(): void {
  for (const listener of reconnectListeners) listener();
}

export function requestProviderReconnect(provider: string, now = Date.now()): void {
  reconnectRequest = { provider, at: now };
  notifyReconnect();
}

export function clearProviderReconnect(): void {
  if (!reconnectRequest) return;
  reconnectRequest = null;
  notifyReconnect();
}

/** The request's dialog opened: it now lasts until closed or connected. */
export function holdProviderReconnect(): void {
  if (!reconnectRequest || reconnectRequest.opened) return;
  reconnectRequest = { ...reconnectRequest, opened: true };
  notifyReconnect();
}

/**
 * Its dialog went away without closing or connecting (the screen unmounted):
 * the TTL from the original click governs again, so a much later visit does
 * not reopen an abandoned login.
 */
export function releaseProviderReconnect(): void {
  if (!reconnectRequest?.opened) return;
  reconnectRequest = { provider: reconnectRequest.provider, at: reconnectRequest.at };
  notifyReconnect();
}

/** The pending request, whatever its age; see {@link freshProviderReconnect}. */
export function useProviderReconnectRequest(): ProviderReconnectRequest | null {
  return useSyncExternalStore(
    (listener) => {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    () => reconnectRequest,
    () => reconnectRequest,
  );
}

/** The requested provider slug while the request is fresh or its dialog open, else `null`. */
export function freshProviderReconnect(request: ProviderReconnectRequest | null, now = Date.now()): string | null {
  return request && (request.opened === true || now - request.at <= PROVIDER_RECONNECT_TTL_MS) ? request.provider : null;
}
