import { describe, expect, test } from "bun:test";
import { HermesClientError, type HermesApprovalPolicyState, type HermesHostProfile, type HermesToolset } from "@openedbot/hermes";
import { prepareReviewProfile, type ReviewProfileDeps } from "../src/application/review-profile";
import { reviewProfileRetrySeconds } from "../src/sql/review-profiles";
import { OPENEDBOT_SERVICE_PROFILES, REVIEW_PROFILE } from "../src/domain/runtime-contract";

type HostState = {
  exists: boolean;
  served: HermesToolset[] | null;
  profileToolsets: Array<{ name: string; enabled: boolean }>;
  profileMcp: Array<{ name: string; enabled: boolean }>;
  rootMcp: string[];
  policy: { mode: string; pluginEnabled: boolean; restartPending: boolean } | null;
  isolation: "isolated" | "missing" | "not_partitioned";
  ignoreToolsetWrite?: boolean;
  restartMarked?: boolean;
  createError?: Error;
};

function toolset(name: string, enabled: boolean): HermesToolset {
  return { name, label: name, description: null, enabled, configured: true, tools: [] };
}

function profileView(state: HostState): HermesHostProfile {
  return {
    name: REVIEW_PROFILE, displayName: "openedbot reviewer", title: null, description: null, soul: null,
    model: { default: null, provider: null } as HermesHostProfile["model"], uiMeta: null, hasAvatar: false,
    routines: [], skills: [], toolsets: state.profileToolsets, mcpServers: state.profileMcp,
  };
}

function fakeHost(state: HostState) {
  const calls: string[] = [];
  const policy = (): HermesApprovalPolicyState => {
    if (!state.policy) throw new HermesClientError("missing", 404, "APPROVAL_POLICY_UNAVAILABLE");
    return {
      mode: state.policy.mode, pluginEnabled: state.policy.pluginEnabled,
      effective: state.policy.pluginEnabled && !state.policy.restartPending && !state.restartMarked, gateIdentity: true, blockedTools: [],
    } as HermesApprovalPolicyState;
  };
  const deps: ReviewProfileDeps = {
    host: {
      hostProfileInventory: async () => ({ profiles: state.exists ? [profileView(state)] : [] }),
      hostCreateProfile: async (name: string) => {
        calls.push(`create:${name}`);
        if (state.createError) throw state.createError;
        state.exists = true;
        state.served = [toolset("terminal", true), toolset("file", true), toolset("web", false)];
        state.policy = null;
        return profileView(state);
      },
      hostSetProfileToolset: async (_profile: string, name: string, enabled: boolean) => {
        calls.push(`toolset:${name}:${enabled}`);
        if (!state.ignoreToolsetWrite) state.served = (state.served ?? []).map((entry) => entry.name === name ? { ...entry, enabled } : entry);
        const current = state.served?.find((entry) => entry.name === name)?.enabled ?? enabled;
        return { name, platform: "api_server", enabled: current, requested: enabled, applied: current === enabled, profile: REVIEW_PROFILE };
      },
      hostSetProfileMcpServer: async (_profile: string, name: string, enabled: boolean) => {
        calls.push(`mcp:${name}:${enabled}`);
        state.profileMcp = [...state.profileMcp.filter((flag) => flag.name !== name), { name, enabled }];
        // The host marks one restart for the whole gateway, whatever the profile.
        state.restartMarked = true;
        return { name, profile: REVIEW_PROFILE, enabled, requested: enabled, applied: true };
      },
      mcpInventory: async () => ({ platform: "api_server", servers: state.rootMcp.map((name) => ({ name })), catalog: [] }) as never,
      hostApprovalPolicy: async () => policy(),
      hostSetApprovalPolicy: async (_profile: string, mode: string) => {
        calls.push(`policy:${mode}`);
        state.policy = { mode, pluginEnabled: true, restartPending: state.policy?.restartPending ?? false };
        return policy();
      },
    } as unknown as ReviewProfileDeps["host"],
    served: {
      toolsets: async () => state.served,
      probeProfileIsolation: async () => state.isolation,
    } as unknown as ReviewProfileDeps["served"],
    withProfileNameLock: async (callback) => { calls.push("lock"); await callback(); },
    serveWait: { timeoutMs: 0, pollMs: 0, sleep: async () => undefined },
  };
  return { deps, calls, state };
}

