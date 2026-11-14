import { HermesClientError, type HermesApprovalPolicyMode, type HermesApprovalPolicyState, type HermesClient, type HermesClientConfig } from "@openedbot/hermes";
import { approvalPolicyMode, type PermissionPipelineId } from "@openedbot/runtimes/domain/runtime-contract";
import type { BotPermissionMode } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { effectivePermissionModeFor } from "@openedbot/runtimes/application/approval-reviewer";
import { RELAY_FEATURE_APPROVAL_POLICY } from "@openedbot/contracts-connector/features";

export type ApprovalPolicyClient = Pick<HermesClient, "hostSetApprovalPolicy" | "hostApprovalPolicy">;

/**
 * The mode a host policy is written from: the one the runner applies to this
 * organization (`effectivePermissionModeFor`, its readiness read in a
 * transaction scoped to it). A stored `auto` whose organization has no ready
 * reviewer is `manual`, so the host asks for writes exactly when the runner
 * does. Every mode the functions below take is this effective one.
 */
export function hostPolicyPermissionMode<M extends BotPermissionMode | undefined>(db: Db, organizationId: string, mode: M): Promise<M | "manual"> {
  return effectivePermissionModeFor(db, organizationId, mode);
}

export function approvalPolicyWriteMustPrecedeCommit(effectiveMode: BotPermissionMode): boolean {
  return effectiveMode === "manual" || effectiveMode === "plan";
}

export async function applyTighteningPolicyBeforeMutation<T>(
  mode: BotPermissionMode,
  apply: () => Promise<void>,
  mutate: () => Promise<T>,
): Promise<T> {
  if (approvalPolicyWriteMustPrecedeCommit(mode)) await apply();
  return mutate();
}

/**
 * PERM2-2: under `v2` the pipeline decides from the gate's identity, so a
 * plugin that cannot name its gates (an older host) is not effective there.
 */
export function effectiveHostPolicy(
  state: HermesApprovalPolicyState,
  pipeline: PermissionPipelineId,
  blockedTools?: readonly string[],
): HermesApprovalPolicyState {
  if (pipeline === "v2" && !state.gateIdentity) return { ...state, effective: false };
  // PERM2-5: a `block` the host does not hold is not in force there.
  if (blockedTools !== undefined && !hostBlockedToolsMatch(state, blockedTools)) return { ...state, effective: false };
  return state;
}

/** The host's blocked list in the order it is written: byte order, no duplicate. */
export function blockedToolsForHost(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The re-read list equals the stored blocked keys. A host that cannot block
 * (`blockedTools: null`, older than PERM2-A) only matches an empty list.
 */
export function hostBlockedToolsMatch(state: HermesApprovalPolicyState, blockedTools: readonly string[]): boolean {
  const expected = blockedToolsForHost(blockedTools);
  const actual = state.blockedTools ?? [];
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Writes and reads the bounded host policy. The read-back is the persisted
 * proof. With `blockedTools` (PERM2-5) the profile list is replaced by the
 * stored blocked keys and the proof requires the re-read list to equal them;
 * without it the host keeps its list and the proof does not look at it.
 */
export async function applyHostApprovalPolicy(
  runtime: { client: HermesClientConfig; linkFeatures?: readonly string[] | null },
  profile: string,
  permissionMode: BotPermissionMode,
  pipeline: PermissionPipelineId,
  clientFactory: (config: HermesClientConfig) => ApprovalPolicyClient,
  blockedTools?: readonly string[],
): Promise<HermesApprovalPolicyState | null> {
  if (!runtime.linkFeatures?.includes(RELAY_FEATURE_APPROVAL_POLICY)) return null;
  return applyHostApprovalPolicyWithClient(clientFactory(runtime.client), profile, permissionMode, pipeline, blockedTools);
}

export async function applyHostApprovalPolicyWithClient(
  client: ApprovalPolicyClient,
  profile: string,
  permissionMode: BotPermissionMode,
  pipeline: PermissionPipelineId,
  blockedTools?: readonly string[],
): Promise<HermesApprovalPolicyState> {
  // `permissionMode` is already effective: an unreviewed `auto` came as `manual`.
  const expected = approvalPolicyMode(permissionMode, pipeline) as HermesApprovalPolicyMode;
  const blocked = blockedTools === undefined ? undefined : blockedToolsForHost(blockedTools);
  // A host older than PERM2-A rejects nothing it does not know but never
  // returns the list: an empty list is only sent when the host holds one,
  // so such a host keeps working while nothing is blocked.
  let written = await client.hostSetApprovalPolicy(profile, expected, blocked && blocked.length > 0 ? blocked : undefined);
  if (blocked && blocked.length === 0 && (written.blockedTools?.length ?? 0) > 0) {
    written = await client.hostSetApprovalPolicy(profile, expected, []);
  }
  const readback = await client.hostApprovalPolicy(profile);
  if (written.mode !== expected || !written.pluginEnabled || readback.mode !== expected || !readback.pluginEnabled) {
    throw new HermesClientError("The profile approval policy could not be verified.", 502, "APPROVAL_POLICY_UNVERIFIED");
  }
  return effectiveHostPolicy(readback, pipeline, blocked);
}
