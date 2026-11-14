import { isUuid } from "@openedbot/contracts-primitives";
import { hasLiveWorkspaceSession } from "@openedbot/identity/application/session-access";
import { Hono } from "hono";
import {
  organizationEventEnvelope,
  type OrganizationEvent,
  type RunEventRecord,
} from "@openedbot/contracts-events";
import { createRuntimeChangedWriter, serializeCursor, serializeGap } from "./sse-frames";
import {
  DEFAULT_EVENTS_FALLBACK_POLL_MS,
  DEFAULT_EVENTS_REPLAY_WINDOW_EVENTS,
  DEFAULT_EVENTS_REPLAY_WINDOW_MS,
  type EventsConfig,
} from "../../infrastructure/config";
import { matchInternalBearer, type InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import { internalAuthMetrics } from "@openedbot/platform-observability/internal-auth";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { attachTerminalCompletions } from "@openedbot/execution/application/terminal-event-completion";
import { logger } from "@openedbot/platform-observability";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../../interfaces/http/sse-heartbeat";
export { serializeCursor, serializeGap } from "./sse-frames";
import {
  acquireReplayPoller,
  REPLAY_LIMIT,
  shouldEmitSseCursor,
  wakeReplayPoller,
  type CursoredEvent,
} from "./replay-pollers";

export { SSE_HEARTBEAT_INTERVAL_MS };
export { createOrderedReplayPump, shouldEmitSseCursor, type CursoredEvent, type OrderedReplayPump } from "./replay-pollers";

/**
 * Threshold (in bytes) of a connection's queue. Replay waits until it
 * drops back under before each frame: it never deposits more than this threshold
 * plus one frame, whatever the replayed volume.
 */
export const SSE_QUEUE_HIGH_WATER_BYTES = 64 * 1024;
/**
 * Ceiling of this queue for the live push, which cannot wait: beyond it,
 * the client is slow, receives `stream.gap` (`slow_consumer`), and the connection
 * closes. A single frame larger than that passes if the queue is empty.
 *
 * Under `Bun.serve` (1.3.14, measured), the response empties this queue into a native
 * buffer without looking at the socket: `desiredSize` stays at the threshold even facing
 * a blocked TCP peer. The ceiling bounds the JS queue and every JS consumer
 * (compression, JS proxy, tests); the native buffer, for its part, is bounded only
 * by `idleTimeout`, which cuts the stream.
 */
export const SSE_MAX_QUEUED_BYTES = 1024 * 1024;
/**
 * Events held in memory for lack of being writable (live arrived
 * during replay or during the access check): same cutoff beyond.
 */
export const SSE_MAX_PENDING_EVENTS = 1_000;

type SlowConsumerReason = "queue_bytes" | "replay_buffer" | "access_buffer";

/** Live frames memorized per connection so their commit is not replayed. */
export const SSE_MAX_LIVE_PUSHED = 2_048;

/**
 * Identity of a `run_events` row as seen from a frame, live or committed: run,
 * lease, sequence, and type. The lease distinguishes two writes of the same sequence
 * by two successive holders.
 */
export function rowIdentity(event: OrganizationEvent): string {
  return `${event.runId}:${event.leaseGeneration ?? ""}:${event.sequence}:${event.type}`;
}

/** Threads at most per `?threadId=`: beyond that, the whole organization stream costs less. */
export const SSE_MAX_THREAD_FILTER = 50;

let slowConsumerClosures = 0;

/** Connections closed for slowness since process start. */
export function sseSlowConsumerClosures(): number {
  return slowConsumerClosures;
}

/**
 * Default stream settings, identical to those of `readEventsConfig`: the
 * tests and any caller without config read the same values as prod.
 */
const DEFAULT_EVENTS: EventsConfig = {
  fallbackPollMs: DEFAULT_EVENTS_FALLBACK_POLL_MS,
  replayWindowMs: DEFAULT_EVENTS_REPLAY_WINDOW_MS,
  replayWindowEvents: DEFAULT_EVENTS_REPLAY_WINDOW_EVENTS,
};


export function eventRoutes(
  db: Db,
  hub: EventHub,
  events: EventsConfig = DEFAULT_EVENTS,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/", async (context) => {
    const auth = context.get("auth");
    const organizationId = auth.organizationId;
    const queryCursor = Number(context.req.query("cursor") ?? context.req.header("Last-Event-ID") ?? "0");
    if (!Number.isSafeInteger(queryCursor) || queryCursor < 0) {
      throw new HttpError(400, "CURSOR_INVALID", "Le curseur SSE est invalide.");
    }
    const threadFilter = readThreadFilter(context.req.queries("threadId"));

    let cursor = queryCursor;
    // Highest cursor received for this client, rendered or not: the `to` bound
    // of a `slow_consumer` gap.
    let newestSeen = queryCursor;
    // Highest cursor dropped by the thread filter: announced by
    // `stream.cursor` so resumption does not rescan what was dropped.
    let skippedCursor = 0;
    // Advances without waiting for the heartbeat as soon as the gap would eat half
    // of the replay window: otherwise a resumption of this client would fall under
    // the floor and receive a `stream.gap` for threads that are not
    // its own.
    const cursorAdvanceEvents = Math.max(1, Math.floor(events.replayWindowEvents / 2));
    // Last-Event-ID is the last frame the client has confirmed. Replaying an
    // overlap here made a late poller frame emit a lower `id:` after a newer
    // one; replay strictly after the requested cursor keeps the SSE sequence
    // monotonic. A cursor at zero no longer replays the whole retained history:
    // it is brought back to a recent window (see `effectiveReplayCursor`).
    const sentCursors = new Set<number>();
    // Live frames (no cursor) already written on THIS connection, by
    // row identity. The committed replay of one of these frames reduces to
    // advancing the cursor. Private to the connection: a resumption
    // or a connection opened between the push and the commit has none of them and
    // receives the full frame. Bounded; an evicted entry costs a duplicate
    // that the console absorbs, never a loss.
    const livePushed = new Set<string>();
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let unsubscribeRuntime = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let releaseReplayPoller = () => {};
    let closed = false;
    let checkingAccess = false;
    let replaying = true;
    const accessBuffer: OrganizationEvent[] = [];
    // Subscribe BEFORE taking the replay watermark. While replay is in
    // progress, buffer live frames so a newer cursor cannot make `push`
    // suppress older replay frames. This also closes the gap when another
    // connection already owns (and advances) the organization's poller.
    const buffered: OrganizationEvent[] = [];
    let accessTimer: ReturnType<typeof setInterval> | null = null;
    let wakeReplay: (() => void) | null = null;

    const cleanup = () => {
      closed = true;
      accessBuffer.length = 0;
      buffered.length = 0;
      unsubscribe();
      unsubscribeRuntime();
      unsubscribe = unsubscribeRuntime = () => {};
      releaseReplayPoller();
      releaseReplayPoller = () => {};
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (accessTimer) clearInterval(accessTimer);
      accessTimer = null;
      wakeReplay?.();
      wakeReplay = null;
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: string) => controller.enqueue(encoder.encode(frame));
        const queuedBytes = () => SSE_QUEUE_HIGH_WATER_BYTES - (controller.desiredSize ?? SSE_QUEUE_HIGH_WATER_BYTES);
        const accepts = (event: OrganizationEvent) => {
          if (matchesThreadFilter(threadFilter, event)) return true;
          if (typeof event.cursor === "number" && Number.isSafeInteger(event.cursor)) {
            skippedCursor = Math.max(skippedCursor, event.cursor);
          }
          if (skippedCursor - cursor >= cursorAdvanceEvents) advanceSkippedCursor();
          return false;
        };
        // Only outside replay and outside the access check: nothing accepted and
        // older is then waiting to be written, advancing the cursor
        // past that skips no event of this client.
        const advanceSkippedCursor = () => {
          if (closed || replaying || checkingAccess || skippedCursor <= cursor) return false;
          if (queuedBytes() >= SSE_QUEUE_HIGH_WATER_BYTES) return false;
          cursor = skippedCursor;
          write(serializeCursor({ organizationId, cursor }));
          return true;
        };
        const noteSeen = (event: OrganizationEvent) => {
          if (typeof event.cursor === "number" && Number.isSafeInteger(event.cursor)) {
            newestSeen = Math.max(newestSeen, event.cursor);
          }
        };
        // Never a silent loss: what is already queued leaves, then the gap
        // `(cursor, newestSeen]`, then the end of the stream. The client reconnects
        // at its cursor and replay resumes.
        const closeSlowConsumer = (reason: SlowConsumerReason) => {
          if (closed) return;
          const queued = queuedBytes();
          const pendingEvents = accessBuffer.length + buffered.length;
          const from = cursor;
          const to = newestSeen;
          if (to > from) write(serializeGap({ organizationId, from, to, reason: "slow_consumer" }));
          slowConsumerClosures += 1;
          logger.warn({
            event: "sse.slow_consumer_closed",
            organizationId,
            reason,
            queuedBytes: queued,
            pendingEvents,
            from,
            to,
            closedTotal: slowConsumerClosures,
          }, "sse slow consumer closed");
          cleanup();
          controller.close();
        };
        write(": connected\n\n");
        // `runtime.changed`: outside the log and the thread filter, from the first byte (replay included).
        const runtimeFrames = createRuntimeChangedWriter({ write, canWrite: () => !closed && !checkingAccess && queuedBytes() < SSE_QUEUE_HIGH_WATER_BYTES });
        unsubscribeRuntime = hub.subscribeRuntimeChanged(organizationId, runtimeFrames.offer);
        accessTimer = setInterval(() => {
          if (closed || checkingAccess) return;
          checkingAccess = true;
          void hasLiveWorkspaceSession(db, auth)
            .catch(() => false)
            .then((allowed) => {
              checkingAccess = false;
              if (!allowed && !closed) {
                write(`event: stream.revoked\ndata: ${JSON.stringify({ organizationId, code: "WORKSPACE_ACCESS_REVOKED" })}\n\n`);
                cleanup();
                controller.close();
              }
              else if (!closed) {
                for (const event of accessBuffer.splice(0)) push(event);
                advanceSkippedCursor();
                runtimeFrames.flush();
                wakeReplay?.();
                wakeReplay = null;
              }
            });
        }, 15_000);
        // `paced`: replay waited until the queue dropped back under the threshold, the
        // frame does not count against the ceiling (a replay too big for it
        // would otherwise loop reconnection and cutoff).
        const push = (event: OrganizationEvent, paced = false) => {
          if (closed || !accepts(event)) return;
          noteSeen(event);
          if (checkingAccess) {
            if (accessBuffer.length >= SSE_MAX_PENDING_EVENTS) closeSlowConsumer("access_buffer");
            else accessBuffer.push(event);
            return;
          }
          const durableCursor = committedCursor(event);
          if (durableCursor !== null && (sentCursors.has(durableCursor) || !shouldEmitSseCursor(durableCursor, cursor))) return;
          const identity = rowIdentity(event);
          if (durableCursor !== null && livePushed.delete(identity)) {
            // Already delivered live on this connection: only the cursor advances
            // (`stream.cursor` frame, at the pace of the thread filter and of the
            // heartbeat), in the poller's order.
            sentCursors.add(durableCursor);
            skippedCursor = Math.max(skippedCursor, durableCursor);
            // Same bound as the emitting path: a long-lived connection fed by
            // live frames must not keep one cursor per frame until it closes.
            const horizon = Math.max(cursor, skippedCursor) - REPLAY_LIMIT;
            for (const seen of sentCursors) {
              if (seen < horizon) sentCursors.delete(seen);
            }
            if (skippedCursor - cursor >= cursorAdvanceEvents) advanceSkippedCursor();
            return;
          }
          const frame = encoder.encode(serialize(event));
          const queued = queuedBytes();
          if (!paced && queued > 0 && queued + frame.byteLength > SSE_MAX_QUEUED_BYTES) {
            closeSlowConsumer("queue_bytes");
            return;
          }
          if (durableCursor !== null) {
            sentCursors.add(durableCursor);
            cursor = Math.max(cursor, durableCursor);
            for (const seen of sentCursors) {
              if (seen < cursor - REPLAY_LIMIT) sentCursors.delete(seen);
            }
          }
          controller.enqueue(frame);
          if (durableCursor === null) {
            livePushed.add(identity);
            if (livePushed.size > SSE_MAX_LIVE_PUSHED) livePushed.delete(livePushed.values().next().value!);
          }
        };
        // Neither a full queue, nor an access check in flight: replay would otherwise fill
        // `accessBuffer` up to the cutoff.
        const roomForReplay = async () => {
          while (!closed && (checkingAccess || (controller.desiredSize ?? 1) <= 0)) {
            await new Promise<void>((resolve) => { wakeReplay = resolve; });
          }
        };
        unsubscribe = hub.subscribe(organizationId, (event) => {
          if (!replaying) return push(event);
          if (!accepts(event)) return;
          noteSeen(event);
          if (buffered.length >= SSE_MAX_PENDING_EVENTS) closeSlowConsumer("replay_buffer");
          else buffered.push(event);
        });
        const open = async () => {
          const pollerCursor = await maxCursor(db, organizationId);
          const replayCursor = effectiveReplayCursor({
            requestedCursor: queryCursor,
            maxCursor: pollerCursor,
            oldestCursorInWindow: await oldestCursorSince(
              db,
              organizationId,
              new Date(Date.now() - events.replayWindowMs),
            ),
            windowEvents: events.replayWindowEvents,
          });
          cursor = Math.max(cursor, replayCursor);
          newestSeen = Math.max(newestSeen, cursor);
          // A client that had a position and that the bound jumps
          // forward learns it BEFORE the first event: it rereads what the
          // stream will not return to it (thread, roster, courier).
          const gap = replayGap(queryCursor, replayCursor);
          if (gap && !closed) write(serializeGap({ organizationId, ...gap }));
          await replayPagesUntil(
            replayCursor,
            pollerCursor,
            (pageCursor) => (closed ? Promise.resolve([]) : replay(db, organizationId, pageCursor)),
            async (event) => {
              await roomForReplay();
              push(event, true);
            },
          );
          if (closed) return;
          replaying = false;
          flushBufferedSseEvents(buffered, push);
          if (closed) return;
          advanceSkippedCursor();
          releaseReplayPoller = acquireReplayPoller(
            hub, organizationId, pollerCursor, (pageCursor) => replay(db, organizationId, pageCursor), events.fallbackPollMs,
          );
          heartbeat = setInterval(() => {
            if (closed || queuedBytes() >= SSE_QUEUE_HIGH_WATER_BYTES) return;
            // The access check falls at the same pace and may be in flight:
            // it then advances the cursor itself when it finishes.
            if (!advanceSkippedCursor() && !runtimeFrames.flush()) write(`: heartbeat ${Date.now()}\n\n`);
          }, SSE_HEARTBEAT_INTERVAL_MS);
        };
        // `start` returns at once: `pull` is called only once
        // `start` has resolved, and it is what wakes a waiting replay.
        void open().catch((error: unknown) => {
          cleanup();
          controller.error(error);
        });
      },
      pull() {
        wakeReplay?.();
        wakeReplay = null;
      },
      cancel() {
        cleanup();
      },
    }, { highWaterMark: SSE_QUEUE_HIGH_WATER_BYTES, size: (chunk) => chunk?.byteLength ?? 0 });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
  return routes;
}

