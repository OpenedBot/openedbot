import { HermesClientError, RelayDialError, type HermesClient } from "@openedbot/hermes";
import { REVIEW_PROFILE } from "../domain/runtime-contract";
import type { ReviewProfileOutcome } from "../sql/review-profiles";

/** What other packages call here (ADR 0001 S4); the SQL file stays private to the module. */
export {
  claimReviewProfile,
  enqueueReviewProfiles,
  finishReviewProfile,
  readReviewProven,
  type ReviewProfileJob,
} from "../sql/review-profiles";

/**
 * PERM2-7a: prepares the `openedbot-reviewer` profile of one runtime and proves it
 * has no tool. The reviewer only reads a gate and answers in JSON; any tool
 * it could reach would let a prompt in the gate act on the host.
 *
 * The proof is a re-read, never an exit code:
 *   1. the profile exists and is served on its own (isolation probe);
 *   2. every toolset it serves (`/v1/toolsets` on the profile) is off;
 *   3. every MCP server of the runtime root is listed off in the profile
 *      (a server the profile does not list could be inherited);
 *   4. the approval plugin is in `block_writes`, as a last fence;
 *   5. the plugin is in force: a write the gateway has not loaded yet
 *      (an MCP toggle marks a restart) leaves the proof `pending_restart`.
 */
export type ReviewProfileHost = Pick<HermesClient,
  "hostProfileInventory" | "hostCreateProfile" | "hostSetProfileToolset" | "hostSetProfileMcpServer"
  | "mcpInventory" | "hostSetApprovalPolicy" | "hostApprovalPolicy">;
export type ReviewProfileServed = Pick<HermesClient, "toolsets" | "probeProfileIsolation">;

export type ReviewProfileDeps = {
  host: ReviewProfileHost;
  served: ReviewProfileServed;
  /** Creation reserves the name against a concurrent import (`withProfileNamesLock`). */
  withProfileNameLock(callback: () => Promise<void>): Promise<void>;
  serveWait: { timeoutMs: number; pollMs: number; sleep(ms: number): Promise<unknown> };
};

/** A failure the next pass may clear on its own: the link or the host was busy. */
export function isTransientReviewProfileError(error: unknown): boolean {
  return error instanceof RelayDialError || (error instanceof HermesClientError && (
    error.status === 429 || error.status === 409 || error.requestDelivery === "not_sent"
    || String(error.code) === "RUNTIME_LINK_UNAVAILABLE" || error.code === "HERMES_LIMIT_REACHED"
    || error.code === "HERMES_GATEWAY_DRAINING"));
}

/** A check that did not reach the host: busy link or gateway down. */
function isUnreachable(error: unknown): boolean {
  return isTransientReviewProfileError(error)
    || (error instanceof HermesClientError && (error.code === "HERMES_UNREACHABLE" || error.status >= 500));
}

class ReviewProfileRefused extends Error {
  constructor(readonly code: string) { super(code); }
}

async function ensureProfile(deps: ReviewProfileDeps): Promise<void> {
  const present = (await deps.host.hostProfileInventory()).profiles.some((profile) => profile.name === REVIEW_PROFILE);
  if (!present) {
    await deps.withProfileNameLock(async () => {
      const current = await deps.host.hostProfileInventory();
      if (current.profiles.some((profile) => profile.name === REVIEW_PROFILE)) return;
      await deps.host.hostCreateProfile(REVIEW_PROFILE, { displayName: "openedbot reviewer" });
    });
  }
  // A new profile is served once the gateway has picked it up.
  const deadline = Date.now() + deps.serveWait.timeoutMs;
  // Any transient error seen while waiting is kept: a host that stopped
  // answering at some point proves nothing about the profile (Codex review).
  let probeError: unknown = null;
  for (;;) {
    const isolation = await deps.served.probeProfileIsolation(REVIEW_PROFILE).catch((error: unknown) => {
      if (isUnreachable(error) || !isUnreachable(probeError)) probeError = error;
      return "unreadable" as const;
    });
    if (isolation === "isolated") return;
    if (isolation === "not_partitioned") throw new ReviewProfileRefused("REVIEW_PROFILE_NOT_ISOLATED");
    if (Date.now() >= deadline) {
      // A host that never answered proves nothing: the probe's own transient
      // error stays transient instead of becoming "not served" (Codex review).
      if (isUnreachable(probeError)) throw probeError;
      throw new ReviewProfileRefused("REVIEW_PROFILE_NOT_SERVED");
    }
    await deps.serveWait.sleep(deps.serveWait.pollMs);
  }
}

