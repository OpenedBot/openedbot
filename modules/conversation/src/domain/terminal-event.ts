import type { ProductRunStatus } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { SUPERSEDED_NOTICE_KIND } from "./followup";
/**
 * Le type et la charge utile suffisent à classer un événement. La signature
 * est volontairement plus large que `StoredProductEvent` : le cloud API
 * applique le même test à des LIGNES de `run_events`, dont `occurredAt` est
 * une chaîne, refaire le test là-bas ferait diverger la définition de
 * « terminal » entre le producteur et les clients.
 */
export type ClassifiableEvent = Pick<StoredProductEvent, "type" | "payload"> &
  Partial<Omit<StoredProductEvent, "type" | "payload">>;

export function isReceiptOnlyEvent(event: Pick<StoredProductEvent, "type">): boolean {
  return event.type === "message.admitted" || event.type === "run.steering";
}

export function statusFromEvent(event: ClassifiableEvent): ProductRunStatus | null {
  if (isReceiptOnlyEvent(event)) return null;
  if (event.type === "approval.requested") return "awaiting_approval";
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.error") return "failed";
  if (event.type === "system.notice" && (event.payload.kind === "cancelled" || event.payload.kind === SUPERSEDED_NOTICE_KIND)) {
    return "cancelled";
  }
  return null;
}

export function isTerminalProductEvent(event: ClassifiableEvent) {
  const status = statusFromEvent(event);
  return status === "completed" || status === "failed" || status === "cancelled";
}
