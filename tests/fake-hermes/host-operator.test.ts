/**
 * The fake host operator serves what the Marketplace install flow re-reads,
 * and every answer goes through the real `HermesClient` and its parsers.
 * One fresh fake per test: the host state is in memory and mutable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { HermesClient } from "../../platform/hermes/src/index";
import { runtimeToolsetContractViolation } from "../../modules/runtimes/src/domain/runtime-contract";
import { FAKE_HOST_FEATURES, FAKE_MCP_CATALOG, FAKE_SKILLS } from "./host-operator";
import { startFakeHermes } from "./server";

const token = "fake-host-test-token";
const redirectUri = "https://openedbot.example.test/api/mcp-oauth/callback/runtime";
let server: Server<undefined> | null = null;

function boot(restartReads?: number, profileMcpFacts?: boolean): { client: HermesClient; profileClient: (slug: string) => HermesClient } {
  server = startFakeHermes({ port: 0, token, delayMs: 1, restartReads, profileMcpFacts });
  const origin = `127.0.0.1:${server.port}`;
  const config = {
    endpoint: `http://${origin}`,
    token,
    policy: { environment: "development" as const, insecureOrigins: new Set([origin]) },
    mtls: null,
  };
  return {
    client: new HermesClient(config),
    profileClient: (slug) => new HermesClient({ ...config, profile: slug }),
  };
}

async function restartGateway(client: HermesClient): Promise<string[]> {
  const job = await client.gatewayRestart();
  const steps = [`${job.status}/${job.step}`];
  let current = job;
  while (current.status === "running") {
    current = await client.gatewayRestartPoll(job.jobId);
    steps.push(`${current.status}/${current.step}`);
  }
  return steps;
}

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("fake host operator", () => {
  test("announces the Marketplace host features and a catalogue covering every auth mode", async () => {
    const { client } = boot();
    expect(await client.hostCapabilities()).toEqual([...FAKE_HOST_FEATURES]);
    const inventory = await client.mcpInventory();
    expect(inventory.servers).toEqual([]);
    expect(inventory.catalog.map((entry) => entry.name)).toEqual(FAKE_MCP_CATALOG.map((entry) => entry.name));
    expect(inventory.catalog.some((entry) => entry.authType === "none" && entry.envSpecs.length === 0)).toBe(true);
    expect(inventory.catalog.some((entry) => entry.envSpecs.some((spec) => spec.required && spec.secret))).toBe(true);
    expect(inventory.catalog.some((entry) => entry.authType === "oauth")).toBe(true);
  });

  test("refuses a catalogue install with an undeclared, missing or unknown entry", async () => {
    const { client } = boot();
    await expect(client.mcpCatalogInstall("github")).rejects.toMatchObject({ code: "ENV_REQUIRED", status: 400 });
    await expect(client.mcpCatalogInstall("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fake", BOGUS: "x" }))
      .rejects.toMatchObject({ code: "ENV_UNKNOWN", status: 400 });
    await expect(client.mcpCatalogInstall("nope")).rejects.toMatchObject({ code: "CATALOG_ENTRY_UNKNOWN", status: 404 });
    expect(await client.gatewayStatus()).toMatchObject({ restartPending: false });

    const installed = await client.mcpCatalogInstall("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fake" });
    expect(installed).toMatchObject({ name: "github", transport: "http", auth: "header", envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] });
    expect(JSON.stringify(await client.mcpInventory())).not.toContain("ghp_fake");
  });

  test("an MCP write sets the restart marker, and only a completed restart clears it and loads the tools", async () => {
    const { client } = boot();
    const before = await client.gatewayStatus();
    expect(before).toMatchObject({ restartPending: false, pendingSince: null, job: null });
    expect(before.activeSince).not.toBeNull();

    await client.mcpCatalogInstall("context7");
    const pending = await client.gatewayStatus();
    expect(pending.restartPending).toBe(true);
    expect(pending.pendingSince).not.toBeNull();
    expect((await client.mcpInventory()).servers[0]?.discoveredTools).toBeNull();

    const job = await client.gatewayRestart();
    expect(job).toMatchObject({ status: "running", step: "restart", finishedAt: null });
    await expect(client.gatewayRestart()).resolves.toMatchObject({ jobId: job.jobId, status: "running" });
    expect(await client.gatewayRestartPoll(job.jobId)).toMatchObject({ status: "running", step: "health" });
    // A status read is a read of the job too: the second one settles it.
    expect(await client.gatewayStatus()).toMatchObject({ restartPending: false, job: { status: "ok", step: "done" } });
    const done = await client.gatewayRestartPoll(job.jobId);
    expect(done).toMatchObject({ status: "ok", step: "done" });
    expect(done.finishedAt).not.toBeNull();
    await expect(client.gatewayRestartPoll("unknown-job")).rejects.toMatchObject({ code: "GATEWAY_RESTART_NOT_FOUND" });

    const after = await client.gatewayStatus();
    expect(after).toMatchObject({ restartPending: false, pendingSince: null, job: { jobId: job.jobId, status: "ok" } });
    const context7 = FAKE_MCP_CATALOG.find((entry) => entry.name === "context7")!;
    expect((await client.mcpInventory()).servers[0]?.discoveredTools).toEqual(context7.tools);

    await client.mcpServerRemove("context7");
    expect((await client.gatewayStatus()).restartPending).toBe(true);
    await expect(client.mcpServerRemove("context7")).rejects.toMatchObject({ code: "SERVER_UNKNOWN", status: 404 });
  });

  test("adds a custom https server, refusing stdio, http and duplicates", async () => {
    const { client } = boot(1);
    const added = await client.mcpServerAdd({ name: "docs", url: "https://mcp.example.test/mcp", auth: "header", token: "secret-token" });
    expect(added).toMatchObject({ name: "docs", transport: "http", auth: "header", oauthTokenPresent: null, discoveredTools: null });
    await expect(client.mcpServerAdd({ name: "docs", url: "https://mcp.example.test/mcp", auth: "none" }))
      .rejects.toMatchObject({ code: "SERVER_EXISTS", status: 409 });
    await expect(client.mcpServerAdd({ name: "plain", url: "http://mcp.example.test/mcp", auth: "none" }))
      .rejects.toMatchObject({ code: "URL_INVALID" });
    await expect(client.mcpServerAdd({ name: "shell", url: "https://x.test", auth: "none", command: "sh" } as never))
      .rejects.toMatchObject({ code: "STDIO_REFUSED" });
    expect(await restartGateway(client)).toEqual(["running/restart", "ok/done"]);
    expect((await client.mcpInventory()).servers[0]?.discoveredTools).toEqual(["search", "fetch"]);
  });

  test("an OAuth server lists no tools until it is authorized and the gateway restarted", async () => {
    const { client } = boot();
    await client.mcpCatalogInstall("linear");
    expect((await client.mcpInventory()).servers[0]).toMatchObject({ auth: "oauth", oauthTokenPresent: false });

    const session = await client.mcpOauthStart("linear", redirectUri);
    expect(session.status).toBe("pending");
    expect(session.authorizationUrl).toStartWith("https://");
    const state = new URL(session.authorizationUrl!).searchParams.get("state")!;
    expect(new URL(session.authorizationUrl!).searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(await client.mcpOauthStart("linear", redirectUri)).toMatchObject({ sessionId: session.sessionId });

    await restartGateway(client);
    expect((await client.mcpInventory()).servers[0]?.discoveredTools).toBeNull();

    await expect(client.mcpOauthCallback("linear", { code: "fake-code", state: "stale-state" }))
      .rejects.toMatchObject({ code: "OAUTH_CALLBACK_INVALID", status: 400 });
    expect(await client.mcpOauthPoll("linear", session.sessionId)).toMatchObject({ status: "pending" });
    const connected = await client.mcpOauthCallback("linear", { code: "fake-code", state });
    expect(connected.status).toBe("connected");
    await expect(client.mcpOauthCallback("linear", { code: "fake-code", state }))
      .rejects.toMatchObject({ code: "OAUTH_CALLBACK_USED", status: 409 });
    expect(connected.discoveredTools.length).toBeGreaterThan(0);
    expect(await client.mcpOauthPoll("linear", session.sessionId)).toMatchObject({ status: "connected" });
    expect((await client.mcpInventory()).servers[0]?.oauthTokenPresent).toBe(true);
    expect((await client.gatewayStatus()).restartPending).toBe(true);

    await restartGateway(client);
    expect((await client.mcpInventory()).servers[0]?.discoveredTools).toEqual(connected.discoveredTools);
  });

  test("one authorization per server: another profile's is a conflict, never returned as its own", async () => {
    const { client } = boot();
    await client.mcpCatalogInstall("linear");
    const alpha = await client.mcpOauthStart("linear", redirectUri, "alpha");
    expect(alpha).toMatchObject({ status: "pending", profile: "alpha" });
    expect(await client.mcpOauthStart("linear", redirectUri, "alpha")).toMatchObject({ sessionId: alpha.sessionId });
    await expect(client.mcpOauthStart("linear", redirectUri, "beta"))
      .rejects.toMatchObject({ code: "MCP_OAUTH_IN_PROGRESS", pendingSessionId: alpha.sessionId });
    await client.mcpOauthCancel("linear", alpha.sessionId);
    expect(await client.mcpOauthStart("linear", redirectUri, "beta")).toMatchObject({ status: "pending", profile: "beta" });
  });

  test("a provider refusal must carry the pending state; relayed, the session fails after the answer", async () => {
    const { client } = boot();
    await client.mcpCatalogInstall("linear");
    const session = await client.mcpOauthStart("linear", redirectUri);
    const state = new URL(session.authorizationUrl!).searchParams.get("state")!;
    await expect(client.mcpOauthCallback("linear", { error: "access_denied" }))
      .rejects.toMatchObject({ code: "OAUTH_CALLBACK_INVALID" });
    expect(await client.mcpOauthCallback("linear", { error: "access_denied", state })).toMatchObject({ status: "pending" });
    expect(await client.mcpOauthPoll("linear", session.sessionId)).toMatchObject({ status: "failed" });
  });

  test("an OAuth start on a non-OAuth server fails its session, and a cancel ends a pending one", async () => {
    const { client } = boot();
    await client.mcpCatalogInstall("context7");
    expect(await client.mcpOauthStart("context7", redirectUri)).toMatchObject({ status: "failed", errorCode: "OAUTH_UNSUPPORTED" });
    await expect(client.mcpOauthStart("context7", "http://evil.example.test/cb")).rejects.toMatchObject({ code: "REDIRECT_INVALID" });

    await client.mcpCatalogInstall("linear");
    const session = await client.mcpOauthStart("linear", redirectUri);
    await client.mcpOauthCancel("linear", session.sessionId);
    expect(await client.mcpOauthPoll("linear", session.sessionId)).toMatchObject({ status: "cancelled" });
    await expect(client.mcpOauthCallback("linear", { code: "c", state: "s" })).rejects.toMatchObject({ code: "OAUTH_SESSION_NOT_FOUND" });
    await expect(client.mcpOauthPoll("linear", "missing")).rejects.toMatchObject({ code: "OAUTH_SESSION_NOT_FOUND" });
  });

  test("root toolset state is re-readable on /v1/toolsets and the forbidden ones stay off", async () => {
    const { client } = boot();
    const settable = await client.hostToolsets();
    expect(settable.platform).toBe("api_server");
    expect(settable.settable).toContain("browser");

    expect(await client.toolsetSet("browser", true)).toMatchObject({ name: "browser", enabled: true, applied: true });
    expect((await client.toolsets())!.find((toolset) => toolset.name === "browser")?.enabled).toBe(true);
    await expect(client.toolsetSet("cronjob", true)).rejects.toMatchObject({ code: "TOOLSET_FORBIDDEN", status: 403 });
    await expect(client.toolsetSet("memory", true)).rejects.toMatchObject({ code: "TOOLSET_FORBIDDEN" });
    await expect(client.toolsetSet("unknown_set", true)).rejects.toMatchObject({ code: "TOOLSET_NOT_SETTABLE", status: 404 });
    expect(runtimeToolsetContractViolation(await client.toolsets())).toBeNull();
  });

  test("a profile carries its own toolsets, MCP servers and skills, each re-readable", async () => {
    const { client, profileClient } = boot();
    await client.hostCreateProfile("market-bot", { displayName: "Market bot", provider: "fake", model: "fake/hermes" });
    const scoped = profileClient("market-bot");

    expect(await client.hostSetProfileToolset("market-bot", "browser", true)).toMatchObject({ profile: "market-bot", enabled: true, applied: true });
    expect((await scoped.toolsets())!.find((toolset) => toolset.name === "browser")?.enabled).toBe(true);
    expect((await client.toolsets())!.find((toolset) => toolset.name === "browser")?.enabled).toBe(false);
    expect(runtimeToolsetContractViolation(await scoped.toolsets(), { scope: "profile" })).toBeNull();
    await expect(client.hostSetProfileToolset("market-bot", "delegation", true)).rejects.toMatchObject({ code: "TOOLSET_FORBIDDEN" });

    await expect(client.hostSetProfileMcpServer("market-bot", "context7", true))
      .rejects.toMatchObject({ code: "MCP_SERVER_NOT_FOUND", status: 404 });
    expect((await client.gatewayStatus()).restartPending).toBe(false);
    await client.mcpCatalogInstall("context7");
    await restartGateway(client);
    expect(await client.hostSetProfileMcpServer("market-bot", "context7", true)).toMatchObject({ enabled: true, applied: true });
    expect((await client.gatewayStatus()).restartPending).toBe(true);

    expect((await scoped.capabilityInventory()).skills?.map((skill) => skill.name)).toEqual(FAKE_SKILLS.map((skill) => skill.name));
    expect((await client.capabilityInventory()).skills).toEqual([]);
    expect(await client.hostSetProfileSkill("market-bot", "plan", false)).toMatchObject({ enabled: false, applied: true });
    await expect(client.hostSetProfileSkill("market-bot", "absent", true)).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });

    const [profile] = (await client.hostProfileInventory()).profiles;
    expect(profile?.toolsets).toContainEqual({ name: "browser", enabled: true });
    expect(profile?.toolsets).toContainEqual({ name: "memory", enabled: true });
    expect(profile?.mcpServers).toEqual([{ name: "context7", enabled: true }]);
    expect(profile?.skills).toContainEqual({ name: "plan", enabled: false });
    expect(profile?.skills).toContainEqual({ name: "arxiv", enabled: true });
  });

  test("a current host describes a profile's MCP entries: a copied entry has no token until the profile is authorized", async () => {
    const { client } = boot(undefined, true);
    await client.hostCreateProfile("market-bot", { displayName: "Market bot", provider: "fake", model: "fake/hermes" });
    expect((await client.hostProfileInventory()).profiles[0]).toMatchObject({ mcpServers: [], mcpFacts: true });
    await client.mcpCatalogInstall("linear");
    await client.hostSetProfileMcpServer("market-bot", "linear", true);
    const linear = () => client.hostProfileInventory().then((inventory) => inventory.profiles[0]!.mcpServers[0]);
    expect(await linear()).toMatchObject({ name: "linear", enabled: true, auth: "oauth", oauthTokenPresent: false });

    const session = await client.mcpOauthStart("linear", redirectUri, "market-bot");
    const state = new URL(session.authorizationUrl!).searchParams.get("state")!;
    await client.mcpOauthCallback("linear", { code: "fake-code", state });
    expect(await linear()).toMatchObject({ oauthTokenPresent: true });
    // The token is the profile's, never the root's.
    expect((await client.mcpInventory()).servers[0]?.oauthTokenPresent).toBe(false);
  });

  test("a profile approval policy is unreadable before a write, and effective only after a restart", async () => {
    const { client } = boot();
    await client.hostCreateProfile("market-bot", { displayName: "Market bot", provider: "fake", model: "fake/hermes" });
    await expect(client.hostApprovalPolicy("market-bot")).rejects.toMatchObject({ code: "APPROVAL_POLICY_UNAVAILABLE", status: 502 });

    const proven = { pluginEnabled: true, gateIdentity: true };
    expect(await client.hostSetApprovalPolicy("market-bot", "ask_writes")).toEqual({ ...proven, mode: "ask_writes", effective: false, blockedTools: [] });
    expect((await client.gatewayStatus()).restartPending).toBe(true);
    await restartGateway(client);
    expect(await client.hostApprovalPolicy("market-bot")).toEqual({ ...proven, mode: "ask_writes", effective: true, blockedTools: [] });

    // A mode change on an enabled plugin is hot: no restart, still effective.
    // The blocked list is replaced only when the write names one.
    expect(await client.hostSetApprovalPolicy("market-bot", "ask_writes", ["write_file", "mcp:github:create_issue"]))
      .toEqual({ ...proven, mode: "ask_writes", effective: true, blockedTools: ["write_file", "mcp:github:create_issue"] });
    expect(await client.hostSetApprovalPolicy("market-bot", "block_writes")).toEqual({ ...proven, mode: "block_writes", effective: true, blockedTools: ["write_file", "mcp:github:create_issue"] });
    expect((await client.gatewayStatus()).restartPending).toBe(false);
    await expect(client.hostSetApprovalPolicy("market-bot", "ask_writes", ["rm -rf"])).rejects.toMatchObject({ code: "BODY_INVALID" });
  });

  test("provider credentials answer with a verdict the client parses", async () => {
    const { client } = boot();
    expect(await client.providerCredentialAdd("fake", "sk-fake")).toMatchObject({ provider: "fake", verification: "confirmed" });
    expect(await client.providerCredentialAdd("openrouter", "sk-fake")).toMatchObject({ verification: "unverified" });
  });
});
