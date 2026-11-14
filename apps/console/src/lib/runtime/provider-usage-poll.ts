import type { RuntimeProviderUsageDto } from "@openedbot/contracts-api";

/**
 * When the provider limits are read again. The API says until when its reading is fresh (`freshUntil`): the
 * console comes back then, not on a fixed 120 s that landed just after expiry
 * and turned every poll into a host probe plus a 2 s re-poll.
 */

/** While the API is probing (`loading`, or `stale` being renewed): quick, then bounded. */
export const PROVIDER_USAGE_PENDING_POLL_MS = 2_000;
/** Quick polls in a row before slowing down: 30 s of a probe bounded at 40 s by the client. */
export const PROVIDER_USAGE_PENDING_POLLS = 15;
/** After the quick budget, a probe still running is looked at this often. */
export const PROVIDER_USAGE_SLOW_PENDING_POLL_MS = 15_000;
/** Never earlier than this after a fresh reading, never later than the max. */
export const PROVIDER_USAGE_MIN_POLL_MS = 30_000;
export const PROVIDER_USAGE_MAX_POLL_MS = 10 * 60_000;
/** Spread so that tabs and users do not all come back on the same second. */
export const PROVIDER_USAGE_JITTER_MS = 5_000;
/** No usable `freshUntil` (absent, invalid): the former cadence. */
export const PROVIDER_USAGE_FALLBACK_POLL_MS = 120_000;
/** Failure or closed link: the API backs off 30 s itself; the link comes back on its own. */
export const PROVIDER_USAGE_RETRY_POLL_MS = 60_000;

export function isProviderUsagePending(data: RuntimeProviderUsageDto | undefined): boolean {
  return data?.status === "loading" || data?.status === "stale";
}

/** Milliseconds until `freshUntil`, or null when it is absent or unreadable. */
export function msUntilFresh(data: RuntimeProviderUsageDto | undefined, now: number): number | null {
  if (!data?.freshUntil) return null;
  const until = Date.parse(data.freshUntil);
  return Number.isFinite(until) ? until - now : null;
}

/**
 * `pendingPolls`: readings in a row that were still pending, this one included
 * (`countPendingPolls`). The jitter is bounded and only ever delays.
 */
export function providerUsagePollMs(
  data: RuntimeProviderUsageDto | undefined,
  pendingPolls: number,
  now: number,
  random: () => number = Math.random,
): number {
  if (!data) return PROVIDER_USAGE_FALLBACK_POLL_MS;
  if (isProviderUsagePending(data)) {
    return pendingPolls <= PROVIDER_USAGE_PENDING_POLLS ? PROVIDER_USAGE_PENDING_POLL_MS : PROVIDER_USAGE_SLOW_PENDING_POLL_MS;
  }
  if (data.status === "unsupported") return PROVIDER_USAGE_MAX_POLL_MS;
  if (data.status === "error" || data.status === "disconnected") return PROVIDER_USAGE_RETRY_POLL_MS;
  const untilFresh = msUntilFresh(data, now);
  if (untilFresh === null) return PROVIDER_USAGE_FALLBACK_POLL_MS;
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 1) * PROVIDER_USAGE_JITTER_MS);
  return Math.min(Math.max(untilFresh + jitter, PROVIDER_USAGE_MIN_POLL_MS), PROVIDER_USAGE_MAX_POLL_MS);
}

/**
 * `staleTime`: a reading stays fresh in the cache as long as the API says so
 * (focus and remount do not re-read it). TanStack measures `staleTime` from
 * `dataUpdatedAt`, so the span is counted from there, not from now: counted
 * from now, the elapsed time was subtracted twice (Codex review).
 */
export function providerUsageStaleMs(data: RuntimeProviderUsageDto | undefined, dataUpdatedAt: number): number {
  if (data?.status !== "ok") return 0;
  return Math.max(msUntilFresh(data, dataUpdatedAt) ?? 0, 0);
}

/**
 * Pending readings in a row. `refetchInterval` is evaluated more than once
 * per reading, so a reading is counted once, by its `dataUpdatedAt`.
 */
export function countPendingPolls(
  previous: { dataUpdatedAt: number; count: number },
  data: RuntimeProviderUsageDto | undefined,
  dataUpdatedAt: number,
): { dataUpdatedAt: number; count: number } {
  if (dataUpdatedAt === previous.dataUpdatedAt) return previous;
  return { dataUpdatedAt, count: isProviderUsagePending(data) ? previous.count + 1 : 0 };
}
