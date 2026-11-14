import { ApiClient, ApiClientError, type OrganizationEvent, type StreamGap } from "@openedbot/browser-api-client";
import { acceptLiveEvent, advanceStreamCursor, createLiveDedupe, resetLiveDedupe } from "@/lib/stream/thread-stream-live";
import { nativeAuthStore, nativeRequestInit } from "../platform";
import { CLIENT_UPDATE_REQUIRED, isClientUpdateRequired, reportClientUpdateRequired, reportingClientUpdate } from "../platform/client-update";
import { activeOrganizationId, reportWorkspaceRevoked, readCloudSession, subscribeCloudSession } from "../session/cloud-session";
import { API_ORIGIN, queryKeys } from "../api";
import { scheduleInvalidate } from "../query-client";

/**
 * The organization's event stream: one SSE connection per page, shared by
 * every subscriber (the shell projection, the open thread, the web
 * notifications). It runs while one of them listens.
 */

type CloudEventListener = (event: OrganizationEvent) => void;
type CloudStreamStatusListener = (connected: boolean) => void;
type CloudStreamGapListener = (gap: StreamGap) => void;
const listeners = new Set<CloudEventListener>();
const streamStatusListeners = new Set<CloudStreamStatusListener>();
const streamGapListeners = new Set<CloudStreamGapListener>();
let streamOrganization: string | null = null;
let streamCursor = 0;
const liveDedupe = createLiveDedupe();
let streamController: AbortController | null = null;
let streamRunning = false;
let streamConnected = false;

function setOrganizationStreamConnected(connected: boolean): void {
  if (streamConnected === connected) return;
  streamConnected = connected;
  for (const listener of streamStatusListeners) listener(connected);
}

export function stopOrganizationStream(): void {
  streamController?.abort("session_changed");
  streamController = null;
  streamRunning = false;
  setOrganizationStreamConnected(false);
  streamOrganization = null;
  streamCursor = 0;
  resetLiveDedupe(liveDedupe);
}

subscribeCloudSession(() => {
  const organizationId = activeOrganizationId();
  if (!organizationId || (streamOrganization !== null && streamOrganization !== organizationId)) {
    stopOrganizationStream();
    listeners.clear();
  }
});

function ensureOrganizationStream(): void {
  const organizationId = activeOrganizationId();
  // Desktop app too old (426): every new screen would reopen a stream
  // refused at once; the update screen already covers the console.
  if (!organizationId || listeners.size === 0 || isClientUpdateRequired()) return;
  if (streamOrganization !== null && streamOrganization !== organizationId) {
    stopOrganizationStream();
  }
  if (streamRunning) return;
  streamOrganization = organizationId;
  const controller = new AbortController();
  streamController = controller;
  void runOrganizationStream(organizationId, controller);
}

/**
 * Where the shared stream is BEFORE a screen subscribes to it. A stream already
 * running ignores the subscriber's cursor: if it has passed this screen's
 * snapshot cursor, it may have consumed events of this thread for a
 * previous screen: only a reread brings them back.
 */
export function organizationStreamPosition(): { running: boolean; cursor: number } {
  return { running: streamRunning, cursor: streamCursor };
}

export function subscribeToOrganizationEvents(
  listener: CloudEventListener,
  statusListener: CloudStreamStatusListener,
  initialCursor: number,
  gapListener?: CloudStreamGapListener,
): () => void {
  // On the first open thread, its committed snapshot is the earliest cursor
  // worth replaying. Starting from zero would replay the whole retained
  // organization history and can resurrect events omitted by snapshot limits.
  if (!streamRunning) streamCursor = Math.max(streamCursor, initialCursor);
  listeners.add(listener);
  streamStatusListeners.add(statusListener);
  if (gapListener) streamGapListeners.add(gapListener);
  statusListener(streamConnected);
  ensureOrganizationStream();
  return () => {
    listeners.delete(listener);
    streamStatusListeners.delete(statusListener);
    if (gapListener) streamGapListeners.delete(gapListener);
    // Do not consume organization events while no conversation can receive
    // them. A later screen starts from its own snapshot, closing the gap.
    if (listeners.size === 0) stopOrganizationStream();
  };
}

