import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { notifyManager, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  applyProductEventToRoster,
  applyProductEventToSnapshot,
  isStaleRosterEvent,
  isTerminalProductEvent,
  type RosterEvent,
} from "@openedbot/conversation/domain/thread-snapshot-mutations";
import type { RosterDto } from "@openedbot/contracts-api";
import { cursorForOpenThread, streamStartCursor } from "@/lib/stream/thread-stream-cursor";
import {
  acceptLiveEvent,
  advanceStreamCursor,
  createLiveDedupe,
  refetchOnStreamOpen,
  refreshAfterAppliedEvent,
  resetLiveDedupe,
} from "@/lib/stream/thread-stream-live";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { ApiClient, ApiClientError, type OrganizationEvent, type StreamGap } from "@openedbot/browser-api-client";
import { nativeAuthStore, nativeRequestInit } from "../platform";
import { CLIENT_UPDATE_REQUIRED, isClientUpdateRequired, reportClientUpdateRequired, reportingClientUpdate } from "../platform/client-update";
import { activeFleetId, activeOrganizationId, reportWorkspaceRevoked, cloudSessionRevision, readCloudSession, subscribeCloudSession } from "../session/cloud-session";
import { api, API_ORIGIN, queryKeys, type ThreadView } from "../api";
import { createLiveRunText, createLiveTextHold, type LiveRunText, type ThreadLiveText } from "./live-run-text";
import { asLocalPatch, scheduleInvalidate } from "../query-client";
import { isRestoredQueryData } from "../query-persister";
import { mergeThreadHistory, readThreadHistoryHead } from "../thread/thread-history";
import { nextReviewWatch, REVIEW_POLL_MS, type ReviewWatch } from "../thread/thread-review-poll";
import {
  isCurrentThreadSnapshot,
  readNewestThreadSnapshot,
  shouldWaitForThreadSnapshot,
} from "./thread-stream-safety";

type CloudEventListener = (event: OrganizationEvent) => void;
type CloudStreamStatusListener = (connected: boolean) => void;
type CloudStreamGapListener = (gap: StreamGap) => void;
const listeners = new Set<CloudEventListener>();
const streamStatusListeners = new Set<CloudStreamStatusListener>();
const streamGapListeners = new Set<CloudStreamGapListener>();
let streamOrganization: string | null = null;
let streamFleet: string | null = null;
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
  streamFleet = null;
  streamCursor = 0;
  resetLiveDedupe(liveDedupe);
}

subscribeCloudSession(() => {
  const organizationId = activeOrganizationId();
  if (!organizationId || (streamOrganization !== null
    && (streamOrganization !== organizationId || streamFleet !== activeFleetId()))) {
    stopOrganizationStream();
    listeners.clear();
  }
});

function ensureOrganizationStream(): void {
  const organizationId = activeOrganizationId();
  const fleetId = activeFleetId();
  // App de bureau trop vieille (426) : chaque nouvel écran rouvrirait un flux
  // aussitôt refusé ; l'écran de mise à jour couvre déjà la console.
  if (!organizationId || listeners.size === 0 || isClientUpdateRequired()) return;
  if (streamOrganization !== null && (streamOrganization !== organizationId || streamFleet !== fleetId)) {
    stopOrganizationStream();
  }
  if (streamRunning) return;
  streamOrganization = organizationId;
  streamFleet = fleetId;
  const controller = new AbortController();
  streamController = controller;
  void runOrganizationStream(organizationId, fleetId, controller);
}

