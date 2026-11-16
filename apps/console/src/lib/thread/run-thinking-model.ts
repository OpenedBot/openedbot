import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import { toolKind, type ToolCall } from "@openedbot/conversation/domain/thread-tools";
import type { MessageAuthorBot, BotFaceSpec } from "@openedbot/contracts-api";
import type { Entry } from "./thread-timeline-model";
import { entryRunId } from "./thread-timeline-signature";

/*
 * A run's status row, as a pure model. Every text the bot writes (narration
 * and answer alike) is a normal assistant bubble, in order; the run's work
 * (plan, searches, tools, decisions) folds into ONE status row placed after
 * the run's last entry. Live, that row reads the current step; done, it
 * reads « Réflexion : Ns » and opens the full log.
 */

/** The run an entry of the WORK belongs to (plan, searches, real tools, decisions), or `null`. */
export function workRunId(entry: Entry): string | null {
  if (entry.kind === "plan" || entry.kind === "search") return entry.runId;
  if (entry.kind === "tools") {
    return entry.calls.some((call) => !isTodoTool(call.tool)) || entry.approvals.length > 0
      ? entry.runId
      : null;
  }
  if (entry.kind === "gate") return entry.approval.runId ?? null;
  return null;
}

const NO_RUNS: ReadonlySet<string> = new Set();

export type RunRow = {
  /** The run's work entries, in order: the row's folded log. */
  members: Entry[];
  /** The panel's steps: the work and the texts written between them, up to the last work entry. */
  log: Entry[];
  /** The row is rendered right after this entry (the run's last one, its user message included). */
  after: number;
  /** The run's last entry is a text: live, the bot is writing. */
  writing: boolean;
};

/**
 * The status rows of a thread window: one per run that has work, plus the
 * live run (`liveRunId`, even before its first event: it then follows the
 * run's user message) and the runs whose row is still collapsing after
 * their end (`closing`). A finished run keeps no row of its own otherwise.
 */
export function runRows(
  entries: readonly Entry[],
  { liveRunId, closing = NO_RUNS }: { liveRunId: string | null; closing?: ReadonlySet<string> },
): Map<string, RunRow> {
  const all = new Map<string, RunRow>();
  entries.forEach((entry, index) => {
    const runId = entryRunId(entry);
    if (!runId) return;
    const row = all.get(runId) ?? { members: [], log: [], after: index, writing: false };
    row.after = index;
    row.writing = entry.kind === "assistant" && entry.text.trim() !== "";
    if (workRunId(entry) === runId) {
      row.members.push(entry);
      row.log.push(entry);
    } else if (entry.kind === "assistant") row.log.push(entry);
    all.set(runId, row);
  });
  for (const [runId, row] of all) {
    if (row.members.length === 0 && runId !== liveRunId && !closing.has(runId)) all.delete(runId);
    // Texts after the last work entry are the answer, not a step.
    const lastWork = row.members.at(-1);
    row.log = lastWork ? row.log.slice(0, row.log.indexOf(lastWork) + 1) : [];
  }
  return all;
}

/** How long after its end a run's bottom row still renders: its collapse lasts 200 ms. */
export const RUN_ROW_CLOSING_MS = 1000;
/** How long after a head line first mounts it may still open (`reveal`) when remounted in place. */
const HEAD_REVEAL_MS = 1000;

/**
 * What a thread remembers of the runs it saw live, to animate their lines
 * instead of reserving room for them. A run that leaves the live state
 * keeps its bottom row for `RUN_ROW_CLOSING_MS`, the time of its collapse.
 * A head line (the bot's name, or the summary) that appears while the run
 * was seen here without one opens from zero height, once; a summary that
 * replaces a name already shown does not. Every call is idempotent for a
 * given state, so a render pass run twice (StrictMode) reads the same.
 */