/** Durable cursor, or `null` until the row is committed. */
export function committedCursor(event: { cursor?: number }): number | null {
  return typeof event.cursor === "number" && Number.isSafeInteger(event.cursor) ? event.cursor : null;
}

/**
 * Cursor from which to replay, whatever the client asks for.
 *
 * Two floors, and the higher one is kept: the oldest event of the
 * time window (itself replayed, hence the `- 1`) and the last N
 * events of the organization. With no non-empty window, nothing is replayed:
 * the client takes the stream where it stands. A requested cursor is never
 * lowered (replay stays strictly after it); if it is UNDER the floor,
 * it is raised and `replayGap` tells the client.
 */
export function effectiveReplayCursor(input: {
  requestedCursor: number;
  /** The organization's `max(cursor)` at connection time. */
  maxCursor: number;
  /** Smallest cursor whose `occurred_at` falls in the window; `null` if none. */
  oldestCursorInWindow: number | null;
  windowEvents: number;
}): number {
  const { requestedCursor, maxCursor, oldestCursorInWindow, windowEvents } = input;
  const timeFloor = oldestCursorInWindow === null ? maxCursor : oldestCursorInWindow - 1;
  const countFloor = maxCursor - Math.max(0, windowEvents);
  return Math.max(0, requestedCursor, timeFloor, countFloor);
}

