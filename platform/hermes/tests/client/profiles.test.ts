import { describe, expect, test } from "bun:test";
import {
  HermesClient,
  HermesClientError,
  parseHostProfileAvatar,
  parseHostProfileCreateResult,
  parseHostProfileInventory,
  parseProfileBundledSkillsState,
  parseProfileCredentialResult,
  parseProfileMcpServerState,
  parseProfileModelState,
  parseProfileSkillState,
  parseProfileToolsetState,
  parseApprovalPolicyState,
} from "../../src/index";
import type { HermesRequestKind, HermesTransport } from "../../src/transport/types";

const scout = {
  name: "scout",
  displayName: "Scout",
  title: "Scout",
  description: "Find sources.",
  soul: "# Scout\nA researcher.",
  model: { default: "claude-sonnet-4", provider: "anthropic" },
  uiMeta: {
    title: "Scout",
    color: "#3b93f0",
    shape: "circle",
    imageKind: "generated",
    hidden: false,
    pinned: true,
    sectionId: null,
    groups: ["newsroom"],
    created: "2026-09-01T00:00:00Z",
  },
  hasAvatar: true,
  routines: [{
    name: "Morning brief",
    schedule: "30 8 * * 1,2,3,4,5",
    prompt: "Prepare the brief.",
    enabled: true,
    deliver: true,
    model: null,
  }],
  skills: [{ name: "research", enabled: true }],
  toolsets: [{ name: "web", enabled: true }],
  mcpServers: [{ name: "linear", enabled: false }],
};

type Sent = { path: string; method: string; kind: HermesRequestKind; body?: string };

function fakeTransport(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const transport: HermesTransport = {
    kind: "relay",
    async send(path, init, kind) {
      const entry: Sent = { path, method: (init.method ?? "GET").toUpperCase(), kind, body: typeof init.body === "string" ? init.body : undefined };
      sent.push(entry);
      return respond(entry);
    },
  };
  return { client: new HermesClient({ transport }), sent };
}

describe("parseHostProfileInventory", () => {
  test("accepte un inventaire borné et refuse default, un slug hors grammaire, un .env", () => {
    expect(parseHostProfileInventory({ profiles: [scout] })).toEqual({ profiles: [scout] });
    expect(() => parseHostProfileInventory({ profiles: [{ ...scout, name: "default" }] })).toThrow(HermesClientError);
    expect(() => parseHostProfileInventory({ profiles: [{ ...scout, name: "Scout" }] })).toThrow(HermesClientError);
    expect(() => parseHostProfileInventory({ profiles: "scout" })).toThrow(HermesClientError);
  });

  test("garde les faits d'un serveur MCP de profil quand l'hôte les dit, et seulement alors", () => {
    const servers = [
      { name: "linear", enabled: true, endpoint: "https://mcp.linear.app/mcp", auth: "oauth", oauthTokenPresent: false },
      // The operator omits a null: an oauth server whose check failed is unknown.
      { name: "notion", enabled: true, endpoint: "https://mcp.notion.com/mcp", auth: "oauth" },
      { name: "docs", enabled: true, endpoint: "https://docs.example/mcp", auth: "header" },
      { name: "local", enabled: false, auth: "none" },
      // An older host: name and state, nothing filled in.
      { name: "old", enabled: true, oauthTokenPresent: true },
    ];
    const parsed = parseHostProfileInventory({ profiles: [{ ...scout, mcpServers: servers }] }).profiles[0]!.mcpServers;
    expect(parsed).toEqual([
      { name: "linear", enabled: true, endpoint: "https://mcp.linear.app/mcp", auth: "oauth", oauthTokenPresent: false },
      { name: "notion", enabled: true, endpoint: "https://mcp.notion.com/mcp", auth: "oauth", oauthTokenPresent: null },
      { name: "docs", enabled: true, endpoint: "https://docs.example/mcp", auth: "header", oauthTokenPresent: null },
      { name: "local", enabled: false, endpoint: null, auth: "none", oauthTokenPresent: null },
      { name: "old", enabled: true },
    ]);
    // The marker of a host that describes the entries: kept, and only as such.
    expect(parseHostProfileInventory({ profiles: [{ ...scout, mcpServers: [], mcpFacts: true }] }).profiles[0]).toMatchObject({ mcpServers: [], mcpFacts: true });
    expect(parseHostProfileInventory({ profiles: [scout] }).profiles[0]).not.toHaveProperty("mcpFacts");
    expect(() => parseHostProfileInventory({ profiles: [{ ...scout, mcpFacts: "yes" }] })).toThrow(HermesClientError);
    for (const bad of [{ auth: "basic" }, { auth: "oauth", oauthTokenPresent: "yes" }, { auth: "oauth", endpoint: 7 }, { auth: "oauth", endpoint: "x".repeat(2049) }]) {
      expect(() => parseHostProfileInventory({ profiles: [{ ...scout, mcpServers: [{ name: "linear", enabled: true, ...bad }] }] })).toThrow(HermesClientError);
    }
  });
});