/**
 * Où en est le flux partagé AVANT qu'un écran s'y abonne. Un flux déjà en
 * marche ignore le curseur de l'abonné : s'il a dépassé le curseur du
 * snapshot de cet écran, il a pu consommer des événements de ce fil pour un
 * écran précédent : seule une relecture les rend.
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

async function runOrganizationStream(organizationId: string, fleetId: string | null, controller: AbortController): Promise<void> {
  streamRunning = true;
  try {
    if (controller.signal.aborted) return;
    const client = new ApiClient({
      baseUrl: API_ORIGIN,
      organizationId: () => organizationId,
      actingFleetId: () => fleetId,
      csrfToken: () => readCloudSession()?.csrfToken ?? null,
      // Coque native : le flux porte le bearer du pont et le renouvelle sur 401.
      auth: nativeAuthStore() ?? undefined,
      fetch: reportingClientUpdate((input, init) => globalThis.fetch(input, nativeRequestInit(init))),
    });
    // Un seul flux pour l'organisation. Pas de `threadIds` : le roster patche
    // l'aperçu, le non-lu et la pastille de TOUS les fils depuis ce singleton.
    // Le filtrer sur le fil ouvert figerait les autres.
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
      onGap: (gap) => {
        if (controller.signal.aborted || gap.organizationId !== organizationId) return;
        if (gap.reason === "slow_consumer") slowConsumer = true;
        for (const gapListener of streamGapListeners) gapListener(gap);
      },
      onError: (error) => {
        if (controller.signal.aborted || streamController !== controller
          || activeOrganizationId() !== organizationId || activeFleetId() !== fleetId) return;
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
        // Sans cet abandon, la fin du générateur relancerait le flux aussitôt
        // (`finally` ci-dessous), en boucle et sans délai.
        if (error instanceof ApiClientError && error.code === CLIENT_UPDATE_REQUIRED) {
          controller.abort("client_update_required");
          // Déjà signalé, versions comprises, par `reportingClientUpdate` ; le premier signalement fait foi.
          reportClientUpdateRequired(null);
          return;
        }
        console.error("Le flux d’événements de l’organisation est indisponible.", error);
      },
    })) {
      if (controller.signal.aborted || activeOrganizationId() !== organizationId || activeFleetId() !== fleetId) return;
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
  // Réception, pas rendu : le HUD date l'événement avant la file par frame.
  if (event.type !== "message.admitted" && event.type !== "run.steering") {
    globalThis.window?.__openedbotThreadPerf?.recordRunEvent(event.runId, event.type);
  }
  for (const listener of listeners) listener(event);
}

/**
 * The newest page of a thread, merged into what the cache already holds. One
 * definition for the screen and for the route loader that starts it before
 * the screen renders (`lib/thread/conversation-prefetch.ts`): same key, same read.
 */
export function threadQueryOptions(queryClient: QueryClient, threadId: string) {
  const queryKey = queryKeys.thread(threadId);
  // A snapshot restored from IndexedDB is replaced, never merged: turns
  // written since it was saved would leave a hole between its pages and the
  // fresh head (`lib/query-persister.ts`).
  const current = () => {
    const cached = queryClient.getQueryData<ThreadView>(queryKey);
    return isRestoredQueryData(cached) ? undefined : cached;
  };
  return {
    queryKey,
    queryFn: async (): Promise<ThreadView> => {
      const newest = await readNewestThreadSnapshot(
        () => readThreadHistoryHead((before) => api.thread(threadId, before), current()),
        current,
      );
      return mergeThreadHistory(current(), newest, "latest");
    },
  };
}