export type StreamGap = { from: number; to: number };

/**
 * What the bound jumped over for a client that HAD a position. A
 * cursor at zero is not a position: that client has nothing and loads its
 * state over HTTP anyway: announcing a gap to it would only
 * trigger those same reads a second time.
 */
export function replayGap(requestedCursor: number, replayCursor: number): StreamGap | null {
  if (requestedCursor <= 0 || replayCursor <= requestedCursor) return null;
  return { from: requestedCursor, to: replayCursor };
}

/**
 * `?threadId=` repeated (UUID, at most `SSE_MAX_THREAD_FILTER`); absent:
 * `null`, the organization's whole stream. The filter only restricts
 * a stream already bounded to the organization: access stays that of the session.
 */
export function readThreadFilter(values: string[] | undefined): ReadonlySet<string> | null {
  if (!values || values.length === 0) return null;
  if (values.length > SSE_MAX_THREAD_FILTER || values.some((value) => !isUuid(value))) {
    throw new HttpError(400, "THREAD_FILTER_INVALID", "Le filtre de fils du flux est invalide.");
  }
  return new Set(values.map((value) => value.toLowerCase()));
}

/**
 * An event with no thread (`threadId: null`) concerns the whole organization and
 * passes every filter. `run_events.thread_id` being `not null` (0005), none
 * is produced today: the rule holds the contract, which admits it.
 */