describe("parseHostProfileAvatar", () => {
  test("n'accepte qu'une image bornée", () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    expect(parseHostProfileAvatar("image/png", bytes).contentType).toBe("image/png");
    expect(() => parseHostProfileAvatar("application/json", bytes)).toThrow(HermesClientError);
    expect(() => parseHostProfileAvatar("image/png", new Uint8Array())).toThrow(HermesClientError);
  });
});

describe("HermesClient.hostProfileInventory", () => {
  test("GET /hermes-setup/profiles à la racine, lecture sûre", async () => {
    const { client, sent } = fakeTransport(() => Response.json({ profiles: [scout] }));
    await expect(client.hostProfileInventory()).resolves.toEqual({ profiles: [scout] });
    expect(sent).toEqual([{ path: "/hermes-setup/profiles", method: "GET", kind: "safe" }]);
  });
});

describe("HermesClient profile approval policy", () => {
  test("GET/PUT use the named profile route and verify the returned mode", async () => {
    const { client, sent } = fakeTransport((entry) => Response.json({ mode: entry.method === "GET" ? "ask_writes" : "block_writes", pluginEnabled: true, effective: true }));
    // A host older than PERM2-A sends neither field: no identity, no blocking.
    const legacy = { pluginEnabled: true, effective: true, gateIdentity: false, blockedTools: null };
    await expect(client.hostApprovalPolicy("scout")).resolves.toEqual({ ...legacy, mode: "ask_writes" });
    await expect(client.hostSetApprovalPolicy("scout", "block_writes")).resolves.toEqual({ ...legacy, mode: "block_writes" });
    expect(sent.map(({ path, method, kind, body }) => ({ path, method, kind, body }))).toEqual([
      { path: "/hermes-setup/profiles/scout/approval-policy", method: "GET", kind: "safe", body: undefined },
      { path: "/hermes-setup/profiles/scout/approval-policy", method: "PUT", kind: "mutation", body: '{"mode":"block_writes"}' },
    ]);
    await expect(client.hostApprovalPolicy("default")).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    expect(() => parseApprovalPolicyState({ mode: "unbounded", pluginEnabled: true, effective: true })).toThrow(HermesClientError);
    expect(() => parseApprovalPolicyState({ mode: "ask_writes", pluginEnabled: true })).toThrow(HermesClientError);
  });

  test("a blocked tool list is sent, proven by the read-back, and a malformed one is refused", async () => {
    let answered: string[] = ["write_file"];
    const { client, sent } = fakeTransport(() => Response.json({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: answered }));
    await expect(client.hostSetApprovalPolicy("scout", "ask_writes", ["write_file"])).resolves.toMatchObject({ gateIdentity: true, blockedTools: ["write_file"] });
    expect(sent.at(-1)?.body).toBe('{"mode":"ask_writes","blockedTools":["write_file"]}');
    answered = [];
    await expect(client.hostSetApprovalPolicy("scout", "ask_writes", ["write_file"])).rejects.toMatchObject({ code: "APPROVAL_POLICY_UNVERIFIED" });
    const before = sent.length;
    await expect(client.hostSetApprovalPolicy("scout", "ask_writes", ["write_file", "write_file"])).rejects.toMatchObject({ code: "BODY_INVALID" });
    expect(sent.length).toBe(before);
    for (const blockedTools of [["Write File"], "write_file", [1]]) {
      expect(() => parseApprovalPolicyState({ mode: "ask_writes", pluginEnabled: true, effective: true, blockedTools })).toThrow(HermesClientError);
    }
    expect(() => parseApprovalPolicyState({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: "yes" })).toThrow(HermesClientError);
  });
});

