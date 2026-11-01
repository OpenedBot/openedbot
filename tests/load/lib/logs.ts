/**
 * What the API and worker logs say about the same run, read after the soak:
 * the access log (one JSON line per request: route, status, durationMs), the
 * `run.admission` line of the API and the `run.latency` line of the worker
 * (OHB-107 marks, OHB-133 spans), and the worker's queue wake-up mode (OHB-139).
 * Nothing here needs the processes alive: the files are enough.
 */
import { summarize, round, type Summary } from "./stats";

type JsonLine = Record<string, unknown>;

export type RouteSummary = { route: string; count: number; perSecond: number; errors: number; durationMs: Summary };

export type HttpSummary = { routes: RouteSummary[]; requests: number; errors: number; windowSeconds: number };

export type RunLatencySummary = {
  runs: number;
  queuedMs: Summary;
  firstRuntimeEventMs: Summary;
  firstVisibleTextMs: Summary;
  terminalMs: Summary;
  spans: Record<string, Summary>;
  verdictFailures: Record<string, number>;
  eventReplay: number;
};

export type RunAdmissionSummary = { runs: number; committedMs: Summary; failures: number };

export async function readJsonLines(path: string): Promise<JsonLine[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const lines: JsonLine[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      lines.push(JSON.parse(line) as JsonLine);
    } catch {
      // A truncated last line (process stopped mid-write) is not evidence.
    }
  }
  return lines;
}

/** Access-log lines of the API between two instants, grouped by route. */
export function summarizeHttp(lines: JsonLine[], window: { fromMs: number; toMs: number }): HttpSummary {
  const byRoute = new Map<string, { durations: number[]; errors: number }>();
  let requests = 0;
  let errors = 0;
  for (const line of lines) {
    if (line.channel !== "http" || typeof line.route !== "string") continue;
    const time = Number(line.time);
    if (!(time >= window.fromMs && time <= window.toMs)) continue;
    const entry = byRoute.get(line.route) ?? { durations: [], errors: 0 };
    entry.durations.push(Number(line.durationMs ?? 0));
    if (Number(line.status) >= 500) { entry.errors += 1; errors += 1; }
    byRoute.set(line.route, entry);
    requests += 1;
  }
  const windowSeconds = Math.max(1, (window.toMs - window.fromMs) / 1_000);
  const routes = [...byRoute.entries()]
    .map(([route, entry]) => ({
      route,
      count: entry.durations.length,
      perSecond: round(entry.durations.length / windowSeconds),
      errors: entry.errors,
      durationMs: summarize(entry.durations),
    }))
    .sort((a, b) => b.count - a.count);
  return { routes, requests, errors, windowSeconds: round(windowSeconds) };
}

/** The worker's `run.latency` lines: budgets counted from the run's creation. */
export function summarizeRunLatency(lines: JsonLine[], runIds: ReadonlySet<string>): RunLatencySummary {
  const queued: number[] = [];
  const firstEvent: number[] = [];
  const firstText: number[] = [];
  const terminal: number[] = [];
  const spans = new Map<string, number[]>();
  const verdictFailures: Record<string, number> = {};
  let eventReplay = 0;
  let runs = 0;
  for (const line of lines) {
    if (line.event !== "run.latency" || typeof line.runId !== "string" || !runIds.has(line.runId)) continue;
    runs += 1;
    const queuedMs = Number(line.queuedMs);
    const marks = (line.marks ?? {}) as Record<string, number>;
    if (Number.isFinite(queuedMs)) {
      queued.push(queuedMs);
      if (typeof marks["hermes.first_event"] === "number") firstEvent.push(queuedMs + marks["hermes.first_event"]);
      if (typeof marks["ohb.first_text_published"] === "number") firstText.push(queuedMs + marks["ohb.first_text_published"]);
      if (typeof marks["ohb.terminal_published"] === "number") terminal.push(queuedMs + marks["ohb.terminal_published"]);
    }
    for (const [name, value] of Object.entries((line.spans ?? {}) as Record<string, number>)) {
      const entry = spans.get(name) ?? [];
      entry.push(value);
      spans.set(name, entry);
    }
    for (const [stage, verdict] of Object.entries((line.verdicts ?? {}) as Record<string, { pass?: boolean }>)) {
      if (verdict?.pass === false) verdictFailures[stage] = (verdictFailures[stage] ?? 0) + 1;
    }
    if ((line.attributes as Record<string, unknown> | undefined)?.event_replay === true) eventReplay += 1;
  }
  return {
    runs,
    queuedMs: summarize(queued),
    firstRuntimeEventMs: summarize(firstEvent),
    firstVisibleTextMs: summarize(firstText),
    terminalMs: summarize(terminal),
    spans: Object.fromEntries([...spans.entries()].map(([name, values]) => [name, summarize(values)])),
    verdictFailures,
    eventReplay,
  };
}

/** The API's `run.admission` lines: `api.committed` is the local 202 cost. */
export function summarizeRunAdmission(lines: JsonLine[], runIds: ReadonlySet<string>): RunAdmissionSummary {
  const committed: number[] = [];
  let failures = 0;
  for (const line of lines) {
    if (line.event !== "run.admission" || typeof line.runId !== "string" || !runIds.has(line.runId)) continue;
    const marks = (line.marks ?? {}) as Record<string, number>;
    if (typeof marks["api.committed"] === "number") committed.push(marks["api.committed"]);
    const verdict = (line.verdicts as Record<string, { pass?: boolean }> | undefined)?.admission;
    if (verdict?.pass === false) failures += 1;
  }
  return { runs: committed.length, committedMs: summarize(committed), failures };
}

/** How each worker woke its claim loop: LISTEN/NOTIFY, the 25 ms probe, or neither. */
export function queueWakeMode(lines: JsonLine[]): "listen" | "probe" | "unknown" {
  let ready = false;
  let unsupported = false;
  for (const line of lines) {
    if (line.event === "worker.queue_listener_ready") ready = true;
    if (line.event === "worker.queue_listener_unsupported" || line.event === "worker.queue_listener_failed") unsupported = true;
  }
  if (ready) return "listen";
  if (unsupported) return "probe";
  return "unknown";
}