export function createRunLineTracker() {
  const live = new Set<string>();
  const endedAt = new Map<string, number>();
  const headless = new Set<string>();
  const named = new Set<string>();
  const revealedAt = new Map<string, number>();
  return {
    /** The render pass's live run; returns the runs whose bottom row is collapsing. */
    observe(liveRunId: string | null, now: number): ReadonlySet<string> {
      if (liveRunId) {
        live.add(liveRunId);
        endedAt.delete(liveRunId);
      }
      for (const runId of live) {
        if (runId === liveRunId) continue;
        live.delete(runId);
        endedAt.set(runId, now);
      }
      const closing = new Set<string>();
      for (const [runId, at] of endedAt) {
        if (now - at < RUN_ROW_CLOSING_MS) closing.add(runId);
        else endedAt.delete(runId);
      }
      return closing;
    },
    /** The live run renders no head line (no work yet, or no name to show). */
    headless(runId: string) {
      headless.add(runId);
    },
    /** The live run shows the bot's name on its head line. */
    named(runId: string) {
      named.add(runId);
    },
    /** Whether the run's head line mounting now opens rather than jumping in. */
    reveal(runId: string, now: number, { summary }: { summary: boolean }): boolean {
      if (!headless.has(runId) || (summary && named.has(runId))) return false;
      const at = revealedAt.get(runId) ?? now;
      revealedAt.set(runId, at);
      return now - at < HEAD_REVEAL_MS;
    },
  };
}

export type RunLineTracker = ReturnType<typeof createRunLineTracker>;

export type RunStatusPhase = "pending" | "working" | "waiting" | "done" | "gone";

/**
 * What the row shows. Pending: no event yet (avatar, then the typing dots).
 * Working / waiting: the run is live. Done: the summary of a run that
 * worked. Gone: the bottom row of a finished run, which collapses then
 * unmounts (it never keeps its height).
 */
export function runStatusPhase({ pending, live, waiting, hasWork }: {
  pending: boolean;
  live: boolean;
  waiting: boolean;
  hasWork: boolean;
}): RunStatusPhase {
  if (live) return pending ? "pending" : waiting ? "waiting" : "working";
  return hasWork ? "done" : "gone";
}

export type RunStatusStep =
  | { kind: "tool"; call: ToolCall }
  | { kind: "waiting" }
  | { kind: "writing" }
  | { kind: "thinking" };

/**
 * The live row's step: a decision to make first (it must never hide), then
 * the running call (labelled by `toolProgressLabel`, never its raw
 * arguments), then « writing » when the run's last entry is a text, else
 * the generic thinking line.
 */
export function runStatusStep(calls: readonly ToolCall[], { waiting, writing }: { waiting: boolean; writing: boolean }): RunStatusStep {
  if (waiting) return { kind: "waiting" };
  const running = calls.findLast((call) => !call.done && !isTodoTool(call.tool));
  if (running) return { kind: "tool", call: running };
  return writing ? { kind: "writing" } : { kind: "thinking" };
}

export type ThinkingAgent = { id: string; name: string; seed: string; face?: BotFaceSpec | null };

/** Avatars side by side in the row before the rest is counted. */
export const THINKING_AGENTS_MAX = 4;

const AGENT_NAME_MAX = 32;

function delegateName(preview: string | undefined): string | null {
  const text = preview?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > AGENT_NAME_MAX ? `${text.slice(0, AGENT_NAME_MAX - 1)}…` : text;
}

/**
 * The agents of the row: the run's bot from its first event, then one per
 * delegation it started. A delegate's id is its rank among the run's
 * delegations, which only grow: its avatar keeps its key and face.
 */
export function thinkingAgents(
  author: MessageAuthorBot | null | undefined,
  calls: readonly ToolCall[],
): { visible: ThinkingAgent[]; overflow: number } {
  const lead = author ? author.name ?? author.slug ?? "" : "";
  const all: ThinkingAgent[] = author ? [{ id: author.id, name: lead, seed: author.id, face: author.face }] : [];
  let rank = 0;
  for (const call of calls) {
    if (toolKind(call.tool) !== "delegate") continue;
    rank += 1;
    const id = `${author?.id ?? "run"}:delegate:${rank}`;
    all.push({ id, name: delegateName(call.preview) ?? `${lead || "Agent"} ${rank}`, seed: id });
  }
  return { visible: all.slice(0, THINKING_AGENTS_MAX), overflow: Math.max(0, all.length - THINKING_AGENTS_MAX) };
}
