import { api, queryKeys } from "../api";
import { queryClient } from "../query-client";

/**
 * Connectors reads two routes whose "cold" read starts an
 * interpreter on the runtime host (measured on 02-11-2026: 2.6 s for
 * the inventory, 1.9 s for MCP, against under 10 ms once the server
 * snapshot is in place). The screen only started them on mount: a skeleton
 * for the whole read.
 *
 * Starting them as soon as settings are entered (`SettingsFrame`) leaves the travel time up to
 * the section. A failure (non-operator, host offline) is swallowed here: it is
 * the screen that, on rereading them, will show the error.
 */
export function prefetchConnectors(): void {
  void queryClient.prefetchQuery({ queryKey: queryKeys.runtimeIntegrations, queryFn: () => api.runtimeIntegrations() });
  void queryClient.prefetchQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcp });
}
