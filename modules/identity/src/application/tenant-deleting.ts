/**
 * `onTenantDeleting`: what must go with a tenant when it is purged, run
 * INSIDE the purge transaction, just before the organization row is deleted.
 *
 * Unlike `onOrganizationCreated`, a failure here is not swallowed: it fails
 * the purge (the transaction rolls back and the worker retries later), so no
 * data owned by a listener is left behind for an organization that is gone.
 * A listener that does not answer within `timeoutMs` fails the same way,
 * so it cannot hold the purge transaction and its locks: the JavaScript side
 * is raced against a timer, and the database side is bounded by a
 * transaction-local `statement_timeout` for the listener's statements only
 * (restored before the purge goes on).
 */
import type { TransactionDb } from "@openedbot/platform-db";

export type TenantDeletingEvent = { organizationId: string; reason: string };
export type TenantDeletingListener = (tx: TransactionDb, event: TenantDeletingEvent) => Promise<void>;

export const DEFAULT_TENANT_DELETING_TIMEOUT_MS = 2_000;

export class TenantDeletingError extends Error {
  constructor(readonly organizationId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TenantDeletingError";
  }
}

let listener: TenantDeletingListener | null = null;
let timeoutMs = DEFAULT_TENANT_DELETING_TIMEOUT_MS;

export function installTenantDeletingListener(next: TenantDeletingListener | null, options: { timeoutMs?: number } = {}): void {
  listener = next;
  timeoutMs = options.timeoutMs ?? DEFAULT_TENANT_DELETING_TIMEOUT_MS;
}

/** Runs the listener in the purge transaction; throws `TenantDeletingError` on failure or timeout. */
export async function runTenantDeleting(tx: TransactionDb, event: TenantDeletingEvent): Promise<void> {
  const current = listener;
  if (!current) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TenantDeletingError(
      event.organizationId,
      `onTenantDeleting did not answer within ${timeoutMs} ms`,
    )), timeoutMs);
  });
  const previous = await tx<Array<{ value: string }>>`select current_setting('statement_timeout') as value`;
  await tx`select set_config('statement_timeout', ${String(timeoutMs)}, true)`;
  try {
    await Promise.race([Promise.resolve().then(() => current(tx, event)), timeout]);
    await tx`select set_config('statement_timeout', ${previous[0]?.value ?? "0"}, true)`;
  } catch (error) {
    if (error instanceof TenantDeletingError) throw error;
    throw new TenantDeletingError(
      event.organizationId,
      `onTenantDeleting failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
