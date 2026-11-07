import { logEvent } from "./logger";

/**
 * Counts what the verifiers of the internal routes accept and refuse, per role
 * (ADR 0001, section 4.7, S1b). The cut-over from the single internal secret to
 * one secret per role moves on when these say so: no refusal at any phase, no
 * former bearer accepted from P3 on, no run key read through the previous
 * secret after P4. Never a bearer, a secret or a digest of one: the role, the
 * route and the outcome only.
 *
 * Each process counts its own: the API reports them in `/api/metrics`, the
 * gateway and the worker in their logs (`internal_auth.refused`, one line per
 * refusal, at most one per route every 10 s with the number suppressed;
 * `internal_auth.legacy_accepted` and `internal_auth.run_key_previous`, at most
 * one per minute and role with the running count).
 */

export type InternalAuthOutcome = "role" | "legacy" | "refused";
export type RunKeyOutcome = "role" | "legacy" | "previous" | "refused";

type Counts = Record<string, number>;

const REFUSAL_LOG_INTERVAL_MS = 10_000;
const ACCEPTANCE_LOG_INTERVAL_MS = 60_000;

export class InternalAuthMetrics {
  readonly #bearers: Counts = {};
  readonly #runKeys: Counts = {};
  readonly #lastLog = new Map<string, { at: number; suppressed: number }>();
  readonly #now: () => number;
  readonly #log: typeof logEvent;

  constructor(options: { now?: () => number; log?: typeof logEvent } = {}) {
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? logEvent;
  }

  recordBearer(role: string, outcome: InternalAuthOutcome, route: string): void {
    const key = `${role}.${outcome}`;
    this.#bearers[key] = (this.#bearers[key] ?? 0) + 1;
    if (outcome === "refused") {
      this.#throttled(`refused:${role}:${route}`, REFUSAL_LOG_INTERVAL_MS, (suppressed) =>
        this.#log("internal_auth.refused", { role, route, suppressed }, "warn"));
    } else if (outcome === "legacy") {
      this.#throttled(`legacy:${role}`, ACCEPTANCE_LOG_INTERVAL_MS, () =>
        this.#log("internal_auth.legacy_accepted", { role, route, total: this.#bearers[key] }, "info"));
    }
  }

  recordRunKey(label: string, outcome: RunKeyOutcome): void {
    const key = `${label}.${outcome}`;
    this.#runKeys[key] = (this.#runKeys[key] ?? 0) + 1;
    if (outcome === "refused") {
      this.#throttled(`run_key_refused:${label}`, REFUSAL_LOG_INTERVAL_MS, (suppressed) =>
        this.#log("internal_auth.run_key_refused", { label, suppressed }, "warn"));
    } else if (outcome === "legacy" || outcome === "previous") {
      this.#throttled(`run_key_${outcome}:${label}`, ACCEPTANCE_LOG_INTERVAL_MS, () =>
        this.#log(`internal_auth.run_key_${outcome}`, { label, total: this.#runKeys[key] }, "info"));
    }
  }

  snapshot(): { bearers: Counts; runKeys: Counts } {
    return { bearers: { ...this.#bearers }, runKeys: { ...this.#runKeys } };
  }

  #throttled(key: string, interval: number, write: (suppressed: number) => void): void {
    const now = this.#now();
    const last = this.#lastLog.get(key);
    if (last && now - last.at < interval) {
      last.suppressed += 1;
      return;
    }
    write(last?.suppressed ?? 0);
    this.#lastLog.set(key, { at: now, suppressed: 0 });
  }
}

/** The process's counters. */
export const internalAuthMetrics = new InternalAuthMetrics();
