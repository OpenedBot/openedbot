import { useEffect, useReducer } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuntimePublicDto, RuntimeHealthStatus } from "@openedbot/contracts-api";
import { queryKeys, runtimeQueryOptions } from "../api";
import { displayedRuntimeHealth } from "./runtime-health";
import { runtimeRefetchMs } from "./runtime-cadence";


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
    // Same cadence as the Runtime screen: a minute while the link lives (the
    // change itself arrives on the stream), brisk while it is closed.
    refetchInterval: (query) => runtimeRefetchMs(query.state.data),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  useRuntimeVerdictExpiry(runtime.data?.link?.validUntil);
  return {
    runtime: runtime.data,
    error: runtime.error,
    status: displayedRuntimeHealth(runtime.data, runtime.error),
    pending: runtime.isPending && !runtime.data && !runtime.error,
  };
}

/**
 * Rework-flux-api step 5d: when the read reaches its `validUntil`, reread it
 * and render again, so the badge says « inconnu » rather than keep a verdict
 * nothing confirms. Several observers schedule it; they share one read.
 */
export function useRuntimeVerdictExpiry(validUntil: string | null | undefined): void {
  const queryClient = useQueryClient();
  const [, expire] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    if (!validUntil) return;
    const at = Date.parse(validUntil);
    if (!Number.isFinite(at)) return;
    const timer = setTimeout(() => {
      expire();
      // Every observer's timer fires at the same instant: join the read in
      // flight instead of cancelling and restarting it (Codex review).
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration }, { cancelRefetch: false });
    }, Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [validUntil, queryClient]);
}
