import type { StoredProductEvent } from "@openedbot/contracts-events";

/** A thread's events grouped by run (`thread-timeline-model.ts`). */
export type EventsByRun = ReadonlyMap<string, readonly StoredProductEvent[]>;

/** Receipts carry metadata for the stream (admission, steering), not something the thread shows. */
export function isMetadataReceipt(event: StoredProductEvent): boolean {
  return event.type === "message.admitted" || event.type === "run.steering";
}

export function withoutReceipts(events: readonly StoredProductEvent[]): StoredProductEvent[] {
  return events.filter((event) => !isMetadataReceipt(event));
}

export function bucketEventsByRun(events: readonly StoredProductEvent[]): Map<string, StoredProductEvent[]> {
  const eventsByRun = new Map<string, StoredProductEvent[]>();
  for (const event of events) {
    const bucket = eventsByRun.get(event.runId) ?? [];
    bucket.push(event);
    eventsByRun.set(event.runId, bucket);
  }
  return eventsByRun;
}