describe("HermesClient.hostProfileAvatar", () => {
  test("GET /hermes-setup/profiles/<slug>/avatar, refuse default avant l'aller", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const { client, sent } = fakeTransport(() => new Response(png, { headers: { "content-type": "image/png" } }));
    const avatar = await client.hostProfileAvatar("scout");
    expect(avatar.contentType).toBe("image/png");
    expect(avatar.bytes.byteLength).toBe(8);
    expect(sent[0]).toEqual({ path: "/hermes-setup/profiles/scout/avatar", method: "GET", kind: "safe" });
    const error = await client.hostProfileAvatar("default").then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesClientError);
    expect((error as HermesClientError).code).toBe("PROFILE_INVALID");
    expect(sent).toHaveLength(1);
  });
});

describe("profile management parsers", () => {
  test("parse une création complète et refuse les enveloppes incomplètes", () => {
    expect(parseHostProfileCreateResult({ profile: scout })).toEqual(scout);
    expect(() => parseHostProfileCreateResult({ profile: { name: "scout" } })).toThrow(HermesClientError);
    expect(parseHostProfileCreateResult({ profile: scout, readBack: "profile" })).toEqual({ ...scout, readBack: "profile" });
    expect(parseHostProfileCreateResult({ profile: scout, readBack: "yes" })).toEqual(scout);
    expect(() => parseProfileToolsetState({
      name: "web",
      profile: "default",
      platform: "api_server",
      enabled: true,
      requested: true,
    })).toThrow(HermesClientError);
  });

  test("recalcule applied pour les états relus", () => {
    expect(parseProfileToolsetState({
      name: "web",
      profile: "scout",
      platform: "api_server",
      enabled: false,
      requested: true,
      applied: true,
    })).toMatchObject({ profile: "scout", applied: false });
    expect(parseProfileMcpServerState({
      name: "linear",
      profile: "scout",
      enabled: true,
      requested: true,
      applied: false,
    })).toEqual({ name: "linear", profile: "scout", enabled: true, requested: true, applied: true });
    expect(parseProfileSkillState({
      name: "research",
      profile: "scout",
      enabled: false,
      requested: false,
      applied: true,
    })).toEqual({ name: "research", profile: "scout", enabled: false, requested: false, applied: true });
    expect(parseProfileCredentialResult({
      provider: "anthropic",
      profile: "scout",
      verification: "confirmed",
      detail: null,
    })).toEqual({ provider: "anthropic", profile: "scout", verification: "confirmed", detail: null });
    expect(parseProfileModelState({
      profile: "scout",
      provider: "anthropic",
      model: "claude-sonnet-4",
    }, { provider: "anthropic", model: "claude-sonnet-4" })).toEqual({
      profile: "scout",
      provider: "anthropic",
      model: "claude-sonnet-4",
      applied: true,
    });
    expect(parseProfileModelState({
      profile: "scout",
      provider: "opencode-free",
      model: "gpt-5.6-luna",
    }, { provider: "anthropic", model: "claude-sonnet-4" })).toMatchObject({ applied: false });
  });
});