async function cutToolsets(deps: ReviewProfileDeps): Promise<void> {
  const served = await deps.served.toolsets();
  if (served === null) throw new ReviewProfileRefused("REVIEW_PROFILE_TOOLSETS_UNREADABLE");
  for (const toolset of served.filter((entry) => entry.enabled)) {
    const state = await deps.host.hostSetProfileToolset(REVIEW_PROFILE, toolset.name, false);
    if (state.enabled || !state.applied) throw new ReviewProfileRefused("REVIEW_PROFILE_TOOLSET_UNVERIFIED");
  }
}

async function cutMcpServers(deps: ReviewProfileDeps): Promise<void> {
  const [root, inventory] = await Promise.all([deps.host.mcpInventory(), deps.host.hostProfileInventory()]);
  const profile = inventory.profiles.find((entry) => entry.name === REVIEW_PROFILE);
  if (!profile) throw new ReviewProfileRefused("REVIEW_PROFILE_MISSING");
  const off = new Set(profile.mcpServers.filter((flag) => !flag.enabled).map((flag) => flag.name));
  const names = new Set([...root.servers.map((server) => server.name), ...profile.mcpServers.map((flag) => flag.name)]);
  for (const name of names) {
    if (off.has(name)) continue;
    const state = await deps.host.hostSetProfileMcpServer(REVIEW_PROFILE, name, false);
    if (state.enabled) throw new ReviewProfileRefused("REVIEW_PROFILE_MCP_UNVERIFIED");
  }
}

/** The re-read every pass ends with, whatever it wrote. */
async function readBack(deps: ReviewProfileDeps): Promise<ReviewProfileOutcome> {
  const [served, root, inventory, policy] = await Promise.all([
    deps.served.toolsets(), deps.host.mcpInventory(), deps.host.hostProfileInventory(), deps.host.hostApprovalPolicy(REVIEW_PROFILE),
  ]);
  if (served === null || served.some((toolset) => toolset.enabled)) return { status: "failed", failureCode: "REVIEW_PROFILE_TOOLS_ACTIVE" };
  const profile = inventory.profiles.find((entry) => entry.name === REVIEW_PROFILE);
  if (!profile) return { status: "failed", failureCode: "REVIEW_PROFILE_MISSING" };
  if (profile.toolsets.some((flag) => flag.enabled)) return { status: "failed", failureCode: "REVIEW_PROFILE_TOOLS_ACTIVE" };
  const off = new Set(profile.mcpServers.filter((flag) => !flag.enabled).map((flag) => flag.name));
  if (profile.mcpServers.some((flag) => flag.enabled) || root.servers.some((server) => !off.has(server.name))) {
    return { status: "failed", failureCode: "REVIEW_PROFILE_MCP_ACTIVE" };
  }
  if (policy.mode !== "block_writes" || !policy.pluginEnabled) return { status: "failed", failureCode: "REVIEW_PROFILE_POLICY_UNVERIFIED" };
  return policy.effective ? { status: "proven" } : { status: "pending_restart" };
}

export async function prepareReviewProfile(deps: ReviewProfileDeps): Promise<ReviewProfileOutcome> {
  try {
    await ensureProfile(deps);
    await cutToolsets(deps);
    await cutMcpServers(deps);
    const policy = await deps.host.hostApprovalPolicy(REVIEW_PROFILE).catch(() => null);
    if (policy?.mode !== "block_writes" || !policy.pluginEnabled) await deps.host.hostSetApprovalPolicy(REVIEW_PROFILE, "block_writes");
    return await readBack(deps);
  } catch (error) {
    if (error instanceof ReviewProfileRefused) return { status: "failed", failureCode: error.code };
    if (isTransientReviewProfileError(error)) return { status: "failed", failureCode: "REVIEW_PROFILE_RUNTIME_BUSY", transient: true };
    // Every other error is a read that did not happen, not a finding about the
    // profile: transient, so a fresh proof is kept until it ages out. Only
    // what the read-back sees (`readBack`) or a refusal clears it at once.
    if (error instanceof HermesClientError && /^[A-Z0-9_]{1,64}$/.test(String(error.code))) {
      return { status: "failed", failureCode: String(error.code), transient: true };
    }
    return { status: "failed", failureCode: "REVIEW_PROFILE_FAILED", transient: true };
  }
}