function base(overrides: Partial<HostState> = {}): HostState {
  return {
    exists: false, served: null, profileToolsets: [], profileMcp: [], rootMcp: [],
    policy: null, isolation: "isolated", ...overrides,
  };
}

describe("PERM2-7a review profile", () => {
  test("creates the profile under the name lock, cuts every tool, then proves it", async () => {
    const host = fakeHost(base());
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "proven" });
    expect(host.calls).toEqual(["lock", `create:${REVIEW_PROFILE}`, "toolset:terminal:false", "toolset:file:false", "policy:block_writes"]);
  });

  test("an inherited MCP server is cut and the proof waits for the restart", async () => {
    const host = fakeHost(base({ rootMcp: ["linear"] }));
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "pending_restart" });
    expect(host.calls).toContain("mcp:linear:false");
  });

  test("a proven profile is only re-read: no write", async () => {
    const host = fakeHost(base({
      exists: true, served: [toolset("terminal", false)], profileMcp: [{ name: "linear", enabled: false }], rootMcp: ["linear"],
      policy: { mode: "block_writes", pluginEnabled: true, restartPending: false },
    }));
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "proven" });
    expect(host.calls).toEqual([]);
  });

  test("a toolset the host does not turn off fails the proof", async () => {
    const host = fakeHost(base({ exists: true, served: [toolset("terminal", true)], ignoreToolsetWrite: true }));
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "failed", failureCode: "REVIEW_PROFILE_TOOLSET_UNVERIFIED" });
  });

  test("an MCP server enabled in the profile config fails the read-back", async () => {
    const host = fakeHost(base({ exists: true, served: [], policy: { mode: "block_writes", pluginEnabled: true, restartPending: false } }));
    const realSet = host.deps.host.hostSetProfileMcpServer;
    host.deps.host.hostSetProfileMcpServer = async (...args) => {
      const state = await realSet(...args);
      host.state.profileMcp = [{ name: args[1], enabled: true }];
      return { ...state, enabled: false };
    };
    host.state.rootMcp = ["linear"];
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "failed", failureCode: "REVIEW_PROFILE_MCP_ACTIVE" });
  });

  test("a profile served without partition is refused", async () => {
    const host = fakeHost(base({ exists: true, isolation: "not_partitioned" }));
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "failed", failureCode: "REVIEW_PROFILE_NOT_ISOLATED" });
  });

  test("an unreadable toolset inventory is not an empty one", async () => {
    const host = fakeHost(base({ exists: true, served: null }));
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "failed", failureCode: "REVIEW_PROFILE_TOOLSETS_UNREADABLE" });
  });

  test("a busy link is a retryable failure, never a proof", async () => {
    const host = fakeHost(base({ createError: new HermesClientError("busy", 429, "HERMES_LIMIT_REACHED") }));
    expect(await prepareReviewProfile(host.deps)).toEqual({ status: "failed", failureCode: "REVIEW_PROFILE_RUNTIME_BUSY", transient: true });
  });

  // Lab, 2026-10-25: the gateway restarting answered HERMES_UNREACHABLE and the
  // proof fell, turning every auto bot into manual for a pass.
  test("an error that prevented the read is transient, whatever its code", async () => {
    const down = fakeHost(base({ createError: new HermesClientError("down", 502, "HERMES_UNREACHABLE") }));
    expect(await prepareReviewProfile(down.deps)).toEqual({ status: "failed", failureCode: "HERMES_UNREACHABLE", transient: true });
    // A thrown error is a read that did not happen: transient too. Only the
    // read-back's findings and refusals clear a proof at once.
    const rejected = fakeHost(base({ createError: new HermesClientError("rejected", 401, "HERMES_TOKEN_REJECTED") }));
    expect(await prepareReviewProfile(rejected.deps)).toEqual({ status: "failed", failureCode: "HERMES_TOKEN_REJECTED", transient: true });
  });

  test("the retry backs off and is bounded", () => {
    expect(reviewProfileRetrySeconds(1)).toBe(30);
    expect(reviewProfileRetrySeconds(3)).toBe(120);
    expect(reviewProfileRetrySeconds(50)).toBe(900);
  });

  test("the review profile is a service profile", () => {
    expect(OPENEDBOT_SERVICE_PROFILES.has(REVIEW_PROFILE)).toBe(true);
    expect(OPENEDBOT_SERVICE_PROFILES.has("ohb-model-check")).toBe(true);
  });
});
