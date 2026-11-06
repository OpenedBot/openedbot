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

// Le poller de base de données est l'unique publieur live des lignes durables :
// une seule source ordonnée par organisation empêche deux commits concurrents
// de livrer un curseur plus haut avant un plus bas. Une notification ne porte
// aucune donnée : elle ne fait que réveiller une lecture depuis le curseur.
//
// Ce qui le réveille (ADR 0001, S6) :
// - LISTEN `openedbot_events` (`event-notifications.ts`), chemin NOMINAL : le
//   trigger 0005 notifie chaque commit de `run_events` à toutes les répliques,
//   quel que soit l'écrivain (worker, API, plug-in) ;
// - chaque (ré)abonnement LISTEN : `wakeAllReplayPollers`, rattrapage de ce
//   qui a été commité pendant la coupure ;
// - le hint HTTP post-commit du worker (`POST /internal/events/publish`),
//   REPLI seulement, tant que LISTEN n'est pas établi sur cette réplique ;
// - le sondage périodique (`API_EVENTS_FALLBACK_POLL_MS`, 5 s par défaut),
//   FILET : notification perdue sans coupure détectée, LISTEN indisponible.

export type OrderedReplayPump = {
  /** Coalesces any number of commit notifications into one ordered DB read. */
  wake(): void;
  /** Prevents a released organization's in-flight read from scheduling more work. */
  close(): void;
};

/**
 * Le minimum qu'une source doit porter pour passer dans la pompe : un curseur
 * monotone. `run_events` et `support_events` le portent tous deux, et c'est la
 * seule chose que l'ordonnancement regarde.
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
 * Les pollers d'un processus, par hub : deux hubs (deux instances d'API dans
 * un même processus de test) ne partagent jamais une pompe qui publierait
 * dans le hub de l'autre.
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
 * Prend (ou partage) le poller de l'organisation sur ce hub. La première
 * connexion fixe le curseur de départ et la cadence du filet ; les suivantes
 * s'y joignent. Rend la fonction qui le relâche.
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

/** Réveille la lecture d'une organisation, si une connexion de ce hub la suit. */
export function wakeReplayPoller(hub: EventHub, organizationId: string): void {
  pollersByHub.get(hub)?.get(organizationId)?.pump.wake();
}

/** Rattrapage de toutes les organisations suivies (abonnement LISTEN repris). */
export function wakeAllReplayPollers(hub: EventHub): void {
  for (const poller of pollersByHub.get(hub)?.values() ?? []) poller.pump.wake();
}

/** Organisations suivies par ce hub (métriques). */
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
 * Le lien LISTEN d'un processus d'API branché sur ses pollers : une
 * notification réveille l'organisation notifiée, chaque (ré)abonnement les
 * réveille toutes. Le ping de vivacité part par le pool ordinaire.
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
  }, {
    ping: async (payload) => { await db`select pg_notify(${EVENTS_CHANNEL}, ${payload})`; },
    ...options,
  });
}