export function matchesThreadFilter(filter: ReadonlySet<string> | null, event: OrganizationEvent): boolean {
  return filter === null || event.threadId === null || filter.has(event.threadId);
}

export function flushBufferedSseEvents(
  buffered: OrganizationEvent[],
  push: (event: OrganizationEvent) => void,
): void {
  const pending = buffered.splice(0);
  const durable: OrganizationEvent[] = [];
  const live: OrganizationEvent[] = [];
  for (const event of pending) {
    if (committedCursor(event) === null) live.push(event);
    else durable.push(event);
  }
  durable.sort((left, right) => committedCursor(left)! - committedCursor(right)!);
  for (const event of durable) push(event);
  for (const event of live) push(event);
}

const MAX_PUBLISH_BATCH = 500;

function isUncommitted(event: OrganizationEvent): boolean {
  const rawCursor = (event as { cursor?: unknown }).cursor;
  return rawCursor === undefined || rawCursor === null;
}

function validatePublishedEvent(event: OrganizationEvent): void {
  const rawCursor = (event as { cursor?: unknown }).cursor;
  const uncommitted = isUncommitted(event);
  if (
    typeof event.organizationId !== "string" ||
    typeof event.runId !== "string" ||
    typeof event.sequence !== "number" ||
    typeof event.type !== "string" ||
    typeof event.occurredAt !== "string" ||
    (!uncommitted && (typeof rawCursor !== "number" || !Number.isSafeInteger(rawCursor)))
  ) {
    throw new HttpError(400, "EVENT_INVALID", "L’enveloppe d’événement est invalide.");
  }
  if (uncommitted && (typeof event.threadId !== "string" || !Number.isSafeInteger(event.leaseGeneration)
    || event.leaseGeneration === null || event.leaseGeneration === undefined || event.leaseGeneration < 0)) {
    throw new HttpError(400, "EVENT_INVALID", "L’identité de bail de l’événement est invalide.");
  }
}

