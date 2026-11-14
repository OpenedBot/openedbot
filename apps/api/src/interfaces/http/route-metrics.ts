import { hostMetricPath } from "@openedbot/runtime-link/application/host-call-metrics";
import { RUNTIME_LINK_INTERNAL_PREFIX } from "@openedbot/runtime-link/application/instances";

export { hostMetricPath };

const RELAY_PATH = new RegExp(`^${RUNTIME_LINK_INTERNAL_PREFIX}/([^/]+)/proxy(/.*)?$`);

/** A relay route's runtime and folded host path (log analysis of `/internal/runtime-links/:id/proxy/*`). */
export function relayMetricPath(path: string): { runtimeId: string; path: string } | null {
  const match = RELAY_PATH.exec(path);
  if (!match) return null;
  return { runtimeId: match[1]!, path: hostMetricPath(match[2] ?? "/") };
}
