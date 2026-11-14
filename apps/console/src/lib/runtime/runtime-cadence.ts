import type { RuntimeConfigurationDto } from "@openedbot/contracts-api";

/**
 * How often the console rereads `GET /api/runtime` (rework-flux-api step 5e).
 *
 * A connector link opens and closes WITHOUT the operator touching anything:
 * the host restarts, a tunnel drops, `make link-dev-up` reopens it. The
 * change now arrives on the organization stream (`runtime.changed`, pushed by
 * every API replica from the 0178 triggers), a (re)opened stream rereads the
 * runtime, and a read past its `validUntil` is reread (5d). The periodic read
 * is a safety net: a minute.
 */
export const RUNTIME_REFETCH_MS = 60_000;
/**
 * Link closed, or a pairing that has not opened it yet: brisk enough to see
 * `make link-dev-up` reopen the link, without a reread per second through a
 * whole outage that lasts.
 */
export const RUNTIME_DISCONNECTED_REFETCH_MS = 3_000;

/** The cadence for a read of `GET /api/runtime`: brisk while a connector link is not alive. */
export function runtimeRefetchMs(configuration: RuntimeConfigurationDto | undefined): number {
  const runtime = configuration?.runtime;
  if (runtime?.reachability !== "connector" || !runtime.link) return RUNTIME_REFETCH_MS;
  return (runtime.link.live ?? runtime.link.connected) ? RUNTIME_REFETCH_MS : RUNTIME_DISCONNECTED_REFETCH_MS;
}
