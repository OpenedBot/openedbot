import type { useQueryClient } from "@tanstack/react-query";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import { queryKeys } from "../../../../lib/api";
import type { MessageKey } from "../../../../lib/i18n";

/**
 * The runtime screen's sections. They live in the URL (`?section=`) when
 * the route carries them, and in local state when the screen is mounted in a
 * dialog or a test: the component does not know the router.
 */
export type RuntimeSection = "status" | "alerts" | "runtimes";
const RUNTIME_SECTIONS: readonly RuntimeSection[] = ["status", "alerts", "runtimes"];
export function isRuntimeSection(value: unknown): value is RuntimeSection {
  return typeof value === "string" && (RUNTIME_SECTIONS as readonly string[]).includes(value);
}

/** The label of each health state: a single vocabulary, hero and register. */
export const HEALTH_LABEL: Record<RuntimeHealthStatus, MessageKey> = {
  healthy: "runtimeHealth.healthy",
  unreachable: "runtimeHealth.unreachable",
  unauthorized: "runtimeHealth.unauthorized",
  missing_feature: "runtimeHealth.missingFeature",
  no_provider: "runtimeHealth.noProvider",
  disconnected: "runtimeHealth.disconnected",
  unknown: "runtimeHealth.unknown",
};

/** The runtime's reread cadence lives with the runtime reads (`lib/runtime/runtime-cadence.ts`). */
export { RUNTIME_DISCONNECTED_REFETCH_MS, RUNTIME_REFETCH_MS, runtimeRefetchMs } from "../../../../lib/runtime/runtime-cadence";

/** Everything the registry, the mode, and the active runtime's card read. */
export async function invalidateRuntimeQueries(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimes }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeList }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtime }),
  ]);
}