async function runOrganizationStream(organizationId: string, controller: AbortController): Promise<void> {
  streamRunning = true;
  try {
    if (controller.signal.aborted) return;
    const client = new ApiClient({
      baseUrl: API_ORIGIN,
      organizationId: () => organizationId,
      csrfToken: () => readCloudSession()?.csrfToken ?? null,
      // Native shell: the stream carries the bridge's bearer and renews it on 401.
      auth: nativeAuthStore() ?? undefined,
      fetch: reportingClientUpdate((input, init) => globalThis.fetch(input, nativeRequestInit(init))),
    });
    // A single stream for the organization. No `threadIds`: the roster patches
    // the overview, the unread mark and the badge of EVERY thread from this singleton.
    // Filtering it on the open thread would freeze the others.
    let slowConsumer = false;
    for await (const event of client.events({
      cursor: streamCursor,
      getCursor: () => streamCursor,
      signal: controller.signal,
      onOpen: () => {
        if (controller.signal.aborted || streamController !== controller) return;
        slowConsumer = false;
        setOrganizationStreamConnected(true);
      },
      onCursor: (cursor) => {
        if (controller.signal.aborted) return;
        streamCursor = advanceStreamCursor(streamCursor, cursor);
      },
      // Rework-flux-api step 5e: the runtime changed (link, health,
      // preferences, review proof): reread it now rather than at the next minute.
      onRuntimeChanged: () => {
        if (controller.signal.aborted || activeOrganizationId() !== organizationId) return;
        scheduleInvalidate(queryKeys.runtimeConfiguration);
        scheduleInvalidate(queryKeys.runtimeList);
      },
      onGap: (gap) => {
        if (controller.signal.aborted || gap.organizationId !== organizationId) return;
        if (gap.reason === "slow_consumer") slowConsumer = true;
        for (const gapListener of streamGapListeners) gapListener(gap);
      },
      onError: (error) => {
        if (controller.signal.aborted || streamController !== controller
          || activeOrganizationId() !== organizationId) return;
        setOrganizationStreamConnected(false);
        if (slowConsumer) {
          slowConsumer = false;
          return;
        }
        if (error instanceof ApiClientError && error.code === "WORKSPACE_ACCESS_REVOKED") {
          controller.abort("workspace_revoked");
          reportWorkspaceRevoked(organizationId);
          return;
        }
        // Without this abort, the end of the generator would restart the stream at once
        // (`finally` below), in a loop and with no delay.
        if (error instanceof ApiClientError && error.code === CLIENT_UPDATE_REQUIRED) {
          controller.abort("client_update_required");
          // Already reported, versions included, by `reportingClientUpdate`; the first report is authoritative.
          reportClientUpdateRequired(null);
          return;
        }
        console.error("Le flux d’événements de l’organisation est indisponible.", error);
      },
    })) {
      if (controller.signal.aborted || activeOrganizationId() !== organizationId) return;
      deliverOrganizationEvent(event, organizationId);
    }
  } finally {
    if (streamController === controller) {
      setOrganizationStreamConnected(false);
      streamController = null;
      streamRunning = false;
      if (listeners.size > 0 && !controller.signal.aborted && activeOrganizationId() === organizationId) {
        ensureOrganizationStream();
      }
    }
  }
}

function deliverOrganizationEvent(event: OrganizationEvent, organizationId: string): void {
  const accepted = acceptLiveEvent(liveDedupe, event, organizationId, streamCursor);
  streamCursor = accepted.streamCursor;
  if (!accepted.deliver) return;
  // Receipt, not render: the HUD dates the event before the per-frame queue.
  if (event.type !== "message.admitted" && event.type !== "run.steering") {
    globalThis.window?.__openedbotThreadPerf?.recordRunEvent(event.runId, event.type);
  }
  for (const listener of listeners) listener(event);
}

/**
 * Rework-flux-api step 4: who projects the stream onto the roster, the inbox
 * and the memories. While the shell is subscribed it projects every event,
 * in stream order; otherwise (hidden window, a screen outside the shell, a
 * test) the open thread does, as before. Decided when an event is delivered,
 * so an event is projected by exactly one of them.
 */
let shellProjection = false;

export function setShellProjectionActive(active: boolean): void {
  shellProjection = active;
}

export function shellProjectionActive(): boolean {
  return shellProjection;
}

/** The thread on screen: its row is not marked unread by the roster patch. */
let openThread: string | undefined;

export function setOpenThread(threadId: string | undefined): void {
  openThread = threadId;
}

export function openThreadId(): string | undefined {
  return openThread;
}
