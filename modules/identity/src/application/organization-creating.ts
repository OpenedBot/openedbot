/**
 * `onOrganizationCreating` (open-core step 8d): what billing attaches to a
 * new organization (its welcome subscription), run INSIDE the creation
 * transaction, right after the organization and its owner membership are
 * written. Only the plug-in billing may provide it (the loader refuses it
 * from any other id); without it (solo) nothing runs and no subscription is
 * written.
 *
 * Modelled on `onTenantDeleting`, not on `onOrganizationCreated`: a failure
 * here is not swallowed, it rolls the creation back, so an organization
 * never exists without what billing wanted to attach to it. A listener that
 * does not answer within `timeoutMs` fails the same way, so it cannot hold
 * the creation transaction and its locks: the JavaScript side is raced
 * against a timer, and the database side is bounded by a transaction-local
 * `statement_timeout` for the listener's statements only (restored before
 * the creation goes on).
 */
import type { TransactionDb } from "@openedbot/platform-db";

export type OrganizationCreatingEvent = {
  organizationId: string;
  kind: string;
  /** `billing.enforced`, resolved by the caller. */
  billingEnforced: boolean;
  environment: "development" | "test" | "production";
};
export type OrganizationCreatingListener = (tx: TransactionDb, event: OrganizationCreatingEvent) => Promise<void>;

/** Short: the creation is a user waiting on a request. */
export const DEFAULT_ORGANIZATION_CREATING_TIMEOUT_MS = 2_000;

export class OrganizationCreatingError extends Error {
  constructor(readonly organizationId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OrganizationCreatingError";
  }
}

let listener: OrganizationCreatingListener | null = null;
let timeoutMs = DEFAULT_ORGANIZATION_CREATING_TIMEOUT_MS;

export function installOrganizationCreatingListener(next: OrganizationCreatingListener | null, options: { timeoutMs?: number } = {}): void {
  listener = next;
  timeoutMs = options.timeoutMs ?? DEFAULT_ORGANIZATION_CREATING_TIMEOUT_MS;
}

/** Runs the listener in the creation transaction; throws `OrganizationCreatingError` on failure or timeout. */
export async function runOrganizationCreating(tx: TransactionDb, event: OrganizationCreatingEvent): Promise<void> {
  const current = listener;
  if (!current) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OrganizationCreatingError(
      event.organizationId,
      `onOrganizationCreating did not answer within ${timeoutMs} ms`,
    )), timeoutMs);
  });
  const previous = await tx<Array<{ value: string }>>`select current_setting('statement_timeout') as value`;
  await tx`select set_config('statement_timeout', ${String(timeoutMs)}, true)`;
  try {
    await Promise.race([Promise.resolve().then(() => current(tx, event)), timeout]);
    await tx`select set_config('statement_timeout', ${previous[0]?.value ?? "0"}, true)`;
  } catch (error) {
    if (error instanceof OrganizationCreatingError) throw error;
    throw new OrganizationCreatingError(
      event.organizationId,
      `onOrganizationCreating failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
