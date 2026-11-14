import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { EventHub } from "@openedbot/notifications/application/event-hub";
import type { Db } from "@openedbot/platform-db";
import { logger } from "@openedbot/platform-observability";
import {
  createEventNotifications,
  EVENTS_CHANNEL,
  type EventLink,
  type EventLinkOptions,
} from "../../infrastructure/event-notifications";

/** Page size of a replay read; a full page is drained at once. */
export const REPLAY_LIMIT = 1_000;

// The database poller is the only live publisher of the durable rows:
// a single source ordered per organization prevents two concurrent commits
// from delivering a higher cursor before a lower one. A notification carries
// no data: it only wakes a read from the cursor.
//
// What wakes it:
// - LISTEN `openedbot_events` (`event-notifications.ts`), the NOMINAL path: the
//   0005 trigger notifies every commit of `run_events` to all replicas,
//   whoever the writer (worker, API, plug-in);
// - every LISTEN (re)subscription: `wakeAllReplayPollers`, a catch-up of what
//   was committed during the outage;
// - the worker's post-commit HTTP hint (`POST /internal/events/publish`),
//   FALLBACK only, as long as LISTEN is not established on this replica;
// - the periodic poll (`API_EVENTS_FALLBACK_POLL_MS`, 5 s by default),
//   the NET: a notification lost with no detected outage, LISTEN unavailable.

export type OrderedReplayPump = {
  /** Coalesces any number of commit notifications into one ordered DB read. */
  wake(): void;
  /** Prevents a released organization's in-flight read from scheduling more work. */
  close(): void;
};

/**
 * The minimum a source must carry to go through the pump: a monotonic
 * cursor. `run_events` carries it, and it is the only thing the ordering
 * looks at.
 */
export type CursoredEvent = { cursor: number };

type ReplayPumpOptions = {
  pageLimit?: number;
  schedule?: (drain: () => Promise<void>) => void;
  onError?: (error: unknown) => void;
};

type ReplayPoller = {
  references: number;
  pump: OrderedReplayPump;
  timer: ReturnType<typeof setInterval>;
};

/**
 * A process's pollers, per hub: two hubs (two API instances in
 * the same test process) never share a pump that would publish
 * into the other's hub.
 */
const pollersByHub = new WeakMap<EventHub, Map<string, ReplayPoller>>();

function pollersOf(hub: EventHub): Map<string, ReplayPoller> {
  let pollers = pollersByHub.get(hub);
  if (!pollers) {
    pollers = new Map();
    pollersByHub.set(hub, pollers);
  }
  return pollers;
}

export function shouldEmitSseCursor(eventCursor: number, lastCursor: number): boolean {
  return Number.isSafeInteger(eventCursor) && eventCursor > lastCursor;
}

/**
 * Takes (or shares) the organization's poller on this hub. The first
 * connection fixes the starting cursor and the net's cadence; the following ones
 * join it. Returns the function that releases it.
 */
export function acquireReplayPoller(
  hub: EventHub,
  organizationId: string,
  initialCursor: number,
  fetchPage: (cursor: number) => Promise<Array<OrganizationEvent & { cursor: number }>>,
  fallbackPollMs: number,
): () => void {
  const pollers = pollersOf(hub);
  const existing = pollers.get(organizationId);
  if (existing) {
    existing.references += 1;
    return () => releaseReplayPoller(pollers, organizationId, existing);
  }

  const pump = createOrderedReplayPump(initialCursor, fetchPage, (event) => hub.publish(event), {
    onError: (error) => {
      logger.error({ event: "sse.replay_failed", organizationId, error: String(error) }, "sse replay failed");
    },
  });
  const poller: ReplayPoller = {
    references: 1,
    pump,
    timer: setInterval(() => pump.wake(), fallbackPollMs),
  };
  pollers.set(organizationId, poller);
  // Closes the max-cursor/replay/acquire window without waiting for the first
  // interval when a commit landed during initial connection replay.
  poller.pump.wake();
  return () => releaseReplayPoller(pollers, organizationId, poller);
}

/** Wakes an organization's read, if a connection of this hub follows it. */
export function wakeReplayPoller(hub: EventHub, organizationId: string): void {
  pollersByHub.get(hub)?.get(organizationId)?.pump.wake();
}

