/**
 * The events `(from, to]` will not be rendered on this connection: the
 * client rereads thread, roster and mail over HTTP.
 *
 * - without `reason`: announced at the head of the stream, the replay bound raised the
 *   requested cursor;
 * - `slow_consumer`: last frame before close, the client was not reading
 *   fast enough. It reconnects at its cursor (`from`), the replay returns what
 *   still fits in the window.
 */
export type StreamGap = { organizationId: string; from: number; to: number; reason?: "slow_consumer" };

/**
 * Stream filtered by thread (`?threadId=`): the server dropped, for lack of a matching
 * filter, everything up to and including `cursor`. Carries `id:`: the
 * resume cursor advances with no event rendered, and a reconnect does not
 * replay (nor announce as a gap) what did not concern this client.
 */
export type StreamCursor = { organizationId: string; cursor: number };

/**
 * Control frame `runtime.changed` (rework-flux-api step 5a): something
 * `GET /api/runtime` reports changed (link state, activation, a preference).
 * Not an event of the log: no cursor, no `id:`, never replayed; the client
 * rereads the runtime, and a stream (re)opened rereads it anyway.
 *
 * It carries NO `organizationId`: the stream is already the organization's,
 * and a client from before this frame drops any frame whose
 * `organizationId` is not its own, so it ignores this one without error.
 * `runtimeId` is null when several changed (coalesced) or on a resync.
 */
export const RUNTIME_CHANGED_FRAME = "runtime.changed";
export type RuntimeChangedFrame = { runtimeId: string | null; reason: "changed" | "resync" };

export function readRuntimeChangedFrame(data: unknown): RuntimeChangedFrame | null {
  if (typeof data !== "object" || data === null) return null;
  const { runtimeId, reason } = data as { runtimeId?: unknown; reason?: unknown };
  if (runtimeId !== null && typeof runtimeId !== "string") return null;
  if (reason !== "changed" && reason !== "resync") return null;
  return { runtimeId, reason };
}

/** Two pending frames make one: the same runtime keeps its id, several do not. */
export function mergeRuntimeChangedFrames(pending: RuntimeChangedFrame | null, next: RuntimeChangedFrame): RuntimeChangedFrame {
  if (!pending) return next;
  return {
    runtimeId: pending.runtimeId !== null && pending.runtimeId === next.runtimeId ? pending.runtimeId : null,
    reason: pending.reason === "resync" || next.reason === "resync" ? "resync" : "changed",
  };
}

/**
 * Envelope version. Absent: old frame, with no
 * bot/turn/session/lease identity. A client tolerates any version and ignores the fields
 * it does not know.
 */
export const EVENT_ENVELOPE_VERSION = 1;

/**
 * The single envelope of a produced event: the same on live push, on SSE
 * replay and in the worker hint (`POST /internal/events/publish`). Built by
 * `organizationEventEnvelope` and nowhere else.
 *
 * - `cursor`: position in the ORGANIZATION stream, allocated at commit under
 *   the `openedbot-run-events-cursor` lock; it is the resume cursor
 *   (`?cursor=` / `Last-Event-ID`), strictly increasing per connection.
 *   Absent until the row is committed: a frame pushed before
 *   the INSERT has no cursor, and the SSE does not put an `id:` field on it.
 * - `sequence`: position in the RUN, unique with `runId`; a replay of the
 *   same `(runId, sequence)` is absorbed (`on conflict do nothing`), including
 *   a terminal. It is the idempotence key before a cursor exists.
 * - `turnId`: the user turn. `workflows.root_run_id` for a workflow
 *   step, otherwise the run's own id (see `runTurnId`).
 * - `sessionKey`: the run's Hermes session key (`openedbot:{org}:…`), a
 *   structural identifier, never a secret.
 * - `leaseGeneration`: the lease under which the row was written; `null` for
 *   a row older than 0092.
 *
 * The identity fields are optional in the types: a client must read a
 * frame from before version 1 without crashing.
 */
export type OrganizationEvent<T = Record<string, unknown>> = {
  version?: typeof EVENT_ENVELOPE_VERSION;
  /** Absent before the commit: the cursor does not exist yet. */
  cursor?: number;
  organizationId: string;
  threadId: string | null;
  runId: string;
  botId?: string | null;
  turnId?: string | null;
  sessionKey?: string | null;
  leaseGeneration?: number | null;
  sequence: number;
  type: string;
  payload: T;
  occurredAt: string;
};

/**
 * A `run_events` row as a `returning` or a `select` returns it
 * (`bigint` cursor as a string, timestamp as a `Date`).
 */
