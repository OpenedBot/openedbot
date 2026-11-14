/**
 * Whether an organization's gates can go to the automatic reviewer (PERM2-7).
 *
 * The reviewer is not part of the open core: it is the `approvalReviewer`
 * port of the plug-in `permissions` (`ApprovalReviewerPort` of
 * `@openedbot/platform-plugins`; the API and the worker install it at boot).
 * Without it (solo, or no such plug-in) every answer is `false`: `auto`
 * acts as `manual` (`effectivePermissionModeTx`), a new bot starts in
 * `manual`, and no gate is born `reviewing`.
 *
 * The check runs inside the caller's transaction, in a savepoint when the
 * transaction has one: a reviewer whose read fails leaves the caller's
 * transaction usable, and reads as "not ready", never as a widened decision.
 * The hook always gets a transaction bound to the organization it is asked
 * about (`app.organization_id`), whatever tenant the caller's transaction
 * held; the caller's setting is put back afterwards. A caller holding the
 * pool, not a transaction, goes through `effectivePermissionModeFor`.
 */
import { withTenant, type Db, type TransactionDb } from "@openedbot/platform-db";

export type ApprovalReviewerReadiness = {
  ready(tx: unknown, organizationId: string): Promise<boolean>;
};

let installed: ApprovalReviewerReadiness | null = null;
let onReadyError: (error: unknown) => void = () => undefined;

/** `null` puts the core's default back (tests, a process without the plug-in). */
export function installApprovalReviewer(next: ApprovalReviewerReadiness | null, onError: (error: unknown) => void = () => undefined): void {
  installed = next;
  onReadyError = onError;
}

/** Is a reviewer installed in this process at all? */
export function approvalReviewerInstalled(): boolean {
  return installed !== null;
}

/**
 * The mode a gate is decided under, per organization, in the caller's
 * transaction: `auto` stays `auto` only while the installed reviewer is ready
 * for that organization (`reviewerReady`); otherwise it IS `manual`. There is
 * deliberately no process-wide shortcut: a reviewer can be installed and not
 * ready for one organization.
 * Every run context resolves its mode here, so the legacy auto-approval, the
 * prompt's operator settings, the routine tool and the gate share it with
 * what the console shows, and the host approval policy is written from it.
 */
export async function effectivePermissionModeTx<M extends string | null | undefined>(
  tx: TransactionDb,
  organizationId: string,
  mode: M,
): Promise<M | "manual"> {
  if (mode !== "auto") return mode;
  return (await reviewerReady(tx, organizationId)) ? mode : "manual";
}

type MaybeSavepoint = { savepoint?: <T>(callback: (sp: TransactionDb) => Promise<T>) => Promise<T> };

/** Runs `work` with `app.organization_id` set to `organizationId`, then puts the previous value back. */
async function asTenant<T>(tx: TransactionDb, organizationId: string, work: () => Promise<T>): Promise<T> {
  const rows = await tx<Array<{ previous: string }>>`
    select coalesce(current_setting('app.organization_id', true), '') as previous
  `;
  await tx`select set_config('app.organization_id', ${organizationId}, true)`;
  try {
    return await work();
  } finally {
    await tx`select set_config('app.organization_id', ${rows[0]?.previous ?? ""}, true)`;
  }
}

export async function reviewerReady(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const reviewer = installed;
  if (!reviewer) return false;
  try {
    const savepoint = (tx as unknown as MaybeSavepoint).savepoint;
    const ready = typeof savepoint === "function"
      ? await savepoint.call(tx, (sp: TransactionDb) => asTenant(sp, organizationId, () => reviewer.ready(sp, organizationId)))
      : await asTenant(tx, organizationId, () => reviewer.ready(tx, organizationId));
    return ready === true;
  } catch (error) {
    onReadyError(error);
    return false;
  }
}

/**
 * `effectivePermissionModeTx` for a caller holding the pool, not a
 * transaction: the readiness is read in a transaction scoped to that
 * organization. The host approval policy (save, provision, tool policies,
 * reconciliation) is written from this mode, never from the process-wide one.
 */
export async function effectivePermissionModeFor<M extends string | null | undefined>(
  db: Db,
  organizationId: string,
  mode: M,
): Promise<M | "manual"> {
  if (mode !== "auto") return mode;
  return withTenant(db, organizationId, (tx) => effectivePermissionModeTx(tx, organizationId, mode));
}
