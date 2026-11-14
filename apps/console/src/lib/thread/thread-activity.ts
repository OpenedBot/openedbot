import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import { readAttachment, readToolOutcome, runToolTerminalStates, toolCallKey } from "@openedbot/conversation/domain/thread-tools";
import { HANDOFF_NOTICE_KIND, handoffNoticeTarget } from "@openedbot/roster/domain/bot-mode";
import { isExecutingThreadRun, isWaitingThreadRun } from "./current-thread-run";
import { runClockStart } from "../run/run-timing";

export type ActivityToolState = "running" | "completed" | "failed" | "interrupted" | "result_missing";

export type ActivityTool = {
  key: string;
  tool: string;
  preview: string | null;
  result: string | null;
  truncated: boolean;
  state: ActivityToolState;
  /** `tool.result.errorMessage`: the why of the failure, `null` until the runtime transmits one. */
  errorMessage: string | null;
};

export type RunActivity = { run: RunDto; tools: ActivityTool[]; approvals: ApprovalRequestDto[] };

/** Cautious projection of the log: the absence of `tool.result` is never turned into a success. */
export function buildThreadActivity(
  runs: readonly RunDto[],
  events: readonly StoredProductEvent[],
  approvals: readonly ApprovalRequestDto[],
): RunActivity[] {
  const outcomes = new Map(
    events.filter((event) => event.type === "tool.result")
      .map((event) => [toolCallKey(event), readToolOutcome(event.payload)] as const),
  );
  const attachments = new Map<string, ReturnType<typeof readAttachment>>();
  for (const event of events) {
    if (event.type === "tool.result.attached") attachments.set(toolCallKey(event), readAttachment(event.payload));
  }
  const terminalStates = runToolTerminalStates(events);

  return runs.map((run) => ({
    run,
    approvals: approvals.filter((approval) => approval.runId === run.id),
    tools: events.filter((event) => event.runId === run.id && event.type === "tool.call").map((event) => {
      const key = toolCallKey(event);
      const outcome = outcomes.get(key);
      const terminal = terminalStates.get(run.id);
      const attachment = attachments.get(key);
      const state: ActivityToolState = outcome
        ? outcome.failed ? "failed" : "completed"
        : terminal === "interrupted" || run.status === "cancelled" || run.status === "failed"
          ? "interrupted"
          : terminal === "completed" || run.status === "completed"
            ? "result_missing"
            : "running";
      return {
        key,
        tool: typeof event.payload.tool === "string" && event.payload.tool ? event.payload.tool : "tool",
        preview: typeof event.payload.preview === "string" && event.payload.preview ? event.payload.preview : null,
        result: attachment && "result" in attachment && typeof attachment.result === "string" ? attachment.result : null,
        truncated: Boolean(attachment && "result" in attachment && attachment.truncated),
        state,
        errorMessage: outcome?.errorMessage ?? (attachment && "errorMessage" in attachment ? attachment.errorMessage ?? null : null),
      };
    }),
  }));
}

/** What the current turn is doing, without a label: the screen translates it. */
export type RunActivityState = { runId: string; startedAt: string | null } & (
  | { kind: "queued" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "tool"; tool: string; preview: string | null }
  | { kind: "waitingFor"; name: string }
);

const TERMINAL_RUN_STATUSES: ReadonlySet<RunDto["status"]> = new Set(["completed", "failed", "cancelled"]);
/** Noise with no render: it says nothing about what the bot is doing. */
const SILENT_EVENT_TYPES: ReadonlySet<StoredProductEvent["type"]> = new Set(["raw", "tool.result.attached"]);

function noticeText(event: StoredProductEvent): string {
  const value = event.payload.text ?? event.payload.message ?? event.payload.output;
  return typeof value === "string" ? value : "";
}

/**
 * The current turn's activity, for the row placed above the composer.
 *
 * Every thread state has a defined output, without depending on a position:
 * - open approval: `null`, the gate already occupies that place;
 * - concluded run (terminal event OR terminal status): never kept;
 * - the live run of the LAST event wins: a run that emits is executing,
 *   whatever status stayed in the cache; otherwise the first executable run,
 *   otherwise the first queued run;
 * - a queued run that emitted nothing but a notice: `queued`.
 */
export function deriveRunActivity(
  runs: readonly RunDto[],
  events: readonly StoredProductEvent[],
  approvals: readonly ApprovalRequestDto[],
): RunActivityState | null {
  if (approvals.length > 0) return null;
  const concluded = new Set(
    events.filter((event) => event.type === "run.completed" || event.type === "run.error").map((event) => event.runId),
  );
  const byId = new Map(runs.map((run) => [run.id, run] as const));
  const live = (run: RunDto | undefined): run is RunDto =>
    run !== undefined && !concluded.has(run.id) && !TERMINAL_RUN_STATUSES.has(run.status);
  const lastLiveEvent = events.findLast((event) => live(byId.get(event.runId)));
  const run = (lastLiveEvent ? byId.get(lastLiveEvent.runId) : undefined)
    ?? runs.find((candidate) => live(candidate) && isExecutingThreadRun(candidate))
    ?? runs.find((candidate) => live(candidate) && isWaitingThreadRun(candidate));
  if (!run) return null;

  // The timer starts from the turn's send (`createdAt`, dated by the server as of the
  // 202), never from `startedAt`: the cache sets it at the time of RECEIPT of the
  // first event, and the timer restarted at 0 when the text arrived.
  // A new bot's greeting has its own origin (runClockStart).
  const clock = runClockStart(run);
  const base = { runId: run.id, startedAt: Number.isFinite(clock) ? new Date(clock).toISOString() : run.startedAt ?? null };
  const runEvents = events.filter((event) => event.runId === run.id && !SILENT_EVENT_TYPES.has(event.type));
  if (isWaitingThreadRun(run) && runEvents.every((event) => event.type === "system.notice")) {
    return { ...base, kind: "queued" };
  }
  // Hand-off: the turn waits for the target, not the model. The name comes from the
  // notice text; unreadable, it falls back to the generic state.
  const lastMeaningful = runEvents.findLast((event) => event.type !== "agent.reasoning");
  if (lastMeaningful?.type === "system.notice" && lastMeaningful.payload.kind === HANDOFF_NOTICE_KIND.sent) {
    const target = handoffNoticeTarget(noticeText(lastMeaningful));
    if (target) return { ...base, kind: "waitingFor", name: target.name };
  }
  const last = runEvents.at(-1);
  if (last?.type === "tool.call") {
    const tool = typeof last.payload.tool === "string" && last.payload.tool ? last.payload.tool : "tool";
    const preview = typeof last.payload.preview === "string" && last.payload.preview ? last.payload.preview : null;
    return { ...base, kind: "tool", tool, preview };
  }
  if (last?.type === "agent.message") return { ...base, kind: "writing" };
  return { ...base, kind: "thinking" };
}
