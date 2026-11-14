import type { OrganizationEvent, StoredProductEvent } from "@openedbot/contracts-events";
import type { RunDto, WorkflowDto } from "../execution/runs";
import type { BotFaceSpec } from "../shared/bot-face";
import type { MessageContent } from "../shared/domain";

/**
 * The author of a message when it is not the operator but ANOTHER bot
 * (bot mode, hand-off). `name`/`slug`/`face` are reread at read
 * time; null if the bot has been deleted since: the attribution
 * itself survives (the `id` remains).
 */
export type MessageAuthorBot = {
  id: string;
  name: string | null;
  slug: string | null;
  face: BotFaceSpec | null;
};

export type MessageReactionDto = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
};

export type MessageReplyPreview = {
  id: string;
  role: "user" | "assistant";
  content: MessageContent;
  authorBot?: MessageAuthorBot | null;
};

export type ThreadMessageDto = {
  id: string;
  /** Stable per-thread ordering across pages; string preserves PostgreSQL bigint. */
  sequence?: string;
  /** Correlates this operator's optimistic send with its persisted message. */
  clientSubmissionId?: string | null;
  role: "user" | "assistant";
  content: MessageContent;
  runId: string | null;
  createdAt: string;
  /**
   * Set when the message was written by another bot. A `user` with
   * `authorBot` renders as a bubble of the author bot, never as the
   * operator's. Optional: older fixtures stay valid.
   */
  authorBot?: MessageAuthorBot | null;
  /** Flat reply: a preview of the target, without creating a nested sub-thread. */
  replyTo?: MessageReplyPreview | null;
  /** Aggregate per emoji; `reactedByMe` makes add/remove idempotent on the client side. */
  reactions?: MessageReactionDto[];
};

/**
 * Everything the conversation view needs to know, in one read.
 *
 * `cursor` is the highest event cursor already applied: it is what
 * lets SSE resume without replaying, and lets `applyProductEventToSnapshot`
 * ignore an event already seen.
 */
/** A group's room, as seen from the thread: enough to name and draw its members. */
export type ThreadGroupInfo = {
  id: string;
  name: string;
  members: Array<{ id: string; name: string; slug: string; face: BotFaceSpec | null; voiceId: string | null }>;
};

export type ThreadSnapshot = {
  id: string;
  /** `null` for a group's room: see `group`. */
  botId: string | null;
  title: string;
  botName: string | null;
  /** Set on a group's room; absent/`null` on a DM thread. */
  group?: ThreadGroupInfo | null;
  /** Room summary: `null` if it has never been compacted. Absent on an older API. */
  compaction?: ThreadCompactionDto | null;
  instructions: string;
  model: string;
  /** Model resolved at read time (the bot's setting, otherwise the runtime default). */
  effectiveModel: string;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessageDto[];
  runs: RunDto[];
  /**
   * The same envelope as the SSE stream (`organizationEventEnvelope`);
   * identity is absent on an older API.
   */
  events: Array<StoredProductEvent & Partial<Pick<OrganizationEvent,
    "version" | "organizationId" | "threadId" | "botId" | "turnId" | "sessionKey" | "leaseGeneration">>>;
  /** Optional, to preserve compatibility with older clients. */
  workflows?: WorkflowDto[];
  cursor: number;
  /**
   * `max(cursor)` of the ORGANIZATION, read in the same transaction as this
   * snapshot. It is the attach point of the SSE stream: starting from it, there is nothing
   * to replay by construction. `cursor` above is the thread's: a thread
   * idle for ten days would replay everything the organization has
   * produced since. Absent on an older API: fall back to `cursor`.
   */
  organizationCursor?: number;
  /**
   * The thread exceeds what one read returns from the database
   * (`THREAD_SNAPSHOT_LIMITS`, API side): the OLDEST runs and messages
   * are not here. Never silent: the interface says so, otherwise
   * a truncated thread reads as a complete thread.
   */
  truncated: boolean;
  /**
   * Older transcript pages use their own cursor, independent of live SSE.
   * Initial page can also include an old active workflow: merge row IDs across pages.
   */
  history?: {
    nextBefore: string | null;
    hasMore: boolean;
    turnKeys: string[];
  };
};

/**
 * `POST /api/threads/:id/messages` 202. A previous server only returned
 * `runId` / `workflowId` / `status`. `message` (and `run` when a new run was
 * created) let the client patch the snapshot instead of rereading the thread.
 * `workflowId` is null for a plain DM turn (no room, handoff or autonomy):
 * such a turn has no workflow, and `workflow` is then absent.
 */
export type SendMessageAccepted = {
  runId: string;
  workflowId: string | null;
  status: string;
  notificationEligible?: boolean;
  workflowUpdatedAt?: string;
  steerTargetRunId?: string;
  supersededRunId?: string;
  foldedIntoRunId?: string;
  message?: ThreadMessageDto;
  run?: RunDto;
  workflow?: WorkflowDto;
  events?: StoredProductEvent[];
};

/**
 * How far a room's history is summarized (DEV-331/332). A single row per
 * thread, shared by every member: `ThreadSnapshot.compaction` is `null` until
 * the room has been compacted.
 */
export type ThreadCompactionDto = {
  /** Sequence of the last message folded into the summary. */
  compactedThroughSequence: number;
  /** Instant of the last compaction (ISO 8601 UTC). */
  compactedAt: string;
};

/** Response of `POST /api/threads/:threadId/compact`: the room was summarized. */
export type ThreadCompactResult = {
  /** Always `true`: a summary that changed nothing answers with a readable error. */
  compacted: true;
  /** Messages folded into the summary by THIS call. */
  summarizedCount: number;
  compactedThroughSequence: number;
  compactedAt: string;
};

/**
 * Minimum threshold of « Compacter l'historique du salon », in characters of text
 * not yet summarized: the recent queue (KEEP) that compaction never folds,
 * that is 35% of `HISTORY_CHAR_BUDGET` (48 000). Below that, everything fits in the
 * queue and there is nothing to fold. The server stays the authority (422); the console
 * uses it only to disable the button with the reason. A test in
 * `modules/conversation` keeps this value equal to the domain's.
 */
export const ROOM_COMPACT_MIN_CHARS = 16_800;
