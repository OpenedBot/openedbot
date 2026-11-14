import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { completed, matchingToolResult, poll, terminalWorkflow, restartIdleGateway, keyedPost, type ToolEvent, type Workflow } from "./p1-evidence";
import { McpFixture, mcpProbeToolName } from "./p1-mcp-fixture";
import { proofPng } from "./p1-image";
import type { Turn } from "./bots";

const turn = (status: string, output: string | null, terminalType: "run.completed" | "run.error" = "run.completed"): Turn => ({
  runId: "test-run", t0: 0, acceptedMs: 0, marks: { terminalType, terminalEvents: 1 },
  run: { id: "test-run", status, output, origin: null, createdAt: new Date(), startedAt: null, endedAt: null, executionSessionKey: null },
});

describe("P1 evidence rejects false success", () => {
  test("reports bounded failure codes without model output or raw error messages", () => {
    const failed = turn("failed", "PRIVATE_OUTPUT", "run.error");
    failed.marks!.terminalPayload = { errorCode: "HERMES_RUN_INTERRUPTED", message: "PRIVATE_MESSAGE" };
    expect(() => completed(failed)).toThrow("HERMES_RUN_INTERRUPTED");
    try { completed(failed); } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_OUTPUT");
      expect(String(error)).not.toContain("PRIVATE_MESSAGE");
    }
    failed.marks!.terminalPayload.errorCode = "PRIVATE_INVALID_CODE\n";
    expect(() => completed(failed)).toThrow("did not complete (failed).");
  });
  test("requires persisted completion and exact fixture value", () => {
    expect(completed(turn("completed", "FIXTURE"), "FIXTURE")).toBe("FIXTURE");
    for (const candidate of [turn("running", "FIXTURE"), turn("failed", "FIXTURE"), turn("completed", "", "run.error"), turn("completed", "other")]) {
      expect(() => completed(candidate, "FIXTURE")).toThrow();
    }
    expect(() => completed(turn("completed", "almost FIXTURE"), "FIXTURE")).toThrow();
  });
  test("does not pair an orphan result or a different tool call", () => {
    const events: ToolEvent[] = [
      { type: "tool.call", payload: { tool: "memory", toolCallId: "call-1" } },
      { type: "tool.result", payload: { tool: "memory", toolCallId: "call-2", error: false } },
    ];
    expect(() => matchingToolResult(events, "memory")).toThrow("paired");
    events.push({ type: "tool.result", payload: { tool: "file", toolCallId: "call-1", error: false } });
    expect(() => matchingToolResult(events, "memory")).toThrow("paired");
    events.push({ type: "tool.result", payload: { tool: "memory", toolCallId: "call-1", error: true } });
    expect(() => matchingToolResult(events, "memory")).toThrow("successful");
    expect(matchingToolResult(events, "memory", true).payload.error).toBe(true);
  });
  test("a reversed tool history never proves an executed call", () => {
    expect(() => matchingToolResult([
      { type: "tool.result", payload: { tool: "memory", toolCallId: "one", error: false } },
      { type: "tool.call", payload: { tool: "memory", toolCallId: "one" } },
    ], "memory")).toThrow("call-before-result");
  });
  test("duplicate or uncounted terminals cannot count as completion", () => {
    for (const terminalEvents of [undefined, 0, 2]) {
      const candidate = turn("completed", "FIXTURE");
      candidate.marks!.terminalEvents = terminalEvents;
      expect(() => completed(candidate, "FIXTURE")).toThrow();
    }
  });
  test("a missing tool result identity never counts as a pair", () => {
    expect(() => matchingToolResult([{ type: "tool.call", payload: { tool: "memory" } }, { type: "tool.result", payload: { tool: "memory", error: false } }], "memory")).toThrow();
  });
  test("polling is bounded and retains dependency errors", async () => {
    let reads = 0;
    expect(await poll(async () => ++reads, (value) => value === 1, 10, "fast")).toBe(1);
    await expect(poll(async () => false, Boolean, 1, "missing")).rejects.toThrow("did not settle");
    await expect(poll(async () => { throw new Error("dependency offline"); }, Boolean, 10, "dependency")).rejects.toThrow("dependency offline");
  });
  test("ambiguous workflow state is settled evidence but never success", () => {
    for (const status of ["completed", "failed", "expired", "cancelled", "unknown"]) expect(terminalWorkflow({ status } as Workflow)).toBe(true);
    for (const status of ["queued", "running", "awaiting_approval", "reconciling"]) expect(terminalWorkflow({ status } as Workflow)).toBe(false);
  });
});