export type RunEventRecord<T = Record<string, unknown>> = {
  /** Absent: live envelope, before the INSERT allocates the cursor. */
  cursor?: number | string | bigint | null;
  organizationId: string;
  threadId: string | null;
  runId: string;
  botId: string | null;
  turnId: string | null;
  sessionKey: string | null;
  leaseGeneration: number | string | bigint | null;
  sequence: number;
  type: string;
  payload: T;
  occurredAt: Date | string;
};

/**
 * The only envelope factory. The key order is fixed: a committed
 * row comes out identical to the post-commit push and to the replay. Without a cursor
 * (before the INSERT), `cursor` is omitted. `completion` is set on replay only.
 */
export function organizationEventEnvelope<T>(record: RunEventRecord<T>): OrganizationEvent<T> {
  const cursor = record.cursor === null || record.cursor === undefined ? null : Number(record.cursor);
  const committed = cursor !== null && Number.isSafeInteger(cursor);
  return {
    version: EVENT_ENVELOPE_VERSION,
    ...(committed ? { cursor } : {}),
    organizationId: record.organizationId,
    threadId: record.threadId,
    runId: record.runId,
    botId: record.botId ?? null,
    turnId: record.turnId ?? null,
    sessionKey: record.sessionKey ?? null,
    leaseGeneration: record.leaseGeneration === null || record.leaseGeneration === undefined
      ? null
      : Number(record.leaseGeneration),
    sequence: Number(record.sequence),
    type: record.type,
    payload: record.payload,
    occurredAt: record.occurredAt instanceof Date
      ? record.occurredAt.toISOString()
      : new Date(record.occurredAt).toISOString(),
  };
}

/**
 * A run's turn, the same rule as the `run_events_stamp_identity` trigger
 * (0092): `coalesce(workflows.root_run_id, runs.id)`. The root run's id
 * rather than the ingress message's: routines, hand-offs and mail
 * have no message, and a DM without a workflow has as its root run the
 * same run `message_ingress.run_id` reserves, so the turn does not change
 * when the workflow disappears.
 */
export function runTurnId(run: { runId: string; workflowRootRunId: string | null }): string {
  return run.workflowRootRunId ?? run.runId;
}

export type ProductEventType =
  | "message.admitted"
  | "run.steering"
  | "agent.message"
  | "agent.reasoning"
  | "tool.call"
  | "tool.result"
  /**
   * US-CHAT-07: the real content of a result, collected AFTER the run by
   * `listHermesSessionMessages`; `tool.result` (above) only
   * marks a call as finished, with no payload (MEASURED, see
   * `hermes-events.ts`). A distinct event rather than a rewrite of
   * `tool.result`: `run_events` has no update semantics, and an
   * already connected client ignores every event whose cursor is not
   * strictly increasing (`applyProductEventToSnapshot`): a row
   * modified in place would never reach it.
   */
  | "tool.result.attached"
  | "approval.requested"
  | "approval.responded"
  | "run.completed"
  | "run.error"
  | "run.provider_fallback"
  | "system.notice"
  /**
   * Bot mode: another bot's reply has just been deposited in this thread
   * (`payload: { messageId, fromBotId, fromSlug, fromName, text, ok }`).
   * Emitted by the worker, on the origin thread's « courrier » run. The
   * message itself lives in `messages` (role `user` + `authorBot`): it is
   * the row that is displayed; this event is the signal that tells the client
   * to reread the thread, and it is not rendered.
   */
  | "bot.message"
  | "raw";

/**
 * The `tool.result` payload as the worker writes it (`hermes-events.ts`,
 * `tool.completed`). Every field is optional for a reader: rows written by
 * an older worker lack the newer ones, and a client never infers a value
 * from an absent field.
 *
 * `resultExcerpt` is the runtime's bounded, secret-redacted preview of the
 * tool output (upstream caps it at 500 characters). It arrives live, as the
 * call completes, long before `tool.result.attached` brings the full
 * transcript at the end of the run.
 */
export type ToolResultEventPayload = {
  toolCallId?: string;
  tool?: string;
  durationMs?: number | null;
  error?: boolean;
  errorMessage?: string | null;
  resultExcerpt?: string | null;
  hasResultPayload?: boolean;
  agentPlan?: unknown;
  webSearch?: unknown;
};

export type ProductEventInput = {
  sequence: number;
  type: ProductEventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

export type StoredProductEvent = ProductEventInput & {
  cursor: number;
  runId: string;
};
