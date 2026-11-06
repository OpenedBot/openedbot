import type { SQL } from "bun";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { WorkerConfig } from "../worker-config";
import { appendRunEventsTx } from "../../sql/run-events";
import type { EventContext } from "./types";
import { describe, log } from "./util";

/**
 * Ajoute un événement au run dans la transaction courante, à la suite des
 * événements déjà écrits : la séquence est allouée par la primitive
 * (`sql/run-events.ts`), sous le verrou du run puis celui du curseur ;
 * l'enveloppe est publiée par l'appelant.
 */
export async function appendEventTx(
  tx: SQL,
  context: EventContext,
  type: string,
  payload: Record<string, unknown>,
): Promise<OrganizationEvent> {
  const [envelope] = await appendRunEventsTx(tx, [{
    organizationId: context.organizationId, threadId: context.threadId, runId: context.id,
    type, payload, occurredAt: new Date(),
  }]);
  return envelope!;
}

export async function appendNoticeTx(
  tx: SQL,
  context: EventContext,
  payload: Record<string, unknown>,
): Promise<OrganizationEvent> {
  return appendEventTx(tx, context, "system.notice", payload);
}

export async function appendRunErrorTx(
  tx: SQL,
  context: EventContext,
  message: string,
  errorCode: string,
): Promise<OrganizationEvent> {
  return appendEventTx(tx, context, "run.error", { message, errorCode });
}

export async function publish(
  config: Pick<WorkerConfig, "apiInternalUrl" | "apiInternalToken">,
  event: OrganizationEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await fetchImpl(`${config.apiInternalUrl}/internal/events/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiInternalToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    log("worker.event_publish_failed", { cursor: event.cursor, error: describe(error) });
  }
}

/**
 * One POST for the whole batch (`{ events: [...] }`, order preserved); a single
 * event keeps the original one-event body. Best effort like `publish`.
 */
export async function publishBatch(
  config: Pick<WorkerConfig, "apiInternalUrl" | "apiInternalToken">,
  events: OrganizationEvent[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (events.length === 0) return;
  if (events.length === 1) return publish(config, events[0]!, fetchImpl);
  try {
    const response = await fetchImpl(`${config.apiInternalUrl}/internal/events/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiInternalToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    log("worker.event_publish_failed", { cursor: events[0]!.cursor, count: events.length, error: describe(error) });
  }
}

/**
 * Délai maximal avant que le réveil post-commit d'un flush de deltas parte
 * seul. Il s'accroche d'abord au POST pré-commit du flush suivant (un seul
 * POST par flush) ; ce délai ne joue que si le flux se tait.
 */
export const DEFERRED_WAKE_MS = 250;

type DeferredWake = { envelope: OrganizationEvent; timer: ReturnType<typeof setTimeout> };

const deferredWakes = new Map<string, DeferredWake>();

/**
 * Le réveil post-commit ne porte aucune donnée : l'API relit la base. Pour un
 * lot dont toutes les trames sont déjà parties en pré-commit, on le garde un
 * instant au lieu d'un second POST. Perdu (worker arrêté), il retombe sur le
 * sondage de repli de l'API, comme un hint en échec.
 */
export function deferWake(
  config: Pick<WorkerConfig, "apiInternalUrl" | "apiInternalToken">,
  runId: string,
  envelope: OrganizationEvent,
  fetchImpl: typeof fetch = fetch,
): void {
  const previous = deferredWakes.get(runId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    deferredWakes.delete(runId);
    void publishBatch(config, [envelope], fetchImpl);
  }, DEFERRED_WAKE_MS);
  timer.unref?.();
  deferredWakes.set(runId, { envelope, timer });
}

/** Retire le réveil en attente d'un run, pour le joindre au prochain POST. */
export function takeDeferredWake(runId: string): OrganizationEvent | null {
  const pending = deferredWakes.get(runId);
  if (!pending) return null;
  clearTimeout(pending.timer);
  deferredWakes.delete(runId);
  return pending.envelope;
}

/** Envoie tout de suite le réveil en attente d'un run (tests, arrêt propre). */
export async function flushDeferredWake(
  config: Pick<WorkerConfig, "apiInternalUrl" | "apiInternalToken">,
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const envelope = takeDeferredWake(runId);
  if (envelope) await publishBatch(config, [envelope], fetchImpl);
}