// Before the commit there is no cursor. The frame leaves at once,
// with no `id:` (see `serialize`): Last-Event-ID does not skip a row
// still lower and not yet committed. The ordered poller stays the only
// publisher of durable rows, so as not to invert 12 and 11.
//
// The membership check is done ONCE per (run, lease, thread) of the batch, not
// per event: a flush carries several frames of the same run. The shared lock
// holds until the end of the batch's synchronous fan-out, per organization.
async function fanOutUncommitted(db: Db, hub: EventHub, events: OrganizationEvent[]): Promise<void> {
  const byOrganization = new Map<string, Map<string, OrganizationEvent[]>>();
  for (const event of events) {
    const runs = byOrganization.get(event.organizationId) ?? new Map<string, OrganizationEvent[]>();
    const key = `${event.runId}|${event.threadId}|${event.leaseGeneration}`;
    const group = runs.get(key);
    if (group) group.push(event);
    else runs.set(key, [event]);
    byOrganization.set(event.organizationId, runs);
  }
  for (const [organizationId, runs] of byOrganization) {
    // Keep the run share lock through synchronous fanout: a reclaimed lease
    // cannot race this check and publish a stale provisional delta. The SQL
    // identity also prevents an internal caller from mixing bots or turns.
    await withTenant(db, organizationId, async (tx) => {
      for (const group of runs.values()) {
        const first = group[0]!;
        const rows = await tx<Array<{ botId: string | null; turnId: string; sessionKey: string | null }>>`
          select run.bot_id as "botId", coalesce(workflow.root_run_id, run.id) as "turnId",
                 coalesce(run.execution_session_key, thread.hermes_session_id) as "sessionKey"
            from runs run
            join threads thread on thread.organization_id = run.organization_id and thread.id = run.thread_id
            left join workflows workflow on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
           where run.organization_id = ${organizationId} and run.id = ${first.runId}
             and run.thread_id = ${first.threadId} and run.lease_generation = ${first.leaseGeneration}
             and run.lease_owner is not null and run.lease_expires_at > now()
             and run.status in ('starting','running','awaiting_approval')
             and run.remote_stop_state is distinct from 'requested'
           for share of run
        `;
        if (!rows[0]) continue;
        for (const event of group) hub.publish({ ...event, ...rows[0] });
      }
    });
  }
}