describe("HermesClient profile management", () => {
  test("relaye les quatre verbes hôte à la racine", async () => {
    const { client, sent } = fakeTransport((entry) => {
      if (entry.method === "POST" && entry.path === "/hermes-setup/profiles") {
        return Response.json({ profile: scout }, { status: 201 });
      }
      if (entry.method === "POST" && entry.path.endsWith("/model")) {
        return Response.json({ profile: "scout", provider: "anthropic", model: "claude-sonnet-4" });
      }
      if (entry.path.endsWith("/memory") && entry.method === "POST" && String(entry.body ?? "").includes('"content":"full"')) {
        return Response.json({ error: { code: "MEMORY_REFUSED", message: "Memory at 2,200/2,200 chars. Adding this entry (4 chars) would exceed the limit." } }, { status: 409 });
      }
      if (entry.path.endsWith("/memory")) {
        return Response.json({
          profile: "scout", memoryEnabled: true, userProfileEnabled: true,
          limits: { memory: 2200, user: 1375 },
          entries: { memory: ["Le projet est un monorepo Bun."], user: [] },
          usedChars: { memory: 30, user: 0 },
          message: entry.method === "POST" ? "Entry added." : undefined,
        });
      }
      if (entry.method === "POST" && entry.path.includes("/toolsets/")) {
        return Response.json({ name: "web", profile: "scout", platform: "api_server", enabled: true, requested: true });
      }
      if (entry.method === "POST" && entry.path.includes("/skills/")) {
        return Response.json({ name: "research", profile: "scout", enabled: false, requested: false });
      }
      if (entry.path.includes("/credentials")) {
        return Response.json({
          provider: "anthropic",
          profile: "scout",
          verification: entry.method === "DELETE" ? "denied" : "confirmed",
          detail: null,
        });
      }
      if (entry.method === "POST") {
        return Response.json({ name: "linear", profile: "scout", enabled: false, requested: false });
      }
      return new Response(null, { status: 204 });
    });
    await expect(client.hostCreateProfile("scout", "Scout")).resolves.toEqual(scout);
    await expect(client.hostCreateProfile("scout", { displayName: "Scout", provider: "anthropic", model: "claude-sonnet-4" })).resolves.toEqual(scout);
    await expect(client.hostSetProfileModel("scout", { provider: "anthropic", model: "claude-sonnet-4" })).resolves.toMatchObject({
      profile: "scout",
      provider: "anthropic",
      model: "claude-sonnet-4",
      applied: true,
    });
    await expect(client.hostDeleteProfile("scout")).resolves.toBeUndefined();
    await expect(client.hostSetProfileToolset("scout", "web", true)).resolves.toMatchObject({ profile: "scout", applied: true });
    await expect(client.hostProfileMemory("scout")).resolves.toMatchObject({
      profile: "scout",
      entries: { memory: ["Le projet est un monorepo Bun."], user: [] },
      usedChars: { memory: 30, user: 0 },
      limits: { memory: 2200, user: 1375 },
    });
    await expect(client.hostWriteProfileMemory("scout", { action: "add", target: "user", content: "Elodie, CTO." })).resolves.toMatchObject({ profile: "scout" });
    await expect(client.hostWriteProfileMemory("default", { action: "add", target: "user", content: "x" })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    // Un tiroir plein : le refus du magasin traverse avec son code et son
    // message (l'usage, la consigne de consolider), jamais en erreur générique.
    await expect(client.hostWriteProfileMemory("scout", { action: "add", target: "memory", content: "full" })).rejects.toMatchObject({
      code: "MEMORY_REFUSED",
      status: 409,
      message: expect.stringContaining("2,200/2,200"),
    });
    await expect(client.hostSetProfileMcpServer("scout", "linear", false)).resolves.toMatchObject({ profile: "scout", applied: true });
    await expect(client.hostSetProfileSkill("scout", "research", false)).resolves.toMatchObject({ profile: "scout", applied: true });
    await expect(client.hostSetProfileCredential("scout", "anthropic", "sk-test")).resolves.toMatchObject({
      profile: "scout",
      provider: "anthropic",
      verification: "confirmed",
    });
    await expect(client.hostDeleteProfileCredential("scout", "anthropic")).resolves.toMatchObject({
      profile: "scout",
      verification: "denied",
    });
    expect(sent.map(({ path, method }) => `${method} ${path}`)).toEqual([
      "POST /hermes-setup/profiles",
      "POST /hermes-setup/profiles",
      "POST /hermes-setup/profiles/scout/model",
      "DELETE /hermes-setup/profiles/scout",
      "POST /hermes-setup/profiles/scout/toolsets/web",
      "GET /hermes-setup/profiles/scout/memory",
      "POST /hermes-setup/profiles/scout/memory",
      "POST /hermes-setup/profiles/scout/memory",
      "POST /hermes-setup/profiles/scout/mcp/servers/linear",
      "POST /hermes-setup/profiles/scout/skills/research",
      "POST /hermes-setup/profiles/scout/providers/anthropic/credentials",
      "DELETE /hermes-setup/profiles/scout/providers/anthropic/credentials",
    ]);
  });

  test("refuse les noms invalides avant le transport", async () => {
    const { client, sent } = fakeTransport(() => Response.json({ profile: scout }, { status: 201 }));
    await expect(client.hostCreateProfile("default")).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(client.hostCreateProfile("scout", { provider: "anthropic" })).rejects.toMatchObject({ code: "BODY_INVALID" });
    await expect(client.hostSetProfileModel("scout", { provider: "bad provider", model: "claude" })).rejects.toMatchObject({ code: "BODY_INVALID" });
    await expect(client.hostSetProfileModel("default", { provider: "anthropic", model: "claude" })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(client.hostSetProfileToolset("scout", "web-search", true)).rejects.toMatchObject({ code: "TOOLSET_INVALID" });
    await expect(client.hostSetProfileMcpServer("scout", "bad name", true)).rejects.toMatchObject({ code: "NAME_INVALID" });
    await expect(client.hostSetProfileSkill("scout", "Bad Skill", true)).rejects.toMatchObject({ code: "SKILL_INVALID" });
    await expect(client.hostSetProfileCredential("default", "anthropic", "sk")).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    expect(sent).toHaveLength(0);
  });
});

test("preserves PROFILE_UNVERIFIED for create and delete without inventing an outcome", async () => {
  const { client } = fakeTransport(() => Response.json({ error: { code: "PROFILE_UNVERIFIED", message: "Verification failed" } }, { status: 502 }));
  for (const call of [() => client.hostCreateProfile("scout"), () => client.hostDeleteProfile("scout")]) {
    await expect(call()).rejects.toMatchObject({ code: "PROFILE_UNVERIFIED" });
  }
});

test("hostSetProfileModels writes many profiles in one call and never reads an unanswered profile as applied", async () => {
  const { client, sent } = fakeTransport(() => Response.json({
    provider: "xai-oauth",
    model: "grok-4.7",
    profiles: [
      { profile: "scout", provider: "xai-oauth", model: "grok-4.7", applied: true },
      { profile: "ghost", provider: null, model: null, applied: false, code: "PROFILE_NOT_FOUND" },
    ],
  }));
  await expect(client.hostSetProfileModels(["scout", "ghost", "drift", "scout"], { provider: "xai-oauth", model: "grok-4.7" })).resolves.toEqual([
    { profile: "scout", provider: "xai-oauth", model: "grok-4.7", applied: true, code: null },
    { profile: "ghost", provider: null, model: null, applied: false, code: "PROFILE_NOT_FOUND" },
    { profile: "drift", provider: null, model: null, applied: false, code: "PROFILE_UNVERIFIED" },
  ]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ path: "/hermes-setup/profiles/models", method: "POST", kind: "mutation" });
  expect(JSON.parse(sent[0]!.body!)).toEqual({ provider: "xai-oauth", model: "grok-4.7", profiles: ["scout", "ghost", "drift"] });
  await expect(client.hostSetProfileModels([], { provider: "xai-oauth", model: "grok-4.7" })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
  await expect(client.hostSetProfileModels(["default"], { provider: "xai-oauth", model: "grok-4.7" })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
  expect(sent).toHaveLength(1);
});

describe("hostSetProfileToolsets", () => {
  const state = (name: string, enabled: boolean) =>
    ({ name, profile: "scout", platform: "api_server", enabled, requested: enabled, applied: true });

  test("posts the batch in name order as one mutation and returns one read-back state per name", async () => {
    const { client, sent } = fakeTransport(() => Response.json({
      profile: "scout", platform: "api_server", toolsets: [state("browser", false), state("web", true)],
    }));
    const states = await client.hostSetProfileToolsets("scout", { web: true, browser: false });
    expect(states.map(({ name, enabled }) => [name, enabled])).toEqual([["browser", false], ["web", true]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: "/hermes-setup/profiles/scout/toolsets", method: "POST", kind: "mutation" });
    expect(JSON.parse(sent[0]!.body!)).toEqual({ toolsets: { browser: false, web: true } });
  });

  test("an answer missing a name, naming another profile or repeating a name is invalid, never a partial write", async () => {
    for (const toolsets of [
      [state("web", true)],
      [state("web", true), { ...state("browser", false), profile: "other" }],
      [state("web", true), state("web", true)],
    ]) {
      const { client } = fakeTransport(() => Response.json({ profile: "scout", platform: "api_server", toolsets }));
      await expect(client.hostSetProfileToolsets("scout", { web: true, browser: false })).rejects.toBeInstanceOf(HermesClientError);
    }
  });

  test("refuses a bad profile, an empty batch or a bad name before any request", async () => {
    const { client, sent } = fakeTransport(() => Response.json({}));
    await expect(client.hostSetProfileToolsets("default", { web: true })).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(client.hostSetProfileToolsets("scout", {})).rejects.toMatchObject({ code: "BODY_INVALID" });
    await expect(client.hostSetProfileToolsets("scout", { "web-search": true })).rejects.toMatchObject({ code: "TOOLSET_INVALID" });
    expect(sent).toHaveLength(0);
  });
});

describe("hostSetProfileBundledSkills", () => {
  const answer = { profile: "scout", requested: false, bundled: 74, bundledEnabled: 0, applied: true };

  test("posts {enabled} as a mutation on the bundled-skills path and returns the read-back state", async () => {
    const { client, sent } = fakeTransport(() => Response.json(answer));
    await expect(client.hostSetProfileBundledSkills("scout", false)).resolves.toEqual(answer);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: "/hermes-setup/profiles/scout/bundled-skills", method: "POST", kind: "mutation" });
    expect(JSON.parse(sent[0]!.body!)).toEqual({ enabled: false });
  });

  test("passes a partial application through instead of claiming success", async () => {
    const { client } = fakeTransport(() => Response.json({ ...answer, bundledEnabled: 3, applied: false }));
    await expect(client.hostSetProfileBundledSkills("scout", false)).resolves.toMatchObject({ bundledEnabled: 3, applied: false });
  });

  test("refuses default and a slug outside the grammar before the transport", async () => {
    const { client, sent } = fakeTransport(() => Response.json(answer));
    await expect(client.hostSetProfileBundledSkills("default", false)).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(client.hostSetProfileBundledSkills("Bad Slug", false)).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    expect(sent).toHaveLength(0);
  });

  test("parses strictly: every field present with the right type", () => {
    expect(parseProfileBundledSkillsState(answer)).toEqual(answer);
    for (const bad of [
      null,
      "scout",
      { ...answer, profile: undefined },
      { ...answer, profile: "default" },
      { ...answer, requested: "false" },
      { ...answer, applied: undefined },
      { ...answer, bundled: "74" },
      { ...answer, bundled: -1 },
      { ...answer, bundled: 1.5 },
      { ...answer, bundledEnabled: undefined },
      { ...answer, bundled: 2, bundledEnabled: 3 },
    ]) {
      expect(() => parseProfileBundledSkillsState(bad)).toThrow(HermesClientError);
    }
  });

  test("a malformed host answer is a client error, not a state", async () => {
    const { client } = fakeTransport(() => Response.json({ profile: "scout", requested: false }));
    await expect(client.hostSetProfileBundledSkills("scout", false)).rejects.toBeInstanceOf(HermesClientError);
  });
});

describe("hostRemoveProfileMcpServer", () => {
  test("DELETE sur la route du profil, document relu tel quel", async () => {
    const { client, sent } = fakeTransport(() =>
      Response.json({ profile: "scout", name: "linear", removed: true, tokensRemoved: false }));
    await expect(client.hostRemoveProfileMcpServer("scout", "linear")).resolves.toEqual({
      profile: "scout",
      name: "linear",
      removed: true,
      tokensRemoved: false,
    });
    expect(sent.map(({ method, path, kind, body }) => ({ method, path, kind, body }))).toEqual([
      { method: "DELETE", path: "/hermes-setup/profiles/scout/mcp/servers/linear", kind: "mutation", body: undefined },
    ]);
  });

  test("refuse les noms invalides avant le transport", async () => {
    const { client, sent } = fakeTransport(() => Response.json({}));
    await expect(client.hostRemoveProfileMcpServer("default", "linear")).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(client.hostRemoveProfileMcpServer("Scout", "linear")).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    await expect(client.hostRemoveProfileMcpServer("scout", "bad name")).rejects.toMatchObject({ code: "NAME_INVALID" });
    expect(sent).toHaveLength(0);
  });

  test("une réponse sans booléens ou d'un autre profil est une erreur, pas un état", async () => {
    for (const body of [
      { profile: "scout", name: "linear", removed: true },
      { profile: "scout", name: "linear", removed: "yes", tokensRemoved: true },
      { profile: "default", name: "linear", removed: true, tokensRemoved: true },
      { profile: "scout", name: "bad name", removed: true, tokensRemoved: true },
    ]) {
      const { client } = fakeTransport(() => Response.json(body));
      await expect(client.hostRemoveProfileMcpServer("scout", "linear")).rejects.toBeInstanceOf(HermesClientError);
    }
  });

  test("un refus de l'hôte garde son code", async () => {
    const { client } = fakeTransport(() =>
      Response.json({ error: { code: "PROFILE_NOT_FOUND", message: "no profile named scout exists" } }, { status: 404 }));
    await expect(client.hostRemoveProfileMcpServer("scout", "linear")).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND" });
  });
});

describe("hostCreateProfile bundledSkills", () => {
  const bundled = { profile: "scout", requested: false, bundled: 74, bundledEnabled: 3, applied: true };

  test("asks the creation to turn the bundled skills off and keeps a proven answer", async () => {
    const { client, sent } = fakeTransport(() => Response.json({ profile: scout, bundledSkills: bundled }, { status: 201 }));
    await expect(client.hostCreateProfile("scout", { displayName: "Scout", bundledSkills: false })).resolves.toEqual({ ...scout, bundledSkills: bundled });
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ name: "scout", displayName: "Scout", bundledSkills: false });
  });

  test("an answer for another profile, a requested true or an unreadable state is no proof", async () => {
    for (const answer of [{ ...bundled, profile: "other" }, { ...bundled, requested: true }, { profile: "scout" }]) {
      const { client } = fakeTransport(() => Response.json({ profile: scout, bundledSkills: answer }, { status: 201 }));
      const created = await client.hostCreateProfile("scout", { bundledSkills: false });
      expect(created.bundledSkills).toBeUndefined();
    }
  });

  test("a creation that did not ask sends no field and ignores a stray answer", async () => {
    const { client, sent } = fakeTransport(() => Response.json({ profile: scout, bundledSkills: bundled }, { status: 201 }));
    const created = await client.hostCreateProfile("scout", "Scout");
    expect(created.bundledSkills).toBeUndefined();
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ name: "scout", displayName: "Scout" });
  });
});