export function useThreadStream(threadId: string | undefined) {
  const queryClient = useQueryClient();
  const sessionRevision = useSyncExternalStore(subscribeCloudSession, cloudSessionRevision, cloudSessionRevision);
  const [streaming, setStreaming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const cursorRef = useRef(0);
  const openThreadIdRef = useRef<string | undefined>(undefined);
  const olderRequest = useRef<{ threadId: string; promise: Promise<boolean> } | null>(null);
  const [olderState, setOlderState] = useState<{ threadId?: string; loading: boolean; error: boolean }>({ loading: false, error: false });
  // A gate under automatic review shows no card: poll until it settles (PERM2-7).
  const reviewWatch = useRef<ReviewWatch | null>(null);
  const [liveText] = useState<LiveRunText>(createLiveRunText); // réponses en cours, hors du cache (`live-run-text.ts`)

  const thread = useQuery({
    ...(threadId
      ? threadQueryOptions(queryClient, threadId)
      : { queryKey: ["organization", activeOrganizationId() ?? "anonymous", "thread", "none"], queryFn: () => Promise.reject(new Error("no thread")) }),
    enabled: Boolean(threadId),
    refetchInterval: (query) => {
      const watch = nextReviewWatch(reviewWatch.current, query.state.data, Date.now());
      reviewWatch.current = watch.next;
      if (watch.poll) return REVIEW_POLL_MS;
      return streaming ? false : 5_000;
    },
  });

  const liveView = useMemo<ThreadLiveText>(() => ({ store: liveText, events: thread.data?.events ?? [] }), [liveText, thread.data?.events]);
  const loadOlder = useCallback((beforeMerge?: () => void): Promise<boolean> => {
    const pendingRequest = olderRequest.current;
    if (pendingRequest && pendingRequest.threadId === threadId) return pendingRequest.promise;
    if (!threadId) return Promise.resolve(false);
    const key = queryKeys.thread(threadId);
    const before = queryClient.getQueryData<ThreadView>(key)?.history?.nextBefore;
    if (!before) return Promise.resolve(false);
    setOlderState({ threadId, loading: true, error: false });
    const pending = { threadId, promise: Promise.resolve(false) };
    olderRequest.current = pending;
    const request = (async () => {
      try {
        const page = await api.thread(threadId, before);
        if (cloudSessionRevision() !== sessionRevision || openThreadIdRef.current !== threadId) return false;
        const current = queryClient.getQueryData<ThreadView>(key);
        if (!current || current.id !== page.id || current.history?.nextBefore !== before) return false;
        beforeMerge?.();
        queryClient.setQueryData<ThreadView>(key, mergeThreadHistory(current, page, "older"));
        setOlderState({ threadId, loading: false, error: false });
        return true;
      } catch {
        setOlderState({ threadId, loading: false, error: true });
        return false;
      } finally {
        if (olderRequest.current === pending) olderRequest.current = null;
        setOlderState((state) => state.threadId === threadId && state.loading ? { ...state, loading: false } : state);
      }
    })();
    pending.promise = request;
    return request;
  }, [threadId, queryClient, sessionRevision]);

  // Le flux ne s'abonne qu'une fois le snapshot du fil en cache : c'est lui
  // qui donne le curseur de départ. Partir de zéro faisait rejouer par le
  // serveur tout l'historique retenu de l'organisation : et chaque événement
  // rejoué coûtait une relecture du roster. Ce booléen ne bascule qu'à
  // l'arrivée du premier snapshot du fil (ou à son changement), pas à chaque
  // rafraîchissement : l'abonnement n'est pas rejoué pour rien.
  // A snapshot restored from IndexedDB paints the thread but does not start
  // the stream: its cursor may be hours old. The refetch that follows it does.
  const isLiveSnapshot = (snapshot: ThreadView | undefined): boolean =>
    threadId !== undefined && isCurrentThreadSnapshot(snapshot, threadId) && !isRestoredQueryData(snapshot);
  const snapshotReady = isLiveSnapshot(thread.data)
    || isLiveSnapshot(threadId === undefined ? undefined : queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId)));

  useEffect(() => {
    if (!threadId) {
      openThreadIdRef.current = undefined;
      cursorRef.current = 0;
      setStreaming(false);
      setSwitching(false);
      return;
    }
    const cached = queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId));
    // `cursorRef` reste le curseur du FIL (le contrôle de rattrapage plus bas
    // compare `snapshot.cursor` à lui) ; le flux, lui, s'attache au curseur de
    // l'ORGANISATION porté par le snapshot : rien à rejouer par construction.
    const previousThreadId = openThreadIdRef.current;
    cursorRef.current = cursorForOpenThread({
      openThreadId: previousThreadId,
      nextThreadId: threadId,
      currentCursor: cursorRef.current,
      snapshotCursor: cached?.cursor,
    });
    const initialStreamCursor = cursorForOpenThread({
      openThreadId: previousThreadId,
      nextThreadId: threadId,
      currentCursor: cursorRef.current,
      snapshotCursor: streamStartCursor(cached),
    });
    openThreadIdRef.current = threadId;
    // A session refresh restarts this effect even when the open thread did not
    // change. Setting `switching` to true unconditionally could then freeze the
    // screen forever: React Query legitimately keeps the same cache object, so
    // the snapshot effect below has no changed dependency with which to clear
    // the flag. Only an actually absent/wrong-thread snapshot is a switch.
    setSwitching(shouldWaitForThreadSnapshot(cached, threadId));
    if (!snapshotReady || !isCurrentThreadSnapshot(cached, threadId)) {
      // Pas encore de snapshot pour CE fil : on attend qu'il arrive (l'effet
      // se rejoue quand `snapshotReady` bascule). `streaming` retombe pour que
      // la relecture périodique du fil reprenne si le flux ne repart jamais.
      setStreaming(false);
      return;
    }
    let disposed = false;
    let stop = () => {};
    const start = async () => {
      // A valid cookie can outlive the small local session mirror (cleared
      // storage, HMR, another tab). Re-read `/auth/me` once so the SSE client
      // has the organization it must put in `X-OpenedBot-Organization`.
      if (!activeOrganizationId()) {
        try {
          await api.authMe();
        } catch {
          if (!disposed) setStreaming(false);
          return;
        }
      }
      if (disposed) return;
      // Reconnexion (idleTimeout Bun, au plus 255 s, réseau, redéploiement) :
      // on reprend à `streamCursor`. Pas de GET tant que le curseur est dans
      // la fenêtre de rejeu. Le trou (`stream.gap`, y compris hors fenêtre
      // après un restart) relit fil, roster et courrier. Mesure du 24-08 :
      // sans ce trou, un run terminé pendant un restart laissait « Réfléchit… ».
      // Exception : un flux déjà en marche, plus avancé que ce snapshot, a pu
      // consommer des événements de ce fil avant cet abonnement.
      const position = organizationStreamPosition();
      let mayHaveMissed = position.running && position.cursor > initialStreamCursor;
      const onStatus = (connected: boolean) => {
        if (connected) {
          const refresh = refetchOnStreamOpen(mayHaveMissed);
          if (refresh.thread) scheduleInvalidate(queryKeys.thread(threadId));
          if (refresh.roster) scheduleInvalidate(queryKeys.roster);
          mayHaveMissed = false;
        }
        setStreaming(connected);
      };
      // Le serveur a relevé le curseur du flux (fenêtre de rejeu dépassée) :
      // ce qu'il ne rendra pas se relit : fil, roster, courrier. Sauf si le
      // trou s'arrête avant notre propre point d'attache : c'est alors un
      // autre abonné (notifications, curseur persistant ancien) qui a ouvert
      // le flux plus bas que nous, et rien ne manque à cet écran.
      const onGap = (gap: StreamGap) => {
        if (gap.to <= initialStreamCursor) return;
        scheduleInvalidate(queryKeys.thread(threadId));
        scheduleInvalidate(queryKeys.roster);
        scheduleInvalidate(queryKeys.inbox);
      };
      // Un run qui tourne peut émettre des dizaines d'événements par seconde
      // (delta de texte, appels d'outil…) ; appliquer chacun dans son propre
      // `setQueryData` déclenchait autant de rendus de la timeline. Les
      // événements sont donc mis en file ici, et la file entière est réduite
      // en UN patch du roster et UN patch du fil par frame (`flushBuffered`),
      // sans changer ni l'ordre ni les décisions de relecture ci-dessous.
      let buffered: OrganizationEvent[] = [];
      // Les fragments d'une réponse confirmée attendent ici ; seule sa bulle les lit (`liveText`).
      const hold = createLiveTextHold(() => performance.now());
      let holdTimer: ReturnType<typeof setTimeout> | null = null;
      // Runs de ce fil qui ont appelé l'outil de proposition de réglages : la
      // proposition est écrite côté serveur, le patch du `run.completed` ne la
      // porte pas, donc leur fin relit le fil (une seule fois par run).
      const proposalRuns = new Set<string>();
      let flushFrame: number | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelScheduledFlush = () => {
        if (flushFrame !== null) {
          cancelAnimationFrame(flushFrame);
          flushFrame = null;
        }
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      };
      const flushBuffered = (releaseHeld = false) => {
        cancelScheduledFlush();
        if (buffered.length === 0 && (!releaseHeld || hold.dueIn(0) === null)) return;
        const events = buffered;
        buffered = [];
        let roster = queryClient.getQueryData<RosterDto>(queryKeys.roster);
        let rosterTouched = false;
        let snapshot = queryClient.getQueryData<ThreadView>(queryKeys.thread(threadId));
        let snapshotTouched = false;
        let invalidateThread = false;
        let invalidateRoster = false;
        const invalidateExtra = new Set<string>();
        const apply = (event: OrganizationEvent) => {
          const productEvent = event as unknown as StoredProductEvent;
          const terminal = isTerminalProductEvent(productEvent);
          // Un événement de curseur ≤ `roster.cursor` (le max lu en premier
          // dans la transaction du roster, l'ordre des curseurs étant celui
          // des commits) était déjà commité quand roster, courrier et
          // mémoires ont été lus : rejeu de reconnexion ou rattrapage, il
          // n'apprend rien à personne. Sans cette garde, chaque rejeu
          // relisait le courrier et les mémoires, et marquait non-lu des fils
          // déjà lus. Par curseur et non par date : `occurredAt` est l'heure
          // de capture worker, pas celle du commit. Roster sans curseur (API
          // antérieure) : on ne sait pas, on laisse passer : seule la garde
          // par ligne s'applique alors.
          const alreadyKnown = isStaleRosterEvent({ cursor: event.cursor }, roster);
          if (!alreadyKnown) {
            // Une directive `remember:` est commitée avec `run.completed`.
            // Marquer toutes les mémoires du tenant comme périmées garde le
            // panneau juste, y compris si le run terminé appartient à un
            // autre fil que celui actuellement ouvert.
            if (event.type === "run.completed") {
              invalidateExtra.add(JSON.stringify(["organization", event.organizationId, "bot-memories"]));
            }
            // Le courrier compte les approbations ouvertes, les issues
            // incertaines et les runs conclus.
            const ambiguousSteering = event.type === "run.steering" && event.payload.status === "ambiguous";
            if (
              terminal || event.type === "approval.requested" || event.type === "approval.responded" ||
              ambiguousSteering
            ) {
              invalidateExtra.add(JSON.stringify(queryKeys.inbox));
            }
            // Le roster projette TOUS les fils : la ligne du fil de
            // l'événement est patchée en cache : aperçu, horodatage, non-lu,
            // pastille : au lieu d'être relue au serveur à chaque événement.
            // La relecture périodique (`board-sidebar.tsx`) et celle des
            // mutations restent.
            if (roster) {
              const nextRoster = applyProductEventToRoster(roster, event as unknown as RosterEvent, { openThreadId: threadId });
              if (nextRoster !== roster) {
                roster = nextRoster;
                rosterTouched = true;
              }
            }
          }
          if (event.threadId !== threadId) return;
          if (typeof event.cursor === "number" && Number.isSafeInteger(event.cursor)) {
            cursorRef.current = Math.max(cursorRef.current, event.cursor);
          }
          const knownCursor = snapshot?.cursor;
          const hadSnapshot = snapshot !== undefined;
          if (snapshot) {
            const next = applyProductEventToSnapshot(snapshot, productEvent);
            if (next !== snapshot) {
              snapshot = { ...next, approvals: snapshot.approvals };
              snapshotTouched = true;
            }
          }
          // La fin d'un run ne relit plus le fil entier quand le serveur a
          // joint le contenu persisté à son événement terminal
          // (`payload.completion`, voir
          // `apps/api/src/terminal-event-completion.ts`) : le message final,
          // la ligne du run conclue et son workflow sont appliqués au
          // snapshot en cache. Le repli est explicite : bloc absent (API
          // antérieure), bloc illisible, ou run encore absent après le
          // patch. Pas de `run.created` dans le contrat : un delta ne porte
          // pas de `RunDto`, on n'invente pas `input` / `createdAt`.
          // Le roster n'est relu que pour un run que le snapshot ne connaît
          // pas (donc peut-être un bot ou un fil que le roster ignore
          // aussi) ; tout le reste est déjà patché en cache ci-dessus. Un
          // événement que le snapshot contenait déjà (rejeu de reconnexion)
          // ne relit rien.
          const refresh = refreshAfterAppliedEvent({
            event: productEvent,
            hadSnapshot,
            snapshotAfter: snapshot,
            snapshotCursorBefore: knownCursor,
          });
          if (refresh.thread) invalidateThread = true;
          if (refresh.roster) invalidateRoster = true;
          if (
            (event.type === "tool.call" || event.type === "tool.result")
            && typeof event.payload.tool === "string"
            && event.payload.tool.includes("bot_settings_propose")
          ) proposalRuns.add(event.runId);
          if (terminal && proposalRuns.delete(event.runId)) invalidateThread = true;
        };
        const applyHeld = () => { for (const held of hold.release()) apply(held as unknown as OrganizationEvent); };
        // La retenue est toujours la fin du flux : tout événement qu'elle ne
        // prend pas la relâche d'abord, l'ordre du flux reste celui du patch.
        for (const event of events) {
          const mine = event.threadId === threadId;
          if (mine) liveText.record(event as unknown as StoredProductEvent);
          if (mine && hold.offer(event as unknown as StoredProductEvent, snapshot)) continue;
          applyHeld();
          apply(event);
        }
        if (releaseHeld || hold.dueIn(performance.now()) === 0) applyHeld();
        if (holdTimer !== null) clearTimeout(holdTimer);
        const due = hold.dueIn(performance.now());
        holdTimer = due === null ? null : setTimeout(() => flushBuffered(true), due);
        liveText.publish();
        // One notification tick for both keys: the conversation
        // screen observes the roster and the thread, and two separate
        // `setQueryData` calls rendered it twice per flush.
        notifyManager.batch(() => {
          if (rosterTouched) queryClient.setQueryData<RosterDto>(queryKeys.roster, roster);
          if (snapshotTouched && snapshot) queryClient.setQueryData<ThreadView>(queryKeys.thread(threadId), asLocalPatch(snapshot));
        });
        for (const key of invalidateExtra) scheduleInvalidate(JSON.parse(key) as readonly unknown[]);
        if (invalidateThread) scheduleInvalidate(queryKeys.thread(threadId));
        if (invalidateRoster) scheduleInvalidate(queryKeys.roster);
      };
      const scheduleFlush = () => {
        if (flushFrame !== null || flushTimer !== null) return;
        // Un onglet en arrière-plan ne reçoit plus (ou presque plus) de
        // `requestAnimationFrame` : le repli en `setTimeout` garde le fil à
        // jour pendant qu'il n'est pas visible, au lieu de tout accumuler
        // jusqu'au retour au premier plan.
        const hidden = typeof document !== "undefined" && document.hidden;
        if (!hidden && typeof requestAnimationFrame === "function") {
          flushFrame = requestAnimationFrame(() => {
            flushFrame = null;
            flushBuffered();
          });
        } else {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flushBuffered();
          }, 200);
        }
      };
      stop = subscribeToOrganizationEvents((event) => {
        buffered.push(event);
        scheduleFlush();
      }, onStatus, initialStreamCursor, onGap);
      return () => {
        cancelScheduledFlush();
        flushBuffered(true);
        if (holdTimer !== null) clearTimeout(holdTimer);
      };
    };
    const disposeStart = start();
    return () => {
      disposed = true;
      stop();
      void disposeStart.then((dispose) => dispose?.());
    };
  }, [threadId, queryClient, sessionRevision, snapshotReady]);

  useEffect(() => {
    const snapshot = thread.data;
    if (!threadId || !isCurrentThreadSnapshot(snapshot, threadId)) return;
    // The event can arrive while the first snapshot request is still in
    // flight and before a cache object exists for `setQueryData`. In that
    // narrow case the query-level stale-response guard has nothing to retain;
    // this backfill performs the committed read that recovers the event.
    if (snapshot.cursor < cursorRef.current) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
      return;
    }
    cursorRef.current = Math.max(cursorRef.current, snapshot.cursor);
    setSwitching(false);
  }, [thread.data, threadId, queryClient]);

  return { thread, streaming, switching, loading: switching || thread.isPending, loadOlder, liveText: liveView,
    loadingOlder: olderState.threadId === threadId && olderState.loading,
    olderError: olderState.threadId === threadId && olderState.error };
}
