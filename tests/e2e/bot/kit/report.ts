/**
 * The run report: what each scenario proved, step by step, what each bench
 * measured, and how every created bot was cleaned up. Serialised as JSON and
 * rendered to a self-contained HTML page (html.ts).
 */
import { latencyStats } from "./fast-path-measurements";
import type { PurgeOutcome } from "./bots";

export type StepStatus = "pass" | "fail" | "skip" | "warn";
export type Detail = Record<string, string | number | boolean | null>;

export type Step = { name: string; status: StepStatus; ms: number; detail: Detail; note: string | null };

export type SampleColumn = { key: string; label: string };
export type SampleRow = Record<string, number | string | null>;
export type StatRow = { key: string; label: string; n: number; missing: number; p50: number | null; p95: number | null; max: number | null };
/** Ordered marks drawn as one timeline bar per sample (ms from the sample's t0). */
export type Timeline = { keys: Array<{ key: string; label: string }> };

export type Bench = { columns: SampleColumn[]; rows: SampleRow[]; stats: StatRow[]; timeline: Timeline | null };

export type ScenarioResult = {
  id: string;
  title: string;
  summary: string;
  status: StepStatus;
  ms: number;
  steps: Step[];
  bench: Bench | null;
  error: string | null;
};

export type RunReport = {
  label: string;
  startedAt: string;
  finishedAt: string | null;
  status: StepStatus;
  apiUrl: string;
  gitSha: string | null;
  runtime: { id: string; name: string; features: string[]; hermesVersion?: string | null; connectorVersion?: string | null } | null;
  model: { provider: string; model: string; reasoningEffort: string | null } | null;
  options: Record<string, string | number | boolean>;
  scenarios: ScenarioResult[];
  cleanup: PurgeOutcome[];
  error: string | null;
};

/** Thrown inside a step to record it as skipped, with the reason. */
export class Skip extends Error {}
/** Returned by a step that passed with a reservation (a model that ignored a format, say). */
export class Warning {
  constructor(readonly note: string, readonly detail: Detail = {}) {}
}
export const warn = (note: string, detail: Detail = {}) => new Warning(note, detail);
export type StepOutcome = Detail | Warning | void;

export class ScenarioRecorder {
  readonly steps: Step[] = [];
  bench: Bench | null = null;
  constructor(private readonly strict = false, private readonly onStep?: (step: Step) => void) {}

  /** Runs one step; a throw records `fail` and aborts the scenario. */
  async step(name: string, body: () => Promise<StepOutcome>): Promise<void> {
    const started = performance.now();
    const push = (status: StepStatus, detail: Detail, note: string | null) => {
      const step = { name, status, ms: Math.round(performance.now() - started), detail, note };
      this.steps.push(step);
      this.onStep?.(step);
    };
    try {
      const outcome = await body();
      if (outcome instanceof Warning) {
        push(this.strict ? "fail" : "warn", outcome.detail, outcome.note);
        if (this.strict) throw new StepFailed(name);
      }
      else push("pass", outcome ?? {}, null);
    } catch (error) {
      if (error instanceof StepFailed) throw error;
      if (error instanceof Skip && !this.strict) { push("skip", {}, error.message); return; }
      push("fail", {}, error instanceof Error ? error.message : String(error));
      throw new StepFailed(name);
    }
  }

  setBench(columns: SampleColumn[], rows: SampleRow[], statKeys: string[], timeline: Timeline | null = null): void {
    const stats = statKeys.map((key) => {
      const column = columns.find((entry) => entry.key === key);
      const values = rows.map((row) => (typeof row[key] === "number" ? (row[key] as number) : null));
      const { n, missing, p50, p95, max } = latencyStats(values);
      return { key, label: column?.label ?? key, n, missing, p50, p95, max };
    });
    this.bench = { columns, rows, stats, timeline };
  }
}

export class StepFailed extends Error {}

export function worst(statuses: StepStatus[]): StepStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (!statuses.length || statuses.includes("skip")) return "skip";
  return "pass";
}

/** `ms` from a sample's t0, or null when the mark is missing. */
export const since = (t0: number, at: number | Date | null | undefined): number | null =>
  at === null || at === undefined ? null : Math.round((at instanceof Date ? at.getTime() : at) - t0);
