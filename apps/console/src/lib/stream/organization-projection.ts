import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  applyProductEventToRoster,
  isStaleRosterEvent,
  isTerminalProductEvent,
  type RosterEvent,
} from "@openedbot/conversation/domain/thread-snapshot-mutations";
import type { RosterDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { OrganizationEvent, StreamGap } from "@openedbot/browser-api-client";
import { api, queryKeys } from "../api";
import { scheduleInvalidate } from "../query-client";
import { isRestoredQueryData } from "../query-persister";
import { activeOrganizationId, cloudSessionRevision, subscribeCloudSession } from "../session/cloud-session";
import { openThreadId, organizationStreamPosition, setShellProjectionActive, subscribeToOrganizationEvents } from "./organization-stream";
import { cancelStreamFlush, scheduleStreamFlush } from "./stream-frame";

/** What a batch of events changes outside any thread: the roster, and the keys to reread. */
export type OrganizationProjection = {
  roster: RosterDto | undefined;
  rosterTouched: boolean;
  /** Query keys, JSON-encoded so that a key scheduled twice is reread once. */
  invalidate: Set<string>;
};

export function organizationProjection(roster: RosterDto | undefined): OrganizationProjection {
  return { roster, rosterTouched: false, invalidate: new Set() };
}

/**
 * One event onto the roster, the inbox and the memories.
 *
 * An event of cursor ≤ `roster.cursor` (the max read first in the roster
 * transaction, cursor order being that of the commits) was already committed
 * when roster, inbox and memories were read: reconnect replay or catch-up,
 * it teaches nobody anything. By cursor and not by date: `occurredAt` is the
 * worker capture time, not the commit time. A roster without a cursor (an
 * earlier API) lets everything through: only the per-row guard applies then.
 */
export function projectOrganizationEvent(
  projection: OrganizationProjection,
  event: OrganizationEvent,
  openThreadId: string | undefined,
): void {
  if (isStaleRosterEvent({ cursor: event.cursor }, projection.roster)) return;
  // A `remember:` directive is committed with `run.completed`: every memory
  // of the tenant goes stale, whichever thread the run belongs to.
  if (event.type === "run.completed") {
    projection.invalidate.add(JSON.stringify(["organization", event.organizationId, "bot-memories"]));
  }
  // The inbox counts open approvals, uncertain outcomes and concluded runs.
  const ambiguousSteering = event.type === "run.steering" && event.payload.status === "ambiguous";
  if (
    isTerminalProductEvent(event as unknown as StoredProductEvent)
    || event.type === "approval.requested" || event.type === "approval.responded" || ambiguousSteering
  ) {
    projection.invalidate.add(JSON.stringify(queryKeys.inbox));
  }
  // The roster projects EVERY thread: the row of the event's thread is
  // patched in the cache (overview, timestamp, unread, badge) instead of
  // being reread on every event.
  if (projection.roster) {
    const next = applyProductEventToRoster(projection.roster, event as unknown as RosterEvent, { openThreadId });
    if (next !== projection.roster) {
      projection.roster = next;
      projection.rosterTouched = true;
    }
  }
}

/** Writes the patched roster; call inside the caller's notification batch. */
export function writeOrganizationProjection(queryClient: QueryClient, projection: OrganizationProjection): void {
  if (projection.rosterTouched) queryClient.setQueryData<RosterDto>(queryKeys.roster, projection.roster);
}

export function invalidateOrganizationProjection(projection: OrganizationProjection): void {
  for (const key of projection.invalidate) scheduleInvalidate(JSON.parse(key) as readonly unknown[]);
}

/**
 * The roster and the inbox learn a change from the shell's stream; their
 * periodic reread is only a safety net now (rework-flux-api step 4): it was
 * 120 s while nothing outside a conversation patched them.
 */
export const SAFETY_NET_REFRESH_MS = 5 * 60_000;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const pageVisible = () => document.visibilityState !== "hidden";

/** The first opening of the page reads the runtime anyway; every later one rereads it. */
let streamOpenedOnce = false;

/** The keys `GET /api/runtime` feeds: not in the event log, so reread when the stream (re)opens. */
function invalidateRuntime(): void {
  scheduleInvalidate(queryKeys.runtime);
  scheduleInvalidate(queryKeys.runtimeList);
}

/**
 * Rework-flux-api step 4: the organization stream, held by the shell while a
 * session is open and the window visible, not only while a conversation is
 * on screen. Without it, the home, Settings and the inbox learnt a finished
 * run or a new approval from a two-minute reread.
 *
 * It starts from the roster's cursor (what the roster already projects), so
 * that nothing is replayed for nothing; a roster restored from IndexedDB, or
 * without a cursor, does not start it: its cursor may be hours old.
 */
export function OrganizationStreamProjection(): null {
  const queryClient = useQueryClient();
  const sessionRevision = useSyncExternalStore(subscribeCloudSession, cloudSessionRevision, cloudSessionRevision);
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const signedIn = activeOrganizationId() !== null;
  const rosterCursor = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: signedIn,
    select: (roster: RosterDto) => (!isRestoredQueryData(roster) && typeof roster.cursor === "number" ? roster.cursor : null),
  }).data ?? null;
  const cursorRef = useRef(rosterCursor);
  cursorRef.current = rosterCursor;
  const ready = rosterCursor !== null;

  useEffect(() => {
    if (!visible || !ready || !activeOrganizationId()) return;
    const startCursor = cursorRef.current ?? 0;
    // A stream already running (an open thread kept it while the window was
    // hidden) is further than the roster: what it delivered then was
    // projected by nobody or by the thread. Reread rather than guess.
    const position = organizationStreamPosition();
    let mayHaveMissed = position.running && position.cursor > startCursor;
    let pending: OrganizationEvent[] = [];
    const owner = {};
    // The workspace these events belong to: an organization switch
    // changes what `queryKeys.roster` names before the cleanup
    // flushes, and the old events must not land in the new cache (Codex).
    const scope = JSON.stringify(queryKeys.roster);
    const flush = () => {
      cancelStreamFlush(owner);
      if (pending.length === 0) return;
      const events = pending;
      pending = [];
      if (JSON.stringify(queryKeys.roster) !== scope) return;
      const projection = organizationProjection(queryClient.getQueryData<RosterDto>(queryKeys.roster));
      const open = openThreadId();
      for (const event of events) projectOrganizationEvent(projection, event, open);
      writeOrganizationProjection(queryClient, projection);
      invalidateOrganizationProjection(projection);
    };
    const onStatus = (connected: boolean) => {
      if (!connected) return;
      if (mayHaveMissed) {
        mayHaveMissed = false;
        scheduleInvalidate(queryKeys.roster);
        scheduleInvalidate(queryKeys.inbox);
        scheduleInvalidate(["organization", activeOrganizationId(), "bot-memories"]);
      }
      if (streamOpenedOnce) invalidateRuntime();
      streamOpenedOnce = true;
    };
    // Past the replay window the server raises the cursor: what it will not
    // return is reread. A gap below our start point is another subscriber's.
    const onGap = (gap: StreamGap) => {
      if (gap.to <= startCursor) return;
      scheduleInvalidate(queryKeys.roster);
      scheduleInvalidate(queryKeys.inbox);
    };
    setShellProjectionActive(true);
    const stop = subscribeToOrganizationEvents((event) => {
      pending.push(event);
      scheduleStreamFlush(owner, flush);
    }, onStatus, startCursor, onGap);
    return () => {
      stop();
      setShellProjectionActive(false);
      flush();
    };
  }, [queryClient, sessionRevision, visible, ready]);

  return null;
}