/**
 * `POST /internal/events/publish`: the worker's pre-commit frames (deltas
 * with no cursor, which no table carries yet) and its post-commit hints.
 *
 * The post-commit hint is now only the FALLBACK of LISTEN: as long
 * as `commitHintsNeeded()` is false, LISTEN already wakes this replica and
 * all the others; following it would double the read. It remains the path of
 * the only replica targeted by `API_INTERNAL_URL` when LISTEN is cut.
 */
export function internalEventRoutes(
  db: Db,
  internal: InternalSecretsWith<"events">,
  hub: EventHub,
  wake: (organizationId: string) => void = (organizationId) => wakeReplayPoller(hub, organizationId),
  commitHintsNeeded: () => boolean = () => true,
): Hono {
  const routes = new Hono();
  routes.post("/publish", async (context) => {
    const accepted = matchInternalBearer(internal, "events", context.req.header("Authorization"));
    internalAuthMetrics.recordBearer("events", accepted ? "role" : "refused", "/internal/events/publish");
    if (!accepted) throw new HttpError(401, "WORKER_AUTH_INVALID", "Authentification worker invalide.");
    // Body: one event (original shape) or a batch `{ events: [...] }`. A batch
    // is validated whole before any fan-out, then delivered in array order.
    const body = await jsonBody(context.req.raw);
    const batch = (body as { events?: unknown }).events;
    let events: OrganizationEvent[];
    if (batch === undefined) {
      events = [body as unknown as OrganizationEvent];
    } else {
      if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_PUBLISH_BATCH
        || batch.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        throw new HttpError(400, "EVENT_INVALID", "Le lot d’événements est invalide.");
      }
      events = batch as OrganizationEvent[];
    }
    for (const event of events) validatePublishedEvent(event);
    // A wake joined to a pre-commit batch is that of the previous flush: it
    // passes after the fan-out, one per organization is enough (idempotent).
    const uncommitted = events.filter(isUncommitted);
    if (uncommitted.length > 0) await fanOutUncommitted(db, hub, uncommitted);
    if (!commitHintsNeeded()) return context.body(null, 204);
    const woken = new Set<string>();
    for (const event of events) {
      if (isUncommitted(event) || woken.has(event.organizationId)) continue;
      woken.add(event.organizationId);
      wake(event.organizationId);
    }
    return context.body(null, 204);
  });
  return routes;
}

