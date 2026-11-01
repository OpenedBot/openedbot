import type { RunDto } from "@openedbot/contracts-api";

/** Who actually answered the bot's last turn, when the worker re-routed it. */
export type RunFallbackServed = {
  runId: string;
  /** Provider the run left (`run.provider_fallback.from`), when known. */
  from: string | null;
  provider: string;
  model: string;
};

type FallbackEvent = { runId: string; type: string; payload: Record<string, unknown> };
type RunLike = Pick<RunDto, "id" | "createdAt" | "status"> & Partial<Pick<RunDto, "botId">>;

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * The provider and model that served the bot's LATEST turn, when that turn
 * was moved off the configured provider (`run.provider_fallback`, the last
 * one of the run: a fallback can try a second model). `null` when the latest
 * turn ran where it was told to, or has not reached a fallback (yet).
 *
 * Only a COMPLETED turn was served. The worker writes `run.provider_fallback`
 * before it retries on the fallback provider, so the event alone is an
 * attempt: while that turn still runs, or once it failed or was cancelled,
 * nothing answered from the fallback and the header must not say so.
 *
 * Only the latest turn counts: an older fallback says nothing about where
 * the next turn goes, and the header must not keep a stale warning once a
 * turn runs on the configured model again. The bot's setting is never read
 * or written here.
 */
export function latestRunFallback(
  runs: readonly RunLike[],
  events: readonly FallbackEvent[],
  botId: string,
): RunFallbackServed | null {
  let latest: RunLike | null = null;
  for (const run of runs) {
    if (run.botId && run.botId !== botId) continue;
    if (!latest || Date.parse(run.createdAt) >= Date.parse(latest.createdAt)) latest = run;
  }
  if (!latest || latest.status !== "completed") return null;
  let served: RunFallbackServed | null = null;
  for (const event of events) {
    if (event.runId !== latest.id || event.type !== "run.provider_fallback") continue;
    const provider = text(event.payload.to);
    const model = text(event.payload.model);
    if (provider && model) served = { runId: latest.id, from: text(event.payload.from), provider, model };
  }
  return served;
}

export function sameRunFallback(previous: RunFallbackServed | null, next: RunFallbackServed | null): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return previous.runId === next.runId && previous.from === next.from
    && previous.provider === next.provider && previous.model === next.model;
}
