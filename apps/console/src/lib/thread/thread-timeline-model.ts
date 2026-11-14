import type { RailPosition } from "@openedbot/browser-ui-kit";
import type {
  ApprovalRequestDto,
  MessageAuthorBot,
  MessageContent,
  MessageReactionDto,
  MessageReplyPreview,
  ProductRunStatus,
  ThreadMessageDto,
} from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { isAbsorbedRun } from "@openedbot/conversation/domain/followup";
import { eventText, rendersNothing } from "./thread-event-text";
import { bucketEventsByRun, isMetadataReceipt, withoutReceipts, type EventsByRun } from "./timeline-run-events";
import { eventsAppendedFrom } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import {
  readAttachment,
  readToolOutcome,
  runToolTerminalStates,
  toolCallKey,
  type ToolAttachment,
  type ToolCall,
  type ToolOutcome,
} from "@openedbot/conversation/domain/thread-tools";
import { isAgentPlan, type AgentPlan } from "@openedbot/execution/domain/agent-plan";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import { withoutMediaLines } from "@openedbot/execution/domain/output-media-text";
import { isWebSearchTrail, type WebSearchQuery, type WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { pairWebSearchCalls } from "../run/tool-web-search";
import { splitAskUser } from "@openedbot/roster/domain/ask-user";
import {
  handoffDirectiveNotices,
  splitHandoff,
  type HandoffDirectiveNotice,
} from "@openedbot/roster/domain/bot-mode";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";

/**
 * The thread model: the ordered list of entries to render, and what the
 * render reads around them (author labels, trail stems, aggregated turns…).
 *
 * Two constructions, one output:
 *
 * - `buildTimelineModel` rebuilds everything from the snapshot;
 * - `createTimelineModelBuilder` keeps a sub-model per BLOCK (a run with
 *   its messages, a message without a run, a run without a message). An SSE
 *   event only adds to its run's bucket: the other blocks keep their entries,
 *   down to object identity, and only the touched block is recomputed.
 *
 * Both apply the same functions (blocks, merge, plans and
 * searches, decorations); the test `thread-timeline-model.test.ts` checks
 * that the second renders exactly the first after every event.
 */

export type MessageAttachmentChip = Extract<MessageContent[number], { type: "attachment" }>;

/** An entry of the thread, in the order it must be rendered. */
export type Entry =
  | { kind: "routine"; key: string; runId: string; createdAt?: string; targetId: string }
  | {
      kind: "user";
      key: string;
      text: string;
      /** The turn this message opened, `null` for a message without a run. */
      runId: string | null;
      attachments?: readonly MessageAttachmentChip[];
      authorBot?: MessageAuthorBot | null;
      replyTo?: MessageReplyPreview | null;
      reactions?: MessageReactionDto[];
      steeredIntoActive: boolean;
      /** Absorbed by a run that has since delivered: the label switches to the past tense. */
      steeredIntoSettled: boolean;
      targetId: string;
      /** ISO: the send time, under the bubble. */
      createdAt?: string;
    }
  | {
      kind: "assistant";
      key: string;
      text: string;
      runId: string;
      author?: MessageAuthorBot | null;
      messageId?: string | null;
      replyTo?: MessageReplyPreview | null;
      reactions?: MessageReactionDto[];
      /** Files produced by the turn, stored on the persisted message. */
      attachments?: readonly MessageAttachmentChip[];
      targetId: string;
    }
  | { kind: "event"; key: string; event: StoredProductEvent; targetId: string }
  /**
   * ADJACENT `tool.call`s of the same stretch, gathered into a single
   * expandable line: same reading rule as mobile (`collapseToolRuns`):
   * eleven stacked calls teach nothing more than a « 11 outils » line,
   * and push the answer off screen. The key is that of the FIRST call,
   * so the line's identity survives the arrival of the twelfth.
   */
  | {
      kind: "tools";
      key: string;
      runId: string;
      calls: ToolCall[];
      approvals: ApprovalRequestDto[];
      targetId: string;
      /** The web search each call ran, aligned on `calls` (`pairWebSearchCalls`). */
      searches?: (WebSearchQuery | null)[];
    }
  | { kind: "plan"; key: string; runId: string; plan: AgentPlan; targetId: string }
  | { kind: "search"; key: string; runId: string; trail: WebSearchTrail; targetId: string }
  | { kind: "gate"; key: string; approval: ApprovalRequestDto };

export type TimelineUserInput = {
  id: string;
  text: string;
  /** US-CHAT-08: the message's chips, without their payload. */
  attachments?: readonly MessageAttachmentChip[];
  runId: string | null;
  authorBot?: MessageAuthorBot | null;
  /** ISO. Used to interleave by time with message-less runs (rooms). */
  createdAt?: string;
};

export type TimelineRun = {
  id: string;
  status: ProductRunStatus;
  completionKind?: string | null;
  routineId?: string | null;
  workflowId?: string | null;
  stepKind?: string | null;
  /** Team-mode room: the turn that writes the final answer. */
  groupPhase?: string | null;
  /** `MODEL_UNAVAILABLE`: the error bubble becomes a readable message. */
  errorCode?: string | null;
  /** The requested model (the refused one, for `MODEL_UNAVAILABLE`). */
  model?: string | null;
  usage?: { totalTokens?: number; outputTokens?: number } | null;
  /** ISO: the run's bounds, for the real duration shown under the answer. */
  createdAt?: string;
  endedAt?: string | null;
};

export type TimelineModelInput = {
  /** Already stripped of service runs. */
  events: readonly StoredProductEvent[];
  userInputs: readonly TimelineUserInput[];
  messages: readonly ThreadMessageDto[];
  approvals: readonly ApprovalRequestDto[];
  runs: readonly TimelineRun[];
  running: boolean;
  runAuthors?: ReadonlyMap<string, MessageAuthorBot>;
  defaultAuthor: MessageAuthorBot | null;
  mentionables: readonly MentionableBot[];
  operatorUsername: string | null;
  activeAskUserRunId: string | null;
  /** `t("eventParts.toolFallback")`: a string rather than `t`, comparable from one pass to the next. */
  toolFallbackLabel: string;
};

export type AssistantTurn = { firstKey: string; lastKey: string; text: string };

export type TimelineModel = {
  shown: Entry[];
  assistantTurns: Map<string, AssistantTurn>;
  authorLabelEntryKeys: Set<string>;
  answeredQuestionByUserKey: Map<string, string>;
  attachedQuestionEntryKeys: Set<string>;
  streamingRunId: string | null;
  latestAssistantKey: string | null;
  handoffNoticeByRun: ReadonlyMap<string, HandoffDirectiveNotice>;
  runsById: Map<string, TimelineRun>;
  eventsByRun?: ReadonlyMap<string, readonly StoredProductEvent[]>;
  trailPositions: Map<string, RailPosition>;
  /** A turn's time: its first event. */
  turnTimeByRun: Map<string, string>;
};

// An event's text, also read by the timeline and by the stream (`live-run-text.ts`).
export { eventText } from "./thread-event-text";

type AskUserSplit = ReturnType<typeof splitAskUser>;

const askSplits = new WeakMap<object, { text: string; username: string | null; value: AskUserSplit }>();

/**
 * An entry's `splitAskUser`, memoized per entry: the thread rereads it on every
 * pass (aggregated turns, activity, voice reading) and it compiles a regex
 * per call. An entry is never modified once the model is rendered.
 */
export function entryAskSplit(entry: { text: string }, operatorUsername: string | null): AskUserSplit {
  const hit = askSplits.get(entry);
  if (hit && hit.text === entry.text && hit.username === operatorUsername) return hit.value;
  const value = splitAskUser(entry.text, operatorUsername ? { username: operatorUsername } : null);
  askSplits.set(entry, { text: entry.text, username: operatorUsername, value });
  return value;
}

export type AssistantTextParts = {
  split: AskUserSplit;
  /** The text without the terminal ask_user question. */
  shown: string;
  body: string;
  handoff: ReturnType<typeof splitHandoff>["handoff"];
};

const textParts = new WeakMap<object, {
  text: string;
  username: string | null;
  notice: HandoffDirectiveNotice | null;
  mentionables: readonly MentionableBot[];
  value: AssistantTextParts;
}>();

/** A bubble's public prose: ask_user question and hand-off directive removed. */
export function assistantTextParts(
  entry: { text: string },
  operatorUsername: string | null,
  handoffNotice: HandoffDirectiveNotice | null,
  mentionables: readonly MentionableBot[],
): AssistantTextParts {
  const hit = textParts.get(entry);
  if (
    hit && hit.text === entry.text && hit.username === operatorUsername
    && hit.notice === handoffNotice && hit.mentionables === mentionables
  ) return hit.value;
  const split = entryAskSplit(entry, operatorUsername);
  const shown = split.prompt ? split.body : entry.text;
  const { body, handoff } = handoffNotice
    ? splitHandoff(
        shown,
        handoffNotice.target ? [...mentionables, handoffNotice.target] : mentionables,
      )
    : { body: shown, handoff: null };
  const value = { split, shown, body, handoff };
  textParts.set(entry, { text: entry.text, username: operatorUsername, notice: handoffNotice, mentionables, value });
  return value;
}

type Steering = { steeredIntoActive: boolean; steeredIntoSettled: boolean };

type TimelineBlock =
  | { kind: "message"; id: string; time: number; order: number; message: TimelineUserInput }
  | { kind: "run"; id: string; time: number; order: number; runId: string }
  | { kind: "events"; id: string; time: number; order: number; runId: string };

type BlockPlan = {
  blocks: TimelineBlock[];
  messagesByRun: Map<string, TimelineUserInput[]>;
  steeredMessagesByTarget: Map<string, TimelineUserInput[]>;
  persistedById: Map<string, ThreadMessageDto>;
  runsById: Map<string, TimelineRun>;
  assistantMessageByRun: Map<string, ThreadMessageDto>;
  /** Run absorbed (steering) into the run that absorbed it. */
  steeredIntoRun: Map<string, string>;
  steeringOf: (runId: string | null) => Steering;
};

/**
 * The thread's BLOCKS, sorted by time. A block = a run with its messages and
 * its events (anchored on its first message), OR a message without a run (the
 * operator's message in a group room), OR a message-less run (a
 * room turn, a resume, a system notice).
 */
function planTimelineBlocks(input: TimelineModelInput, eventsByRun: EventsByRun): BlockPlan {
  const { userInputs, messages, runs } = input;
  // A turn's message precedes that turn's events. Interleaving them by
  // `runId` keeps a second question from appearing above the answer
  // to the first.
  //
  // A « courrier » turn (hand-off bot mode) carries TWO messages on the
  // same `runId`: the human question « @neo … » and the bot's incoming answer.
  // Attaching the run's events to each of the two would duplicate them:
  // they therefore attach only once per run, to its first message. And
  // among a run's messages, only a DELIVERED ANSWER (the one a
  // `bot.message` of the run designates by `messageId`) goes AFTER the events:
  // the « Transmis à … » notice announces it. An incoming message that is the
  // run's PROMPT (in the target bot's thread: « Message de Amis ») precedes
  // the events the way a human question would, otherwise the bot's answer
  // would show before the question. Structural, not timestamped: the
  // runtime and cloud API clocks are not the same.
  const messagesByRun = new Map<string, TimelineUserInput[]>();
  for (const message of userInputs) {
    if (message.runId === null) continue;
    const bucket = messagesByRun.get(message.runId) ?? [];
    bucket.push(message);
    messagesByRun.set(message.runId, bucket);
  }
  const persistedById = new Map(messages.map((message) => [message.id, message]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const assistantMessageByRun = new Map<string, ThreadMessageDto>();
  for (const message of messages) {
    if (message.role === "assistant" && message.runId) assistantMessageByRun.set(message.runId, message);
  }
  // A message written DURING an answer is absorbed by the run in progress
  // (steering): its own run is cancelled with `steered_into_active`. It
  // therefore belongs to the active turn and is read UNDER the message that opened this
  // turn, above the machinery and the answer that reply to it as well.
  // As a separate block, it fell after the whole active turn: the work
  // indicator slipped between the two questions, and the answer appeared
  // above the last message sent.
  //
  // The API does not carry the absorption target. A thread runs only one
  // run at a time (the queue is serialized per conversation) and `runs` arrives
  // sorted by creation date: the target is therefore the last non-steered run
  // that precedes it.
  const steeredIntoRun = new Map<string, string>();
  let absorbingRunId: string | null = null;
  for (const run of runs) {
    if (isAbsorbedRun(run)) {
      if (absorbingRunId) steeredIntoRun.set(run.id, absorbingRunId);
      continue;
    }
    absorbingRunId = run.id;
  }
  const steeringOf = steeringResolver(runsById, steeredIntoRun);
  // BLOCKS, then a sort by time. Without this sort, a room's turns: runs
  // without a human message: all fell AFTER every one of the
  // operator's messages, in the reverse of the real order. Time comes from `createdAt`
  // (messages) and `occurredAt` (events), which the cloud API writes to the
  // millisecond; a message without a timestamp (old callers) keeps its
  // insertion slot.
  const steeredMessagesByTarget = new Map<string, TimelineUserInput[]>();
  const absorbedRuns = new Set<string>();
  const blocks: TimelineBlock[] = [];
  const timeOf = (value: string | Date | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const attachedRuns = new Set<string>();
  let lastTime = 0;
  userInputs.forEach((message, index) => {
    const runId = message.runId;
    const time = timeOf(message.createdAt, lastTime);
    lastTime = Math.max(lastTime, time);
    if (runId === null) {
      blocks.push({ kind: "message", id: `m:${message.id}`, time, order: index, message });
      return;
    }
    const absorbedBy = steeredIntoRun.get(runId);
    if (absorbedBy !== undefined && messagesByRun.has(absorbedBy)) {
      if (absorbedRuns.has(runId)) return;
      absorbedRuns.add(runId);
      const bucket = steeredMessagesByTarget.get(absorbedBy) ?? [];
      bucket.push(...(messagesByRun.get(runId) ?? []));
      steeredMessagesByTarget.set(absorbedBy, bucket);
      return;
    }
    if (attachedRuns.has(runId)) return;
    attachedRuns.add(runId);
    blocks.push({ kind: "run", id: `r:${runId}`, time, order: index, runId });
  });
  // The events of a run without a user message (room turn, resume,
  // system notice) must not disappear all the same: one block per run,
  // dated from its first event.
  for (const [runId, runEvents] of eventsByRun) {
    if (attachedRuns.has(runId)) continue;
    const first = runEvents[0];
    if (!first) continue;
    blocks.push({
      kind: "events",
      id: `e:${runId}`,
      time: timeOf(first.occurredAt, Number.MAX_SAFE_INTEGER),
      order: userInputs.length + blocks.length,
      runId,
    });
  }
  blocks.sort((left, right) => left.time - right.time || left.order - right.order);
  return { blocks, messagesByRun, steeredMessagesByTarget, persistedById, runsById, assistantMessageByRun, steeredIntoRun, steeringOf };
}

// The label follows the ABSORBING run, not the cancelled run: « dans la réponse
// en cours » while it is writing, « dans la réponse » once it has delivered.
// Without that, every absorbed message kept « en cours » for life, even though
// nothing was running anymore. Target not found: stay in the present, as
// before, rather than asserting an answer we do not see.
function steeringResolver(
  runsById: ReadonlyMap<string, TimelineRun>,
  steeredIntoRun: ReadonlyMap<string, string>,
): (runId: string | null) => Steering {
  return (runId) => {
    const run = runId === null ? undefined : runsById.get(runId);
    if (run === undefined || !isAbsorbedRun(run)) {
      return { steeredIntoActive: false, steeredIntoSettled: false };
    }
    const absorbingId = steeredIntoRun.get(run.id);
    const absorbing = absorbingId === undefined ? undefined : runsById.get(absorbingId);
    const settled = absorbing !== undefined
      && (absorbing.status === "completed" || absorbing.status === "failed" || absorbing.status === "cancelled");
    return { steeredIntoActive: !settled, steeredIntoSettled: settled };
  };
}

/** A block's raw entries, before the merge. */
function blockEntries(block: TimelineBlock, plan: BlockPlan, eventsByRun: EventsByRun): Entry[] {
  const out: Entry[] = [];
  const pushMessage = (message: TimelineUserInput) => {
    if (message.runId && plan.runsById.get(message.runId)?.routineId) return;
    const persisted = plan.persistedById.get(message.id);
    out.push({
      kind: "user",
      key: message.id,
      text: message.text,
      runId: message.runId,
      attachments: message.attachments,
      authorBot: message.authorBot ?? null,
      replyTo: persisted?.replyTo ?? null,
      reactions: persisted?.reactions ?? [],
      ...plan.steeringOf(message.runId),
      targetId: `message:${message.id}`,
      createdAt: message.createdAt,
    });
  };
  const pushEvents = (runEvents: readonly StoredProductEvent[]) => {
    for (const event of runEvents) {
      out.push({
        kind: "event",
        // By sequence, not by cursor: a delta broadcast before its commit
        // has no cursor, and its durable twin is dropped as a duplicate
        // (same `runId:sequence`). A key on the cursor was `…:undefined`
        // for every provisional delta of a run: duplicate React keys,
        // ghost bubbles after the thread is reread.
        key: `e${event.runId}:${event.sequence}`,
        event,
        targetId: `event:${event.runId}:${event.cursor}`,
      });
    }
  };
  if (block.kind === "message") {
    pushMessage(block.message);
    return out;
  }
  const routineRun = plan.runsById.get(block.runId);
  if (routineRun?.routineId) out.push({ kind: "routine", key: `routine:${block.runId}`, runId: block.runId,
    createdAt: routineRun.createdAt, targetId: `run:${block.runId}` });
  const runEvents = eventsByRun.get(block.runId) ?? [];
  if (block.kind === "events") {
    pushEvents(runEvents);
    return out;
  }
  const delivered = new Set(
    runEvents
      .filter((event) => event.type === "bot.message")
      .map((event) => String(event.payload.messageId ?? "")),
  );
  const runMessages = plan.messagesByRun.get(block.runId) ?? [];
  for (const item of runMessages) if (!delivered.has(item.id)) pushMessage(item);
  // The messages THIS run absorbed along the way: under the question
  // that opened the turn, before the machinery. Placing them after the events
  // already emitted would be chronologically exact but would let them be overtaken by
  // each new tool, then by the answer.
  for (const item of plan.steeredMessagesByTarget.get(block.runId) ?? []) pushMessage(item);
  pushEvents(runEvents);
  for (const item of runMessages) if (delivered.has(item.id)) pushMessage(item);
  return out;
}

type ToolIndex = {
  outcomes: Map<string, ToolOutcome>;
  terminal: ReturnType<typeof runToolTerminalStates>;
  attached: Map<string, ToolAttachment>;
};

// `toolCallId` alone repeats from one run to the next: `HermesEventNormalizer`
// is fresh per run and its counter (`tc_0`, `tc_1`, …) always starts again at
// zero (vador review, F2). The key (`toolCallKey`) therefore ALWAYS carries
// `runId`: otherwise one turn's result also shows under the line
// of a previous turn. The `tool.result` ALSO carries the outcome (`error`) and the
// duration (`durationMs`): long emitted without ever being read.
function indexToolEvents(events: readonly StoredProductEvent[]): ToolIndex {
  const outcomes = new Map<string, ToolOutcome>(
    events
      .filter((event) => event.type === "tool.result")
      .map((event) => [toolCallKey(event), readToolOutcome(event.payload)]),
  );
  // US-CHAT-07: the real content, attached after the fact by the cloud API in a
  // distinct event: `tool.result` (above) only marks a
  // call as finished, never the why; see `tool-results.ts`.
  const attached = new Map<string, ToolAttachment>();
  for (const event of events) {
    if (event.type !== "tool.result.attached") continue;
    const attachment = readAttachment(event.payload);
    if (attachment) attached.set(toolCallKey(event), attachment);
  }
  return { outcomes, terminal: runToolTerminalStates(events), attached };
}

// Groups: a turn that PASSED (notice `group.pass`) said nothing: the
// « pass » text streamed by the runtime is not rendered, only the notice remains.
function passedRunIds(events: readonly StoredProductEvent[]): Set<string> {
  return new Set(
    events
      .filter((event) => event.type === "system.notice" && event.payload.kind === "group.pass")
      .map((event) => event.runId),
  );
}

type MergeContext = {
  tools: ToolIndex;
  passedRuns: ReadonlySet<string>;
  approval: (id: string) => ApprovalRequestDto | undefined;
  /** Requests already placed: a replay must never offer two buttons for the same decision. */
  placed: Set<string>;
  runAuthors?: ReadonlyMap<string, MessageAuthorBot>;
  assistantMessageByRun: ReadonlyMap<string, ThreadMessageDto>;
  toolFallbackLabel: string;
};

/**
 * The runtime emits one `agent.message` per flush window (every
 * DELTA_FLUSH_MS during streaming), so one turn arrives as several
 * fragments cut in the middle of a word. ADJACENT fragments are merged into
 * a single bubble: a `tool.call` or a gate between two texts breaks the
 * merge and preserves the interleaving. Naked concatenation: the fragments
 * recompose exactly the original text (`buffer += delta`).
 *
 * Every merge requires the same `runId`: two blocks (one per run) therefore
 * never merge with each other, which allows merging block by block.
 */
function mergeTimelineEntries(entries: readonly Entry[], ctx: MergeContext): Entry[] {
  const merged: Entry[] = [];
  for (const entry of entries) {
    if (entry.kind === "event" && entry.event.type === "approval.requested") {
      // The worker replaces the local Hermes identifier with the UUID actually
      // persisted in `approval_requests`. `approvalId` stays accepted for
      // old events already stored. Without this join, the card was
      // dropped at the very bottom of the thread, far from the command to decide.
      const rawId = entry.event.payload.approvalRequestId ?? entry.event.payload.approvalId;
      const approvalId = typeof rawId === "string" ? rawId : null;
      const approval = approvalId ? ctx.approval(approvalId) : undefined;
      // A request already answered/expired is no longer in `approvals`: it
      // stays silent and does not cut two text fragments (historical
      // behavior locked by test).
      if (!approval) continue;
      // An SSE replay or a badly merged snapshot must never offer two
      // buttons able to answer the same decision.
      if (ctx.placed.has(approval.id)) continue;
      ctx.placed.add(approval.id);
      const previous = merged[merged.length - 1];
      if (previous?.kind === "tools" && previous.runId === entry.event.runId) {
        previous.approvals.push(approval);
      } else {
        merged.push({ kind: "gate", key: `approval:${approval.id}`, approval });
      }
      continue;
    }
    // An event with no render does not become an entry: inserted between two
    // fragments (a `tool.result`, a `raw`… in the middle of the flush), it broke
    // adjacency and cut the bubble in two while displaying nothing. Mobile
    // filters the same way before the merge (`thread-rows.ts`). A `tool.call`
    // does render: it keeps cutting the bubble.
    if (entry.kind === "event" && rendersNothing(entry.event)) continue;
    // Adjacent `tool.call`s gather into a single « N outils » line
    // (same fallback as mobile, `collapseToolRuns`). Adjacency is real:
    // events with no render are already filtered above, an interleaved text or
    // notice does break the series: the chronology stays true.
    if (entry.kind === "event" && entry.event.type === "tool.call") {
      const key = toolCallKey(entry.event);
      const outcome = ctx.tools.outcomes.get(key);
      const terminal = ctx.tools.terminal.get(entry.event.runId);
      const attachment = ctx.tools.attached.get(key);
      const preview = entry.event.payload.preview;
      const errorMessage = outcome?.errorMessage ?? (attachment && "errorMessage" in attachment ? attachment.errorMessage : null);
      const call: ToolCall = {
        tool: String(entry.event.payload.tool ?? ctx.toolFallbackLabel),
        done: outcome !== undefined || terminal !== undefined,
        ...(outcome?.failed || (outcome === undefined && terminal === "interrupted")
          ? { failed: true as const }
          : {}),
        ...(outcome && outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(typeof preview === "string" && preview !== "" ? { preview } : {}),
        ...(outcome?.resultExcerpt ? { resultExcerpt: outcome.resultExcerpt } : {}),
        ...(attachment ? { attachment } : {}),
      };
      const last = merged[merged.length - 1];
      // A gate visually closes the group: a call that arrives only after
      // the decision belongs to a new step, even if no text
      // interleaved.
      if (
        last?.kind === "tools" &&
        last.runId === entry.event.runId &&
        last.approvals.length === 0
      ) last.calls.push(call);
      else merged.push({
        kind: "tools",
        key: entry.key,
        runId: entry.event.runId,
        calls: [call],
        approvals: [],
        targetId: entry.targetId,
      });
      continue;
    }
    if (entry.kind === "event" && entry.event.type === "agent.message") {
      if (ctx.passedRuns.has(entry.event.runId)) continue;
      const last = merged[merged.length - 1];
      const author = ctx.runAuthors?.get(entry.event.runId) ?? null;
      // Turns of two different members never merge, even when adjacent.
      if (last?.kind === "assistant" && last.runId === entry.event.runId && (last.author?.id ?? null) === (author?.id ?? null)) {
        last.text += eventText(entry.event);
      } else {
        const persisted = ctx.assistantMessageByRun.get(entry.event.runId);
        merged.push({
          kind: "assistant",
          key: entry.key,
          text: eventText(entry.event),
          runId: entry.event.runId,
          author,
          messageId: persisted?.id ?? null,
          replyTo: persisted?.replyTo ?? null,
          reactions: persisted?.reactions ?? [],
          targetId: entry.targetId,
        });
      }
      continue;
    }
    merged.push(entry);
  }
  const lastAssistant = new Map<string, Extract<Entry, { kind: "assistant" }>>();
  for (const entry of merged) if (entry.kind === "assistant") { // chips on the LAST bubble, `MEDIA:` attachments outside the text
    const persisted = ctx.assistantMessageByRun.get(entry.runId), names = persisted?.content.flatMap((part) => part.type === "attachment" ? [part.name] : []);
    entry.text = withoutMediaLines(entry.text, names ? new Set(names) : null);
    lastAssistant.set(entry.runId, entry);
  }
  for (const [runId, entry] of lastAssistant) {
    const attachments = (ctx.assistantMessageByRun.get(runId)?.content ?? [])
      .filter((part): part is MessageAttachmentChip => part.type === "attachment");
    if (attachments.length > 0) entry.attachments = attachments;
  }
  // A room member who passes streams « (pass) » before the
  // `group.pass` notice arrives with the end of the run: without this filter, a
  // « (pass) » bubble showed and then disappeared. A run that persisted a
  // message did speak: only text still without a message is hidden.
  return merged.filter((entry) =>
    entry.kind !== "assistant" ||
    ctx.assistantMessageByRun.has(entry.runId) ||
    !isPassLikeText(entry.text));
}

/** `(pass)`, `pass`, or one of their prefixes, as the stream delivers it. */
function isPassLikeText(text: string): boolean {
  const compact = text.trim().toLowerCase().replace(/[\s*_`"'.!]/g, "");
  return compact.length > 0 && ("(pass)".startsWith(compact) || "pass".startsWith(compact));
}

type RunTrail<T> = { value: T; first: StoredProductEvent };

/**
 * Hermes does not put tool arguments in the SSE stream. The worker
 * therefore rereads the transcript after every `todo` write and at the close of the
 * run. The last `agentPlan` observed replaces the previous one: no step
 * advances on a timer or on a bare `tool.call`. Same mechanism for
 * web searches. `first` keeps the first carrying event: it is what
 * orders the plans and searches placed at the end of the thread.
 */
function collectRunTrails(events: readonly StoredProductEvent[]) {
  const plans = new Map<string, RunTrail<AgentPlan>>();
  const searches = new Map<string, RunTrail<WebSearchTrail>>();
  for (const event of events) {
    const plan = event.payload.agentPlan;
    if (!isAgentPlan(plan) || plan.steps.length === 0) continue;
    plans.set(event.runId, { value: plan, first: plans.get(event.runId)?.first ?? event });
  }
  for (const event of events) {
    const trail = event.payload.webSearch;
    if (!isWebSearchTrail(trail) || trail.queries.length === 0) continue;
    searches.set(event.runId, { value: trail, first: searches.get(event.runId)?.first ?? event });
  }
  return { plans, searches };
}

type OrphanTrail = { entry: Entry; first: StoredProductEvent };

/**
 * Hands each run's web searches to its `web_search` calls, so the Tool Result
 * carries the query and its sources. Returns the trails still owed a row of
 * their own: the queries no call claimed (a run whose calls were never
 * streamed, a transcript ahead of the stream).
 */
function attachRunSearches(
  merged: Entry[],
  searches: ReadonlyMap<string, RunTrail<WebSearchTrail>>,
): Map<string, RunTrail<WebSearchTrail>> {
  const toolEntries = new Map<string, Array<{ index: number; entry: Extract<Entry, { kind: "tools" }> }>>();
  merged.forEach((entry, index) => {
    if (entry.kind !== "tools") return;
    toolEntries.set(entry.runId, [...(toolEntries.get(entry.runId) ?? []), { index, entry }]);
  });
  const remaining = new Map(searches);
  for (const [runId, entries] of toolEntries) {
    const trail = searches.get(runId);
    const { searches: paired, unpaired } = pairWebSearchCalls(entries.map(({ entry }) => entry.calls), trail?.value ?? null);
    entries.forEach(({ index, entry }, at) => {
      const aligned = paired[at]!;
      if (aligned.some((query) => query !== null)) merged[index] = { ...entry, searches: aligned };
    });
    if (!trail) continue;
    if (unpaired.length === 0) remaining.delete(runId);
    else remaining.set(runId, { ...trail, value: { queries: unpaired } });
  }
  return remaining;
}

/**
 * Places each run's plan, then its search trail, just before its
 * tool journal (failing that, before its first bubble). A run with neither a tool nor a
 * bubble has no anchor: its plan and its search are returned to be
 * appended at the end of the thread, plans first.
 */
function insertRunTrails(
  merged: Entry[],
  trails: ReturnType<typeof collectRunTrails>,
): { orphanPlans: OrphanTrail[]; orphanSearches: OrphanTrail[] } {
  const orphanPlans: OrphanTrail[] = [];
  const orphanSearches: OrphanTrail[] = [];
  const searchTrails = attachRunSearches(merged, trails.searches);
  for (const [runId, { value: plan, first }] of trails.plans) {
    const firstTools = merged.findIndex((entry) => entry.kind === "tools" && entry.runId === runId);
    const firstRunEntry = merged.findIndex((entry) =>
      (entry.kind === "assistant" || entry.kind === "tools") && entry.runId === runId,
    );
    const insertionIndex = firstTools === -1 ? firstRunEntry : firstTools;
    const targetId = firstTools === -1
      ? `plan:${runId}`
      : merged[firstTools]!.kind === "tools" ? merged[firstTools]!.targetId : `plan:${runId}`;
    const planEntry: Entry = { kind: "plan", key: `plan:${runId}`, runId, plan, targetId };
    if (insertionIndex === -1) orphanPlans.push({ entry: planEntry, first });
    else merged.splice(insertionIndex, 0, planEntry);
  }
  // The trail is placed just after the run's plan, before the tool detail.
  for (const [runId, { value: trail, first }] of searchTrails) {
    const firstTools = merged.findIndex((entry) => entry.kind === "tools" && entry.runId === runId);
    const firstRunEntry = merged.findIndex((entry) =>
      (entry.kind === "assistant" || entry.kind === "tools") && entry.runId === runId,
    );
    const insertionIndex = firstTools === -1 ? firstRunEntry : firstTools;
    const targetId = firstTools !== -1 && merged[firstTools]!.kind === "tools"
      ? merged[firstTools]!.targetId
      : `search:${runId}`;
    const searchEntry: Entry = { kind: "search", key: `search:${runId}`, runId, trail, targetId };
    if (insertionIndex === -1) orphanSearches.push({ entry: searchEntry, first });
    else merged.splice(insertionIndex, 0, searchEntry);
  }
  return { orphanPlans, orphanSearches };
}

function runTurnTime(runEvents: readonly StoredProductEvent[]): string | undefined {
  let earliest: string | undefined;
  for (const event of runEvents) {
    const at = new Date(event.occurredAt);
    if (!Number.isFinite(at.getTime())) continue;
    const iso = at.toISOString();
    if (!earliest || iso < earliest) earliest = iso;
  }
  return earliest;
}

/**
 * The run whose text is STILL arriving: its bubbles smooth their growth
 * (`useSmoothText`), the others render their text as-is. A run already
 * concluded no longer streams.
 */
function streamingRunOf(
  running: boolean,
  events: readonly StoredProductEvent[],
  eventsByRun: EventsByRun,
  runsById: ReadonlyMap<string, TimelineRun>,
): string | null {
  if (!running) return null;
  // A run the snapshot lists as ended (cancelled, failed) is concluded even
  // when its closing event never came.
  const concluded = (runId: string) => {
    const status = runsById.get(runId)?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return true;
    return (eventsByRun.get(runId) ?? []).some((event) => event.type === "run.completed" || event.type === "run.error");
  };
  const last = events.findLast((event) => !isMetadataReceipt(event));
  if (!last) return null;
  // One run at a time (a 1:1 thread): the last event's run, unless it ended.
  if (!concluded(last.runId)) return last.runId;
  // A salon runs several members: the last event can close one member's run
  // while another is still working. The live run is then the latest one that
  // has not concluded AND that the snapshot still lists as active; an old run
  // that never wrote its closing event must not come back to life.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const { runId } = events[index]!;
    if (isMetadataReceipt(events[index]!) || runId === last.runId || concluded(runId)) continue;
    const status = runsById.get(runId)?.status;
    if (status !== undefined && status !== "completed" && status !== "failed" && status !== "cancelled") return runId;
  }
  return null;
}

/** What the render reads around the entries: one linear pass, no reparse (splits memoized per entry). */
function finishTimelineModel(
  shown: Entry[],
  input: TimelineModelInput,
  derived: Pick<TimelineModel, "handoffNoticeByRun" | "runsById" | "streamingRunId" | "turnTimeByRun" | "eventsByRun">,
  derivedEntries: readonly Entry[] = shown,
): TimelineModel {
  const { runAuthors, defaultAuthor, operatorUsername, activeAskUserRunId, mentionables } = input;
  const latestAssistantKey = derivedEntries.findLast((entry) => entry.kind === "assistant")?.key ?? null;

  // The bot's label belongs to the visual start of the turn, hence to its FIRST
  // entry: search trail, plan, tool call, or text, in the order the
  // thread places them. The first two insert before the tool journal and
  // did not carry the label, so the turn opened on an orphan
  // block and the bot's name appeared underneath.
  const authorLabelEntryKeys = new Set<string>();
  const labeledRunIds = new Set<string>();
  for (const entry of derivedEntries) {
    if (entry.kind !== "assistant" && entry.kind !== "tools" && entry.kind !== "search" && entry.kind !== "plan") {
      continue;
    }
    const author = entry.kind === "assistant"
      ? entry.author ?? defaultAuthor
      : runAuthors?.get(entry.runId) ?? defaultAuthor;
    if (!author || labeledRunIds.has(entry.runId)) continue;
    // An empty tool journal (only `todo`s, projected elsewhere) is not
    // displayed: it therefore does not open the turn and does not take the label.
    if (entry.kind === "tools") {
      const calls = entry.calls.filter((call) => !isTodoTool(call.tool));
      if (calls.length === 0 && entry.approvals.length === 0) continue;
    }
    authorLabelEntryKeys.add(entry.key);
    labeledRunIds.add(entry.runId);
  }

  // The turn's trail: plan, searches, tools, and approval requests
  // that are CONSECUTIVE in the same run join through a single stem (`TrailItem`), the way
  // BoardUI's `task-list` and `web-search` blocks share their guide. Any
  // other entry (text, message, marker) cuts the stem: one cut too many
  // leaves two clean trails, a wrong join would leave a hanging stroke.
  const trailPositions = new Map<string, RailPosition>();
  let trailGroup: Array<{ key: string; runId: string }> = [];
  const closeTrail = () => {
    if (trailGroup.length > 1) {
      trailGroup.forEach((item, index) => trailPositions.set(
        item.key,
        index === 0 ? "first" : index === trailGroup.length - 1 ? "last" : "middle",
      ));
    }
    trailGroup = [];
  };
  for (const entry of derivedEntries) {
    const trailRunId = entry.kind === "plan" || entry.kind === "search"
      ? entry.runId
      : entry.kind === "tools" && (entry.calls.some((call) => !isTodoTool(call.tool)) || entry.approvals.length > 0)
        ? entry.runId
        : entry.kind === "gate"
          ? entry.approval.runId ?? null
          : null;
    if (trailRunId === null || (trailGroup.length > 0 && trailGroup[0]!.runId !== trailRunId)) closeTrail();
    if (trailRunId !== null) trailGroup.push({ key: entry.key, runId: trailRunId });
  }
  closeTrail();

  // A finished ask_user question is the context of the operator answer
  // that follows it. Leaving it on the assistant axis creates two visual
  // conversations (question all the way left, answer all the way right). The
  // question is therefore attached to the next real operator message; intermediate
  // machinery entries (plan/tools) do not break this relation.
  const answeredQuestionByUserKey = new Map<string, string>();
  const attachedQuestionEntryKeys = new Set<string>();
  let pendingAnsweredQuestion: { entryKey: string; question: string } | null = null;
  for (const entry of derivedEntries) {
    if (entry.kind === "assistant") {
      const split = entryAskSplit(entry, operatorUsername);
      pendingAnsweredQuestion = split.prompt && entry.runId !== activeAskUserRunId
        ? { entryKey: entry.key, question: split.prompt.question }
        : null;
      continue;
    }
    if (entry.kind !== "user") continue;
    if (!entry.authorBot && pendingAnsweredQuestion) {
      answeredQuestionByUserKey.set(entry.key, pendingAnsweredQuestion.question);
      attachedQuestionEntryKeys.add(pendingAnsweredQuestion.entryKey);
    }
    pendingAnsweredQuestion = null;
  }

  // A turn is a single block. Tools cut a run's text into
  // several fragments of the same message: only the last rendered fragment carries
  // the action bar and the reactions, and that bar copies and reads the whole
  // turn. One bar per fragment repeated the same gestures in the middle of the turn.
  const assistantTurns = new Map<string, AssistantTurn>();
  for (const entry of derivedEntries) {
    if (entry.kind !== "assistant") continue;
    const { split, shown: visible, body, handoff } = assistantTextParts(
      entry,
      operatorUsername,
      derived.handoffNoticeByRun.get(entry.runId) ?? null,
      mentionables,
    );
    // Same guard as the render: a fragment reduced to its question is not shown.
    if (!body.trim() && (split.prompt || handoff)) continue;
    const text = (handoff ? body : visible).trim();
    const turn = assistantTurns.get(entry.runId);
    if (!turn) {
      assistantTurns.set(entry.runId, { firstKey: entry.key, lastKey: entry.key, text });
      continue;
    }
    turn.lastKey = entry.key;
    if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
  }

  return {
    shown,
    assistantTurns,
    authorLabelEntryKeys,
    answeredQuestionByUserKey,
    attachedQuestionEntryKeys,
    latestAssistantKey,
    trailPositions,
    ...derived,
  };
}

/** The full model, rebuilt from the whole snapshot. */
export function buildTimelineModel(input: TimelineModelInput): TimelineModel {
  const { approvals } = input;
  // These events carry an admission or steering state for the
  // cache. The visible thread stays built from the persisted messages and runs.
  const events = withoutReceipts(input.events);
  const eventsByRun = bucketEventsByRun(events);
  const plan = planTimelineBlocks(input, eventsByRun);
  const entries: Entry[] = [];
  for (const block of plan.blocks) {
    for (const entry of blockEntries(block, plan, eventsByRun)) entries.push(entry);
  }
  const approvalsById = new Map(approvals.map((approval) => [approval.id, approval]));
  const placed = new Set<string>();
  const shown = mergeTimelineEntries(entries, {
    tools: indexToolEvents(events),
    passedRuns: passedRunIds(events),
    approval: (id) => approvalsById.get(id),
    placed,
    runAuthors: input.runAuthors,
    assistantMessageByRun: plan.assistantMessageByRun,
    toolFallbackLabel: input.toolFallbackLabel,
  });
  const { orphanPlans, orphanSearches } = insertRunTrails(shown, collectRunTrails(events));
  for (const { entry } of orphanPlans) shown.push(entry);
  for (const { entry } of orphanSearches) shown.push(entry);
  // Compatibility with truncated snapshots and old events without a
  // correlatable identifier: an ACTIVE request must never disappear.
  // It then falls back to a standalone card, after the observable part of the thread.
  for (const approval of approvals) {
    if (!placed.has(approval.id)) shown.push({ kind: "gate", key: `approval:${approval.id}`, approval });
  }
  const turnTimeByRun = new Map<string, string>();
  for (const [runId, runEvents] of eventsByRun) {
    const time = runTurnTime(runEvents);
    if (time !== undefined) turnTimeByRun.set(runId, time);
  }
  return finishTimelineModel(shown, input, {
    handoffNoticeByRun: handoffDirectiveNotices(events),
    runsById: plan.runsById,
    streamingRunId: streamingRunOf(input.running, events, eventsByRun, plan.runsById),
    turnTimeByRun,
    eventsByRun,
  });
}

/** Rebuilds render-only summaries for the mounted slice (`shown` from `visibleStart`) and its preceding turn. */
export function deriveTimelineWindow(
  model: TimelineModel,
  input: TimelineModelInput,
  visible: readonly Entry[],
  visibleStart = model.shown.length - visible.length,
): TimelineModel {
  let prefixStart = visibleStart;
  while (prefixStart > 0 && model.shown[prefixStart - 1]?.kind !== "user") prefixStart -= 1;
  if (prefixStart > 0) prefixStart -= 1;
  const precedingTurn = model.shown.slice(prefixStart, visibleStart);
  const derivedEntries = precedingTurn.length ? [...precedingTurn, ...visible] : visible;
  return finishTimelineModel(model.shown, input, {
    handoffNoticeByRun: model.handoffNoticeByRun,
    runsById: model.runsById,
    streamingRunId: model.streamingRunId,
    turnTimeByRun: model.turnTimeByRun,
    eventsByRun: model.eventsByRun,
  }, derivedEntries);
}

type CachedBlock = {
  deps: unknown[];
  /** The approval requests read by the merge: the block stays valid as long as they are the same objects. */
  approvalRefs: Array<readonly [string, ApprovalRequestDto | undefined]>;
  entries: Entry[];
  placed: string[];
  orphanPlan: OrphanTrail | null;
  orphanSearch: OrphanTrail | null;
  turnTime: string | undefined;
};

function pushMessageDeps(deps: unknown[], message: TimelineUserInput, plan: BlockPlan): void {
  const persisted = plan.persistedById.get(message.id);
  const steering = plan.steeringOf(message.runId);
  deps.push(
    message.id,
    message.text,
    message.runId,
    message.runId ? plan.runsById.get(message.runId)?.routineId ?? null : null,
    message.createdAt,
    message.authorBot ?? null,
    persisted?.replyTo ?? null,
    persisted?.reactions ?? null,
    steering.steeredIntoActive,
    steering.steeredIntoSettled,
  );
  // Chips element by element: `conversation.tsx` refilters `content` on every
  // `messages` change, the array is new but its parts are the same.
  if (message.attachments === undefined) deps.push(-1);
  else deps.push(message.attachments.length, ...message.attachments);
}

/**
 * Everything a block's construction reads, compared by identity. A run's
 * event bucket only grows (see `syncEvents`): its
 * reference and its length are enough.
 */
function blockDeps(block: TimelineBlock, plan: BlockPlan, eventsByRun: EventsByRun, input: TimelineModelInput): unknown[] {
  const deps: unknown[] = [block.kind];
  if (block.kind === "message") {
    pushMessageDeps(deps, block.message, plan);
    return deps;
  }
  const bucket = eventsByRun.get(block.runId);
  deps.push(
    block.runId,
    plan.runsById.get(block.runId)?.routineId ?? null,
    plan.runsById.get(block.runId)?.createdAt,
    bucket,
    bucket?.length ?? 0,
    input.toolFallbackLabel,
    input.runAuthors?.get(block.runId) ?? null,
    plan.assistantMessageByRun.get(block.runId) ?? null,
  );
  if (block.kind === "run") {
    const runMessages = plan.messagesByRun.get(block.runId) ?? [];
    deps.push(runMessages.length);
    for (const message of runMessages) pushMessageDeps(deps, message, plan);
    const steered = plan.steeredMessagesByTarget.get(block.runId) ?? [];
    deps.push(steered.length);
    for (const message of steered) pushMessageDeps(deps, message, plan);
  }
  return deps;
}

/** Is `previous` `events` from `offset` on, object by object? */
function sameEventIdentity(
  events: readonly StoredProductEvent[],
  previous: readonly StoredProductEvent[],
  offset: number,
): boolean {
  for (let index = 0; index < previous.length; index += 1) {
    if (events[offset + index] !== previous[index]) return false;
  }
  return true;
}

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function buildBlock(
  block: TimelineBlock,
  deps: unknown[],
  plan: BlockPlan,
  eventsByRun: EventsByRun,
  input: TimelineModelInput,
  approvalsById: ReadonlyMap<string, ApprovalRequestDto>,
): CachedBlock {
  const runEvents = block.kind === "message" ? [] : eventsByRun.get(block.runId) ?? [];
  const approvalRefs: CachedBlock["approvalRefs"] = [];
  const placed = new Set<string>();
  const entries = mergeTimelineEntries(blockEntries(block, plan, eventsByRun), {
    tools: indexToolEvents(runEvents),
    passedRuns: passedRunIds(runEvents),
    approval: (id) => {
      const approval = approvalsById.get(id);
      approvalRefs.push([id, approval]);
      return approval;
    },
    placed,
    runAuthors: input.runAuthors,
    assistantMessageByRun: plan.assistantMessageByRun,
    toolFallbackLabel: input.toolFallbackLabel,
  });
  const { orphanPlans, orphanSearches } = insertRunTrails(entries, collectRunTrails(runEvents));
  return {
    deps,
    approvalRefs,
    entries,
    placed: [...placed],
    orphanPlan: orphanPlans[0] ?? null,
    orphanSearch: orphanSearches[0] ?? null,
    turnTime: runTurnTime(runEvents),
  };
}

/** Several unanchored runs: the same order as the full thread, that of their first carrying event. */
function sortByEventOrder(orphans: OrphanTrail[], events: readonly StoredProductEvent[]): void {
  if (orphans.length < 2) return;
  const position = new Map(events.map((event, index) => [event, index]));
  orphans.sort((left, right) => position.get(left.first)! - position.get(right.first)!);
}

export type TimelineModelBuilder = (
  input: TimelineModelInput,
  options?: { deferDerived?: boolean },
) => TimelineModel;

/**
 * The incremental model: the same output as `buildTimelineModel`, but only
 * the blocks whose dependency changed are rebuilt. An unchanged block's
 * entries are the SAME objects from one pass to the next: the
 * signatures (`entrySignature`) and the per-entry memoized splits hold.
 */
export function createTimelineModelBuilder(): TimelineModelBuilder {
  let source: readonly StoredProductEvent[] | null = null;
  // Buckets per run. Two growths keep them:
  // - tail (identical prefix, element by element): `push`;
  // - an older page (the old array is a suffix by identity):
  //   `unshift` on the page's runs, the other buckets stay the same
  //   objects. A replacement, a truncation, or an array copied element
  //   by element starts over from zero, which invalidates the blocks.
  let buckets = new Map<string, StoredProductEvent[]>();
  let handoffNoticeByRun: ReadonlyMap<string, HandoffDirectiveNotice> = new Map();
  const blocks = new Map<string, CachedBlock>();
  // The previous pass's block plan, reused while the thread's structure
  // does not move: a delta no longer reparses the dates or re-sorts the
  // blocks of the whole loaded thread.
  let previousInput: TimelineModelInput | null = null;
  let previousPlan: BlockPlan | null = null;
  // A new bucket, a page prepended, or a rebuild changes the
  // blocks themselves: the plan is then recomputed.
  let bucketsReshaped = true;
  // The runs whose bucket grew or whose row changed since the previous
  // pass. Only their blocks recompute their dependencies.
  const touchedRuns = new Set<string>();

  const pushBucket = (event: StoredProductEvent, where: "push" | "unshift") => {
    // Same filter as `buildTimelineModel`. A `message.admitted` committed
    // after the first provisional delta (published before its commit) used to fall
    // between two fragments of the same run: it broke their merge, and the
    // answer displayed as several bubbles.
    if (isMetadataReceipt(event)) return;
    const bucket = buckets.get(event.runId);
    if (!bucket) {
      buckets.set(event.runId, [event]);
      bucketsReshaped = true;
    } else if (where === "push") bucket.push(event);
    else {
      bucket.unshift(event);
      bucketsReshaped = true;
    }
    touchedRuns.add(event.runId);
  };

  const absorbTail = (events: readonly StoredProductEvent[], from: number) => {
    let notices = from === 0;
    for (let index = from; index < events.length; index += 1) {
      const event = events[index]!;
      pushBucket(event, "push");
      if (event.type === "system.notice") notices = true;
    }
    // Hand-off notices spill onto the previous run: their fallback
    // stays global, but only a new notice can change the result.
    if (notices) handoffNoticeByRun = handoffDirectiveNotices(withoutReceipts(events));
  };

  const syncEvents = (events: readonly StoredProductEvent[]) => {
    if (events === source) return;
    const previous = source;
    // An SSE patch appends an event at the tail: the link the patch sets
    // proves "same objects in front" without walking the thread's N elements.
    if (
      previous
      && events.length >= previous.length
      && (eventsAppendedFrom(events) === previous || sameEventIdentity(events, previous, 0))
    ) {
      if (previous.length === 0) {
        buckets = new Map();
        bucketsReshaped = true;
      }
      absorbTail(events, previous.length);
      source = events;
      return;
    }
    // An older page prepended. The old array is the suffix:
    // already-built buckets are not overwritten. A notice in the page
    // (or in front of a notice already seen) can reattach the hand-off to another
    // run: the map is recomputed, not the blocks.
    if (
      previous
      && previous.length > 0
      && events.length > previous.length
      && sameEventIdentity(events, previous, events.length - previous.length)
    ) {
      for (let index = events.length - previous.length - 1; index >= 0; index -= 1) {
        pushBucket(events[index]!, "unshift");
      }
      handoffNoticeByRun = handoffDirectiveNotices(withoutReceipts(events));
      source = events;
      return;
    }
    buckets = new Map();
    bucketsReshaped = true;
    absorbTail(events, 0);
    source = events;
  };

  const build = (input: TimelineModelInput, options?: { deferDerived?: boolean }): TimelineModel => {
    syncEvents(input.events);
    const eventsByRun: EventsByRun = buckets;
    const reused = previousInput && previousPlan && !bucketsReshaped
      ? reusablePlan(previousInput, previousPlan, input, touchedRuns)
      : null;
    const plan = reused ?? planTimelineBlocks(input, eventsByRun);
    previousPlan = plan;
    const approvalsById = new Map(input.approvals.map((approval) => [approval.id, approval]));
    const seen = new Set<string>();
    const shown: Entry[] = [];
    const placed = new Set<string>();
    let duplicateApproval = false;
    const orphanPlans: OrphanTrail[] = [];
    const orphanSearches: OrphanTrail[] = [];
    const turnTimeByRun = new Map<string, string>();
    for (const block of plan.blocks) {
      let cached = blocks.get(block.id);
      // Reused plan, intact run, same requests: its dependencies are
      // those of the previous pass, no need to rebuild them.
      const clean = reused !== null
        && cached !== undefined
        && !seen.has(block.id)
        && (block.kind === "message" || !touchedRuns.has(block.runId))
        && !cached.approvalRefs.some(([id, approval]) => approvalsById.get(id) !== approval);
      if (!clean) {
        const deps = blockDeps(block, plan, eventsByRun, input);
        if (
          !cached
          || seen.has(block.id)
          || !sameDeps(cached.deps, deps)
          || cached.approvalRefs.some(([id, approval]) => approvalsById.get(id) !== approval)
        ) {
          cached = buildBlock(block, deps, plan, eventsByRun, input, approvalsById);
          blocks.set(block.id, cached);
        }
      }
      if (!cached) throw new Error("timeline block missing");
      seen.add(block.id);
      for (const entry of cached.entries) shown.push(entry);
      for (const id of cached.placed) {
        if (placed.has(id)) duplicateApproval = true;
        placed.add(id);
      }
      if (cached.orphanPlan) orphanPlans.push(cached.orphanPlan);
      if (cached.orphanSearch) orphanSearches.push(cached.orphanSearch);
      if (block.kind !== "message" && cached.turnTime !== undefined) turnTimeByRun.set(block.runId, cached.turnTime);
    }
    for (const id of blocks.keys()) if (!seen.has(id)) blocks.delete(id);
    // The same request anchored in two runs (corrupt replay): only the
    // first counts, which depends on the global order. Pathological case,
    // handled by the full rebuild.
    if (duplicateApproval) return buildTimelineModel(input);
    sortByEventOrder(orphanPlans, input.events);
    sortByEventOrder(orphanSearches, input.events);
    for (const { entry } of orphanPlans) shown.push(entry);
    for (const { entry } of orphanSearches) shown.push(entry);
    for (const approval of input.approvals) {
      if (!placed.has(approval.id)) shown.push({ kind: "gate", key: `approval:${approval.id}`, approval });
    }
    return finishTimelineModel(shown, input, {
      handoffNoticeByRun,
      runsById: plan.runsById,
      streamingRunId: streamingRunOf(input.running, input.events, eventsByRun, plan.runsById),
      turnTimeByRun,
      eventsByRun,
    }, options?.deferDerived ? [] : undefined);
  };

  return (input, options) => {
    try {
      return build(input, options);
    } catch (error) {
      previousPlan = null;
      throw error;
    } finally {
      previousInput = input;
      bucketsReshaped = false;
      touchedRuns.clear();
    }
  };
}

/**
 * The previous plan still holds if only already-known runs changed
 * row (status, timestamp) without touching steering: same messages, same
 * run order, no absorbed or absorbing run modified. Otherwise `null`, and the
 * plan is recomputed.
 */
function reusablePlan(
  previous: TimelineModelInput,
  plan: BlockPlan,
  input: TimelineModelInput,
  touchedRuns: Set<string>,
): BlockPlan | null {
  if (
    previous.userInputs !== input.userInputs
    || previous.messages !== input.messages
    || previous.runAuthors !== input.runAuthors
    || previous.toolFallbackLabel !== input.toolFallbackLabel
  ) return null;
  if (previous.runs === input.runs) return plan;
  if (previous.runs.length !== input.runs.length) return null;
  const absorbing = new Set(plan.steeredIntoRun.values());
  for (let index = 0; index < input.runs.length; index += 1) {
    const before = previous.runs[index]!;
    const after = input.runs[index]!;
    if (before === after) continue;
    if (before.id !== after.id || isAbsorbedRun(before) || isAbsorbedRun(after) || absorbing.has(after.id)) return null;
    touchedRuns.add(after.id);
  }
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  return { ...plan, runsById, steeringOf: steeringResolver(runsById, plan.steeredIntoRun) };
}