describe("controlled MCP fixture", () => {
  const request = (fixture: McpFixture, body: unknown, path = `/${fixture.namespace}/mcp`) => new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body) });
  test("namespace and protocol guards never expose the secret", async () => {
    const fixture = new McpFixture();
    expect((await fixture.handle(request(fixture, { jsonrpc: "2.0", id: 1, method: "initialize" }, "/wrong/mcp"))).status).toBe(404);
    expect((await fixture.handle(request(fixture, { id: 1, method: "tools/call" }))).status).toBe(400);
    const invalid = await fixture.handle(request(fixture, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_probe", arguments: {} } }));
    expect((await invalid.json()).error.code).toBe(-32602);
    expect(fixture.calls).toEqual([]);
    const listing = await fixture.handle(request(fixture, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(await listing.text()).not.toContain(fixture.secret);
    const huge = new Request(`http://127.0.0.1/${fixture.namespace}/mcp`, { method: "POST", body: "x".repeat(16385) });
    expect((await fixture.handle(huge)).status).toBe(413);
  });
  test("records the exact challenge independently, then returns an explicit tool error", async () => {
    const fixture = new McpFixture();
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_probe", arguments: { challenge: "fresh-turn" } } };
    const live = await fixture.handle(request(fixture, call));
    expect((await live.json()).result.content[0].text).toBe(fixture.secret);
    fixture.online = false;
    const unavailable = await fixture.handle(request(fixture, { ...call, params: { ...call.params, arguments: { challenge: "failed-turn" } } }));
    const result = (await unavailable.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("E2E_FIXTURE_UNAVAILABLE");
    expect(fixture.calls).toEqual([{ challenge: "fresh-turn", succeeded: true }, { challenge: "failed-turn", succeeded: false }]);
  });
  test("uses the native double-underscore MCP registry name", () => {
    expect(mcpProbeToolName("e2e_ab_cd")).toBe("mcp__e2e_ab_cd__read_probe");
    expect(() => mcpProbeToolName("wrong.name")).toThrow();
    expect(() => mcpProbeToolName("a".repeat(41))).toThrow();
  });
  test("requires trusted HTTPS ingress and rejects embedded credentials", () => {
    const fixture = new McpFixture();
    expect(fixture.url("https://fixture.example")).toEndWith(`/${fixture.namespace}/mcp`);
    for (const origin of ["http://fixture.example", "https://user:password@fixture.example", "https://fixture.example?token=x", "https://fixture.example#x", "https://fixture.example/prefix"]) expect(() => fixture.url(origin)).toThrow();
  });
});

describe("raster proof", () => {
  function pixels(png: Buffer): Buffer {
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      if (png.subarray(at + 4, at + 8).toString() === "IDAT") return inflateSync(png.subarray(at + 8, at + 8 + length));
      at += length + 12;
    }
    throw new Error("Missing raster pixels");
  }
  test("a recovery fact changes only the lower region's pixels", () => {
    const original = proofPng("12345");
    const recovered = proofPng("12345", "67890");
    const changed = proofPng("12345", "67891");
    const firstRowBytes = (original.readUInt32BE(16) * 3 + 1) * original.readUInt32BE(20);
    expect(recovered.readUInt32BE(20)).toBeGreaterThan(original.readUInt32BE(20));
    expect(pixels(recovered).subarray(0, firstRowBytes)).toEqual(pixels(original));
    expect(pixels(recovered).subarray(0, firstRowBytes)).toEqual(pixels(changed).subarray(0, firstRowBytes));
    expect(pixels(recovered).subarray(firstRowBytes).equals(pixels(changed).subarray(firstRowBytes))).toBe(false);
    expect(() => proofPng("12345", "lower")).toThrow();
  });
  test("writes decodable pixels without disclosing the code in metadata", () => {
    const png = proofPng("12345");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(png.readUInt32BE(16)).toBeGreaterThan(300);
    const chunks: string[] = [];
    let pixels: Buffer | undefined;
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      const type = png.subarray(at + 4, at + 8).toString();
      chunks.push(type);
      if (type === "IDAT") pixels = inflateSync(png.subarray(at + 8, at + 8 + length));
      at += length + 12;
    }
    expect(chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(pixels?.includes(0)).toBe(true);
    expect(pixels?.includes(255)).toBe(true);
    expect(proofPng("12346").equals(png)).toBe(false);
    expect(() => proofPng("12abc")).toThrow();
  });
});

describe("P1 scenario admission and cleanup", () => {
  async function skillFixture(origin: string, add: (name: string) => unknown = (name) => ({ name, unreachable: true, discoveredTools: [] }), staleAfterCreate = 0) {
    const { ScenarioRecorder } = await import("./report");
    const state = { server: undefined as string | undefined, groupDeleted: false, skillName: "", skillProof: "", postCreateInventoryReads: 0, mcpCalls: [] as Array<{ method: string; path: string }> };
    const bots: Array<{ id: string; threadId: string; hermesProfile: string; slug: string }> = [];
    const admitted = new Map<string, { turn: Turn; threadId: string }>();
    const send = async (threadId: string, input: string) => {
      const learning = threadId === bots[0]!.threadId;
      if (learning) {
        const payload = /using this exact JSON object: (\{.*\})\. Use only that single create operation/.exec(input)?.[1];
        expect(payload).toBeDefined();
        const create = JSON.parse(payload!) as { operations: Array<{ action: string; name: string; content: string }> };
        expect(Object.keys(create)).toEqual(["operations"]);
        expect(create.operations).toHaveLength(1);
        const operation = create.operations[0]!;
        expect(Object.keys(operation).sort()).toEqual(["action", "content", "name"]);
        expect(operation.action).toBe("create");
        expect(operation.name).toMatch(/^e2e-probe-[a-z0-9-]+$/);
        expect(operation.content).toStartWith(`---\nname: ${operation.name}\ndescription: `);
        const description = /^description: (.+)$/m.exec(operation.content)?.[1];
        expect(description).toBeDefined();
        // Hermes 0.23 rejects create before writing when its prompt description exceeds 60 characters.
        expect(description!.length).toBeLessThanOrEqual(60);
        expect(operation.content).toContain("\n---\n# Acceptance proof\n");
        const proof = /return only this exact value: (SKILL_[a-f0-9]+)/.exec(operation.content)?.[1];
        expect(proof).toBeDefined();
        state.skillName = operation.name;
        state.skillProof = proof!;
      }
      const result = turn("completed", learning ? "INSTALLED" : state.skillProof);
      result.runId = learning ? "learning" : "using"; result.run!.id = result.runId;
      admitted.set(result.runId, { turn: result, threadId });
      return result;
    };
    const context = {
      config: { fixtureOrigin: origin, fixturePort: 0, runTimeoutMs: 100 }, rec: new ScenarioRecorder(),
      lab: {
        tag: "owned-test",
        async create() { const index = bots.length; const bot = { id: `bot-${index}`, threadId: `thread-${index}`, hermesProfile: `profile-${index}`, hermesProfileManaged: true, slug: `bot-${index}` }; bots.push(bot); return bot; },
        async waitProvision() { return { status: "succeeded" }; },
        async setModel(bot: unknown) { return bot; },
        send,
        events: { async waitTerminal(runId: string) { return admitted.get(runId)?.turn.marks; } },
        async run(runId: string) { return admitted.get(runId)?.turn.run; },
        async db(_query: TemplateStringsArray, ...values: unknown[]) {
          if (_query.join('').includes('from approval_requests')) return [];
          if (_query.join('').includes('from runs')) {
            const runId = String(values[0]), entry = admitted.get(runId)!;
            return [{ id: runId, organizationId: 'owned-org', botId: bots[0]!.id, threadId: entry.threadId, status: 'completed', remoteId: 'remote' }];
          }
          const tool = values.includes("learning") ? "skill_manage" : "skill_view";
          return [{ type: "tool.call", payload: { tool, toolCallId: "owned-call" } }, { type: "tool.result", payload: { tool, toolCallId: "owned-call", error: false } }];
        },
      },
      session: {
        organizationId: "owned-org", runtime: { id: 'runtime' }, hasFeature: () => true,
        async api(method: string, path: string, body?: { name?: string; enabled?: boolean; input?: string }) {
          const message = /^\/api\/threads\/([^/]+)\/messages$/.exec(path);
          if (message && method === 'POST') return { runId: (await send(message[1]!, body!.input!)).runId };
          if (path.startsWith("/api/runtime/integrations/mcp")) {
            state.mcpCalls.push({ method, path });
            if (method === "GET") return { servers: state.server ? [{ name: state.server, endpoint: "https://fixture.example/..." }] : [] };
            if (method === "POST") { state.server = body!.name!; return add(state.server); }
            if (method === "DELETE") { state.server = undefined; return undefined; }
          }
          const capability = /^\/api\/bots\/([^/]+)\/capabilities$/.exec(path);
          if (capability && method === "GET") {
            const visible = state.skillName && ++state.postCreateInventoryReads > staleAfterCreate;
            return { scope: "profile", hermesProfile: bots.find((bot) => bot.id === capability[1])!.hermesProfile, inventoryError: null,
              toolsets: [], mcpServers: [], skills: visible ? [{ name: state.skillName, enabled: true }] : [] };
          }
          if (path.includes("/capabilities/toolsets/") && method === "POST") return { enabled: body!.enabled, applied: true };
          if (path === "/api/groups" && method === "POST") return { id: "owned-group", threadId: "owned-group-thread" };
          if (path === "/api/groups/owned-group" && method === "GET") return { id: "owned-group", threadId: "owned-group-thread" };
          if (path === "/api/groups/owned-group" && method === "DELETE") { state.groupDeleted = true; return undefined; }
          if (path === "/api/threads/owned-group-thread" && method === "GET") return { runs: [] };
          if (path.endsWith("/stop") && method === "POST") return undefined;
          throw new Error(`Unexpected fixture request ${method} ${path}`);
        },
      },
    };
    return { context, state };
  }
  for (const staleReads of [1, 2]) test(`native skill inventory waits through ${staleReads} cached snapshots before exact enabled evidence`, async () => {
    const { skillsMcp } = await import("../scenarios/skills-mcp");
    const { context, state } = await skillFixture("http://fixture.example", undefined, staleReads);
    context.config.runTimeoutMs = 1200;
    // The intentional later HTTPS refusal bounds this fixture; the skill
    // install, exact inventory and independent new-session use must all pass.
    await expect(skillsMcp.run(context as unknown as import("./scenario").ScenarioContext)).rejects.toThrow();
    expect(context.rec.steps[3]?.note).toContain('HTTPS');
    expect(state.postCreateInventoryReads).toBe(staleReads + 1);
    expect(context.rec.steps.map((step) => step.status)).toEqual(["pass", "pass", "pass", "fail"]);
    expect(state.mcpCalls).toEqual([]); expect(state.groupDeleted).toBe(true);
  });
  test("a created skill that never appears fails within the caller budget before any MCP write", async () => {
    const { skillsMcp } = await import("../scenarios/skills-mcp");
    const { context, state } = await skillFixture("https://fixture.example", undefined, Infinity);
    context.config.runTimeoutMs = 20;
    await expect(skillsMcp.run(context as unknown as import("./scenario").ScenarioContext)).rejects.toThrow();
    expect(context.rec.steps[1]?.note).toContain('owned profile inventory did not settle within 20 ms');
    expect(context.config.runTimeoutMs).toBe(20);
    expect(state.postCreateInventoryReads).toBeGreaterThan(0);
    expect(context.rec.steps.map((step) => step.status)).toEqual(["pass", "fail"]);
    expect(state.mcpCalls).toEqual([]); expect(state.groupDeleted).toBe(true);
  });
  test("MCP discovery failure preserves prior skill proof and removes only its confirmed root server", async () => {
    const { skillsMcp } = await import("../scenarios/skills-mcp");
    const { context, state } = await skillFixture("https://fixture.example");
    await expect(skillsMcp.run(context as unknown as import("./scenario").ScenarioContext)).rejects.toThrow();
    expect(state.server).toBeUndefined();
    const deletions = state.mcpCalls.filter((call) => call.method === "DELETE");
    expect(deletions).toHaveLength(1);
    expect(deletions[0]!.path).toStartWith("/api/runtime/integrations/mcp/servers/e2e_owned-test_");
    expect(context.rec.steps.map((step) => step.status)).toEqual(["pass", "pass", "pass", "fail"]);
    expect(context.rec.steps[3]?.note).toContain("could not discover");
    expect(state.groupDeleted).toBe(true);
  });
  test("an ambiguous MCP add is reported and never removed using redacted inventory", async () => {
    const { skillsMcp } = await import("../scenarios/skills-mcp");
    const { context, state } = await skillFixture("https://fixture.example", () => { throw new Error("Response lost after dispatch"); });
    await expect(skillsMcp.run(context as unknown as import("./scenario").ScenarioContext)).rejects.toThrow();
    expect(state.server).toStartWith("e2e_owned-test_");
    expect(state.mcpCalls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect(context.rec.steps[3]?.note).toContain("unconfirmed outcome");
    expect(context.rec.steps[3]?.note).toContain("reconcile this exact generated server name");
    expect(state.groupDeleted).toBe(true);
  });
  test("missing HTTPS keeps proven skills but fails MCP before any MCP write", async () => {
    const { skillsMcp } = await import("../scenarios/skills-mcp");
    const { context, state } = await skillFixture("http://fixture.example");
    await expect(skillsMcp.run(context as unknown as import("./scenario").ScenarioContext)).rejects.toThrow();
    expect(state.mcpCalls).toEqual([]);
    expect(context.rec.steps.map((step) => step.status)).toEqual(["pass", "pass", "pass", "fail"]);
    expect(context.rec.steps[3]?.note).toContain("HTTPS");
    expect(state.groupDeleted).toBe(true);
  });
});

describe("P1 restart and request boundaries", () => {
  test("any database tenant's unsettled work blocks a gateway restart", async () => {
    let apiCalls = 0;
    let globalGuard = false;
    const context = {
      config: { runTimeoutMs: 10 },
      lab: { db: async (_sql: TemplateStringsArray, global: boolean) => { globalGuard = global; return [{ count: 1 }]; } },
      session: { organizationId: "owner", hasFeature: () => true, api: async () => { apiCalls++; } },
    };
    await expect(restartIdleGateway(context as unknown as import("./scenario").ScenarioContext, ["owned"])).rejects.toThrow("unsettled database");
    expect(globalGuard).toBe(true);
    expect(apiCalls).toBe(0);
  });
  test("a successful job without a newer gateway start timestamp fails evidence", async () => {
    for (const after of [null, "invalid", "2026-11-09T10:00:00Z", "2026-11-09T09:00:00Z"]) {
      let statusReads = 0;
      const context = {
        config: { runTimeoutMs: 10 }, lab: { db: async () => [{ count: 0 }] },
        session: {
          hasFeature: () => true,
          api: async (_method: string, path: string) => path === "/api/runtime/integrations/gateway"
            ? { activeSince: ++statusReads === 1 ? "2026-11-09T10:00:00Z" : after }
            : { jobId: "owned-job", status: "ok" },
        },
      };
      await expect(restartIdleGateway(context as unknown as import("./scenario").ScenarioContext, [])).rejects.toThrow("did not advance");
    }
  });
  test("a newer independent gateway timestamp proves the completed restart", async () => {
    let statusReads = 0;
    const context = {
      config: { runTimeoutMs: 10 }, lab: { db: async () => [{ count: 0 }] },
      session: { hasFeature: () => true, api: async (_method: string, path: string) => path === "/api/runtime/integrations/gateway"
        ? { activeSince: ++statusReads === 1 ? "2026-11-09T10:00:00Z" : "2026-11-09T10:01:00Z" }
        : { jobId: "owned-job", status: "ok" } },
    };
    await restartIdleGateway(context as unknown as import("./scenario").ScenarioContext, []);
    expect(statusReads).toBe(2);
  });
  test("a keyed mutation never follows a redirect to another server", async () => {
    let forwarded = 0;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { forwarded++; return Response.json({ accepted: true }, { status: 202 }); } });
    const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 307, headers: { Location: `${target.url}unexpected` } }) });
    try {
      const session = { baseUrl: source.url.toString().replace(/\/$/, ""), streamHeaders: () => ({ "Content-Type": "application/json" }) };
      await expect(keyedPost(session, "/start", crypto.randomUUID(), { input: "owned fixture" })).rejects.toThrow();
      expect(forwarded).toBe(0);
    } finally { source.stop(true); target.stop(true); }
  });
});