/** Catch-up of every followed organization (LISTEN subscription resumed). */
export function wakeAllReplayPollers(hub: EventHub): void {
  for (const poller of pollersByHub.get(hub)?.values() ?? []) poller.pump.wake();
}

/** Organizations followed by this hub (metrics). */
export function replayPollerCount(hub: EventHub): number {
  return pollersByHub.get(hub)?.size ?? 0;
}

function releaseReplayPoller(pollers: Map<string, ReplayPoller>, organizationId: string, poller: ReplayPoller): void {
  poller.references -= 1;
  if (poller.references > 0) return;
  clearInterval(poller.timer);
  poller.pump.close();
  if (pollers.get(organizationId) === poller) pollers.delete(organizationId);
}

/**
 * Serial DB replay pump used by notifications, commit hints and the fallback timer.
 *
 * A wake received while a SELECT is in flight sets one pending bit. Once that
 * SELECT completes, exactly one new read starts from its advanced cursor. This
 * avoids overlap (and cursor inversion), does not lose an in-flight commit,
 * and naturally applies backpressure when PostgreSQL is slower than wakes.
 */
export function createOrderedReplayPump<T extends CursoredEvent>(
  initialCursor: number,
  fetchPage: (cursor: number) => Promise<T[]>,
  emit: (event: T) => void,
  options: ReplayPumpOptions = {},
): OrderedReplayPump {
  const pageLimit = options.pageLimit ?? REPLAY_LIMIT;
  const schedule = options.schedule ?? ((drain: () => Promise<void>) => {
    queueMicrotask(() => { void drain(); });
  });
  let cursor = initialCursor;
  let pending = false;
  let scheduled = false;
  let inFlight = false;
  let closed = false;

  const scheduleDrain = () => {
    if (closed || !pending || scheduled || inFlight) return;
    scheduled = true;
    schedule(drain);
  };
  const drain = async () => {
    scheduled = false;
    if (closed || !pending || inFlight) return;
    pending = false;
    inFlight = true;
    const cursorBefore = cursor;
    try {
      const events = await fetchPage(cursor);
      // SQL already orders, but sorting here keeps this safety boundary sound
      // if a future data source or test double does not.
      events.sort((left, right) => left.cursor - right.cursor);
      for (const event of events) {
        if (!shouldEmitSseCursor(event.cursor, cursor)) continue;
        cursor = event.cursor;
        emit(event);
      }
      // Drain a full page immediately instead of adding one fallback interval
      // per 1,000 events. Require progress to prevent a malformed source loop.
      if (events.length >= pageLimit && cursor > cursorBefore) pending = true;
    } catch (error) {
      options.onError?.(error);
    } finally {
      inFlight = false;
      scheduleDrain();
    }
  };

  return {
    wake() {
      if (closed) return;
      pending = true;
      scheduleDrain();
    },
    close() {
      closed = true;
      pending = false;
    },
  };
}

/**
 * An API process's LISTEN link wired to its pollers: a
 * notification wakes the notified organization, every (re)subscription
 * wakes them all. The liveness ping leaves through the ordinary pool.
 */
export function createEventRealtime(
  db: Db,
  databaseUrl: string,
  hub: EventHub,
  options: EventLinkOptions = {},
): EventLink {
  return createEventNotifications(databaseUrl, {
    notify: (organizationId) => wakeReplayPoller(hub, organizationId),
    subscribed: () => wakeAllReplayPollers(hub),
    // Rework-flux-api step 5c: every replica tells its own open streams.
    runtimeChanged: (organizationId, runtimeId) => hub.publishRuntimeChanged(organizationId, { runtimeId, reason: "changed" }),
    // A LISTEN cut while the SSE held: what changed meanwhile is unknown.
    runtimeSubscribed: () => {
      for (const organizationId of hub.runtimeSubscribedOrganizations()) {
        hub.publishRuntimeChanged(organizationId, { runtimeId: null, reason: "resync" });
      }
    },
  }, {
    ping: async (payload) => { await db`select pg_notify(${EVENTS_CHANNEL}, ${payload})`; },
    ...options,
  });
}
