/**
 * Which `PermissionRuleSource` decides an organization's `v2` gates. Solo:
 * always the core's. The worker installs a selector when the plug-in
 * `permissions` is loaded (`apps/worker/src/application/pro-plugins.ts`); it
 * answers that plug-in's source for an organization holding `permissions.v2`
 * and `null` otherwise, which keeps the core's. A selector that throws keeps
 * the core's too: a plug-in failure never changes a decision.
 */
import type { SQL } from "bun";
import type { PermissionRuleSource, ResolvedPermissionRuleSource } from "../../domain/permission-rules";
import { corePermissionRuleSource } from "./core-permission-rules";

export type PermissionRuleSelector = (organizationId: string) => Promise<PermissionRuleSource | null>;

let selector: PermissionRuleSelector | null = null;
let onSelectorError: (error: unknown) => void = () => undefined;

/** `null` puts solo back (tests, a worker without the plug-in). */
export function installPermissionRuleSelector(next: PermissionRuleSelector | null, onError: (error: unknown) => void = () => undefined): void {
  selector = next;
  onSelectorError = onError;
}

/** A plug-in's source, its missing members taken from the core's. */
function resolved(source: PermissionRuleSource): ResolvedPermissionRuleSource {
  if (source === corePermissionRuleSource) return corePermissionRuleSource;
  const { unattended } = source;
  return {
    read: (tx, query) => source.read(tx, query),
    unattended: unattended ? (tx, query) => unattended.call(source, tx, query) : corePermissionRuleSource.unattended,
  };
}

export async function permissionRuleSourceFor(organizationId: string): Promise<ResolvedPermissionRuleSource> {
  if (!selector) return corePermissionRuleSource;
  try {
    const selected = await selector(organizationId);
    return selected ? resolved(selected) : corePermissionRuleSource;
  } catch (error) {
    onSelectorError(error);
    return corePermissionRuleSource;
  }
}

/**
 * Locks a run's workflow `for update` (the caller already holds the run: the
 * forwarder's order, runner/approval-forwarding.ts) and, given a source, reads its "Never wait"
 * through it (PERM2-9). No workflow, or a workflow gone: someone may answer.
 * The source is resolved by the caller before its transaction: a slow
 * entitlement hook never holds these locks.
 */
export async function lockWorkflowTx(
  tx: SQL,
  organizationId: string,
  workflowId: string | null,
  unattendedFrom: ResolvedPermissionRuleSource | null,
): Promise<boolean> {
  if (!workflowId) return false;
  const locked = await tx<Array<{ id: string }>>`
    select id from workflows where organization_id = ${organizationId} and id = ${workflowId} for update
  `;
  if (!locked[0] || !unattendedFrom) return false;
  return (await unattendedFrom.unattended(tx, { organizationId, workflowId })) === true;
}
