import type { SQL } from "bun";
import { organizationEventEnvelope, type OrganizationEvent } from "@openedbot/contracts-events";
import type { WorkerConfig } from "../worker-config";
import type { EventContext, RunEventIdentityRow } from "./types";
import { describe, log } from "./util";

/**
 * Ajoute un `system.notice` au run dans la transaction courante, à la suite
 * des événements déjà écrits (même mécanique que failWithoutUsableProvider :
 * séquence recalculée, enveloppe publiée par l'appelant).
 */
export async function appendEventTx(
  tx: SQL,
  context: EventContext,
  type: string,
  payload: Record<string, unknown>,
): Promise<OrganizationEvent | null> {
  await lockRunEventCursorTx(tx, context.organizationId);
  const sequenceRows = await tx<Array<{ next: number }>>`
    select coalesce(max(sequence), -1) + 1 as next from run_events
     where organization_id = ${context.organizationId} and run_id = ${context.id}
  `;
  const sequence = Number(sequenceRows[0]?.next ?? 0);
  const occurredAt = new Date();
  const rows = await tx<RunEventIdentityRow[]>`
    insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)
    values (${context.organizationId}, ${context.threadId}, ${context.id}, ${sequence},
            ${type}, ${payload}, ${occurredAt})
    on conflict (organization_id, run_id, sequence) do nothing
    returning cursor, bot_id as "botId", turn_id as "turnId", session_key as "sessionKey",
              lease_generation as "leaseGeneration"
  `;
  const row = rows[0];
  if (!row) return null;
  return organizationEventEnvelope({
    ...row, organizationId: context.organizationId, threadId: context.threadId,
    runId: context.id, sequence, type, payload, occurredAt,
  });
}

export async function appendNoticeTx(
  tx: SQL,
  context: EventContext,
  payload: Record<string, unknown>,
): Promise<OrganizationEvent | null> {
  return appendEventTx(tx, context, "system.notice", payload);
}

export async function appendRunErrorTx(
  tx: SQL,
  context: EventContext,
  message: string,
  errorCode: string,
): Promise<OrganizationEvent | null> {
  return appendEventTx(tx, context, "run.error", { message, errorCode });
}

/**
 * Identity cursors must be allocated in commit order. All run-event writers
 * take this organization-scoped transaction lock before their first insert;
 * the SSE poller can then advance a cursor without skipping an uncommitted
 * lower identity from a concurrent run.
 */
export async function lockRunEventCursorTx(tx: SQL, organizationId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('openedbot-run-events-cursor'))`;
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
