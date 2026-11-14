/** One counter line: requests of one key since this process started. */
export type TrafficCounter = { key: string; count: number; totalMs: number; maxMs: number };

/**
 * Bounded counters by key. Keys come from route patterns and folded host
 * paths, so their number is small; past the bound, new keys fold into
 * `(other)` instead of growing without limit.
 */
export class TrafficCounters {
  readonly #counters = new Map<string, TrafficCounter>();
  constructor(readonly maxKeys = 400) {}

  record(key: string, durationMs: number): void {
    const target = this.#counters.has(key) || this.#counters.size < this.maxKeys ? key : "(other)";
    const counter = this.#counters.get(target) ?? { key: target, count: 0, totalMs: 0, maxMs: 0 };
    counter.count += 1;
    counter.totalMs += durationMs;
    counter.maxMs = Math.max(counter.maxMs, durationMs);
    this.#counters.set(target, counter);
  }

  snapshot(): TrafficCounter[] {
    return [...this.#counters.values()].map((counter) => ({ ...counter })).sort((a, b) => b.count - a.count);
  }
}

/**
 * Collections of the relay allowlist (`protocol/connector/src/relay-allowlist.ts`)
 * whose next segment is a name or an id: profile, run, session, OAuth
 * session, skill-hub operation, server, peer, file…
 */
const PARAMETER_AFTER: Record<string, string> = {
  p: ":profile", profiles: ":profile", runs: ":run", sessions: ":session", oauth: ":oauth",
  operations: ":operation", servers: ":name", catalog: ":name", providers: ":provider",
  peers: ":peer", restart: ":restart", files: ":file", skills: ":name", toolsets: ":name",
};
/** Fixed segments that follow one of those collections in the allowlist. */
const FIXED_AFTER_COLLECTION = new Set(["models", "hub", "callback", "install", "scan", "inspect", "search"]);

/**
 * A host path with its names and ids folded: profile slugs, run ids, OAuth
 * sessions and operation ids would make one counter per bot, run or
 * operation and exhaust the counter bound. The query string is dropped.
 * `/hermes-setup/profiles/atlas/approval-policy` → `/hermes-setup/profiles/:profile/approval-policy`.
 */
export function hostMetricPath(path: string): string {
  const segments = (path.split("?")[0] || "/").split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const parameter = PARAMETER_AFTER[segments[index - 1]!];
    const segment = segments[index]!;
    if (parameter && segment !== "" && !FIXED_AFTER_COLLECTION.has(segment) && !segment.startsWith(":")) {
      segments[index] = parameter;
    }
  }
  return segments.join("/") || "/";
}

/**
 * Requests sent to hosts over the sockets THIS process holds (the broker's
 * `onDispatch`), by method, folded path, status class and runtime. `status`
 * null: sent, but no response came (link failure, timeout).
 */
export class HostCallMetrics {
  readonly calls = new TrafficCounters();

  record(dispatch: { runtimeId: string; method: string; path: string; status: number | null; durationMs: number }): void {
    const statusClass = dispatch.status === null ? "failed" : `${Math.floor(dispatch.status / 100)}xx`;
    this.calls.record(`${dispatch.method} ${hostMetricPath(dispatch.path)} ${statusClass} ${dispatch.runtimeId}`, dispatch.durationMs);
  }

  snapshot(): TrafficCounter[] {
    return this.calls.snapshot();
  }
}
