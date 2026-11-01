import { useQuery } from "@tanstack/react-query";
import type { RuntimePublicDto, RuntimeHealthStatus } from "@openedbot/contracts-api";
import { runtimeQueryOptions } from "./api";
import { displayedRuntimeHealth } from "./runtime-health";

/**
 * Same cadence as the Runtime screen (`RUNTIME_REFETCH_MS`): the link opens
 * and closes without any operator gesture. `/api/events` does not carry the
 * runtime health (run events only).
 */
export const RUNTIME_HEALTH_REFETCH_MS = 5_000;

export type RuntimeHealthReading = {
  runtime: RuntimePublicDto | null | undefined;
  error: unknown;
  status: RuntimeHealthStatus | "not_configured";
  /** First read still in flight: callers show a neutral state, never KO. */
  pending: boolean;
};

/**
 * The organization's runtime health, as every chrome surface shows it (top bar
 * badge on a thread, icon rail). One `GET /api/runtime` cache entry
 * (`runtimeQueryOptions`) shared with the conversation and the Runtime screen:
 * several observers of the same key poll once, at the shortest interval.
 */
export function useRuntimeHealth(): RuntimeHealthReading {
  const runtime = useQuery({
    ...runtimeQueryOptions(),
    refetchInterval: RUNTIME_HEALTH_REFETCH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  return {
    runtime: runtime.data,
    error: runtime.error,
    status: displayedRuntimeHealth(runtime.data, runtime.error),
    pending: runtime.isPending && !runtime.data && !runtime.error,
  };
}