/** The org's max global cursor (0 if no event) to prime the poller. */
async function maxCursor(db: Db, organizationId: string): Promise<number> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<Array<{ max: string | number | null }>>`
      select max(cursor) as max from run_events where organization_id = ${organizationId}
    `;
    return Number(rows[0]?.max ?? 0);
  });
}

/**
 * Smallest cursor of the organization whose `occurred_at` is later than
 * `since`: `null` when the window is empty. A single query, at the opening
 * of a connection that started from zero; never on the poller's path.
 */
async function oldestCursorSince(db: Db, organizationId: string, since: Date): Promise<number | null> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<Array<{ min: string | number | null }>>`
      select min(cursor) as min from run_events
       where organization_id = ${organizationId} and occurred_at >= ${since}
    `;
    const value = rows[0]?.min;
    return value === null || value === undefined ? null : Number(value);
  });
}

async function replay(
  db: Db,
  organizationId: string,
  cursor: number,
): Promise<Array<OrganizationEvent & { cursor: number }>> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<RunEventRecord[]>`
      select cursor, organization_id as "organizationId", thread_id as "threadId",
             run_id as "runId", bot_id as "botId", turn_id as "turnId",
             session_key as "sessionKey", lease_generation as "leaseGeneration",
             sequence, type, payload, occurred_at as "occurredAt"
        from run_events
       where organization_id = ${organizationId} and cursor > ${cursor}
       order by cursor asc
       limit ${REPLAY_LIMIT}
    `;
    const events = rows.map(organizationEventEnvelope);
    // In the SAME transaction as the event read: the final
    // message is written with `run.completed` (a single transaction on the
    // worker side), so everything this page announces as concluded is already
    // readable here. Doing it after would reopen a window for nothing.
    const page = await attachTerminalCompletions(tx, organizationId, events);
    return page as Array<OrganizationEvent & { cursor: number }>;
  });
}

/**
 * Reads every available page up to the cursor captured before the replay.
 * A single page here would advance the poller straight to the captured max and
 * silently abandon the events of page 2 and after.
 * `emit` may wait: that is how replay follows the reader.
 */
export async function replayPagesUntil<T extends CursoredEvent>(
  cursor: number,
  capturedCursor: number,
  fetchPage: (cursor: number) => Promise<T[]>,
  emit: (event: T) => unknown,
): Promise<number> {
  let delivered = 0;
  let pageCursor = cursor;
  while (pageCursor < capturedCursor) {
    const page = await fetchPage(pageCursor);
    if (page.length === 0) break;
    for (const event of page) {
      await emit(event);
      delivered += 1;
    }
    const lastCursor = page[page.length - 1]?.cursor;
    // SQL orders by cursor, so a non-advancing page is invalid. Stop rather
    // than looping forever if a degraded/mock data source violates that.
    if (lastCursor === undefined || lastCursor <= pageCursor) break;
    pageCursor = lastCursor;
  }
  return delivered;
}

function serialize(event: OrganizationEvent): string {
  const durableCursor = committedCursor(event);
  const id = durableCursor === null ? "" : `id: ${durableCursor}\n`;
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
