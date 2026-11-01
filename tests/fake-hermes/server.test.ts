/**
 * The fake gateway must pass the same gate the API applies to a real runtime
 * (`probeRuntimeCapacity`: /health + /v1/capabilities + /v1/toolsets contract)
 * and the reads the seed and the worker perform on top of it. Boots on an
 * ephemeral port, no Docker, no network beyond loopback.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { HermesClient, HermesClientError } from "../../platform/hermes/src/index";
import type { EndpointPolicy } from "../../platform/hermes/src/endpoint";
import { runtimeToolsetContractViolation } from "../../modules/runtimes/src/domain/runtime-contract";
import { HermesEventNormalizer } from "../../modules/execution/src/domain/hermes-events";
import { readGateIdentity } from "../../modules/execution/src/domain/gate-identity";
import { fakeApprovalGate, startFakeHermes } from "./server";

const token = "fake-test-token";
let server: Server<undefined>;
let endpoint: string;
let policy: EndpointPolicy;
let client: HermesClient;

beforeAll(() => {
  server = startFakeHermes({ port: 0, token, delayMs: 1, capacity: 3 });
  const origin = `127.0.0.1:${server.port}`;
  endpoint = `http://${origin}`;
  policy = { environment: "development", insecureOrigins: new Set([origin]) };
  client = new HermesClient({ endpoint, token, policy, mtls: null });
});

afterAll(() => {
  server.stop(true);
});

describe("fake Hermes gateway", () => {
  test("answers the capacity probe: health, capabilities and a conforming toolset inventory", async () => {
    const health = await fetch(`${endpoint}/health`);
    expect(health.status).toBe(200);

    const probe = await client.probe();
    expect(probe.health).toEqual({ ok: true, service: "fake-hermes" });
    const capabilities = probe.capabilities as { features?: { max_concurrent_runs?: unknown } };
    expect(capabilities.features?.max_concurrent_runs).toBe(3);
    expect(await client.runSteerSupported()).toBe(true);

    const toolsets = await client.toolsets();
    expect(toolsets).not.toBeNull();
    expect(runtimeToolsetContractViolation(toolsets)).toBeNull();
    expect(toolsets!.some((toolset) => toolset.name === "code_execution" && toolset.enabled)).toBe(true);
  });

  test("serves the host session inventory: identifiers only, plus the sessions OHB never created", async () => {
    const stranger = startFakeHermes({ port: 0, token, unattributedSessions: ["ghost-session"] });
    try {
      await new HermesClient({ endpoint: `http://127.0.0.1:${stranger.port}`, token, policy: { environment: "development", insecureOrigins: new Set([`127.0.0.1:${stranger.port}`]) }, mtls: null })
        .ensureSession("session-known", "Known");
      const response = await fetch(`http://127.0.0.1:${stranger.port}/hermes-setup/sessions-inventory`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const inventory = await response.json() as { sessions: Array<Record<string, unknown>>; total: number; truncated: boolean };
      expect(inventory.sessions.map((session) => session.id)).toEqual(["session-known", "ghost-session"]);
      expect(inventory.total).toBe(2);
      expect(inventory.truncated).toBe(false);
      expect(Object.keys(inventory.sessions[0]!).sort()).toEqual(["createdAt", "id", "profile"]);
    } finally {
      stranger.stop(true);
    }
    const quiet = await fetch(`${endpoint}/hermes-setup/sessions-inventory`, { headers: { Authorization: `Bearer ${token}` } });
    expect(((await quiet.json()) as { sessions: unknown[] }).sessions.every((session) => (session as { id: string }).id !== "ghost-session")).toBe(true);
  });

  test("refuses a wrong bearer everywhere except /health", async () => {
    const denied = await fetch(`${endpoint}/v1/capabilities`, { headers: { Authorization: "Bearer nope" } });
    expect(denied.status).toBe(401);
  });

  test("publishes one authenticated provider and an empty skill list", async () => {
    const options = await client.modelOptions();
    expect(options.provider).toBe("fake");
    expect(options.providers.some((provider) => provider.authenticated && provider.slug !== "moa")).toBe(true);
    expect(options.providers[0]?.models.map((model) => model.id)).toEqual(["fake/hermes", "fake/hermes-fast"]);

    const inventory = await client.capabilityInventory();
    expect(inventory.skills).toEqual([]);
    expect(inventory.toolsets).not.toBeNull();
  });

  test("runs are idempotent by key, steerable while active, and readable after completion", async () => {
    const sessionId = "session-fake-1";
    await client.ensureSession(sessionId, "Fake session");
    await client.ensureSession(sessionId, "Fake session"); // 409 is tolerated

    const runId = await client.createRun({
      input: "ping", instructions: "", sessionId, idempotencyKey: "ohb-run-1",
    });
    const replayed = await client.createRun({
      input: "ping", instructions: "", sessionId, idempotencyKey: "ohb-run-1",
    });
    expect(replayed).toBe(runId);

    expect(await client.steerRun(runId, { text: "focus" })).toBe(202);
    // Nothing waits on this run: upstream answers 409 approval_not_pending.
    await expect(client.respondApproval(runId, "once")).rejects.toBeInstanceOf(HermesClientError);

    const started = await client.getRunStatus(runId);
    expect(started.status).toBe("queued");

    const events: string[] = [];
    let toolPreview: unknown;
    let pendingOnTerminal: unknown;
    for await (const event of client.events(runId, new AbortController().signal)) {
      events.push(event.event);
      if (event.event === "tool.completed") toolPreview = event.preview;
      if (event.event === "run.completed") pendingOnTerminal = event.pending_steer;
    }
    expect(events).toContain("run.completed");
    expect(toolPreview).toBe("Fake gateway run");
    // Le faux ne lit jamais un steer : il revient non lu sur le terminal, là
    // où l'amont le rend quand la réponse finale précède la frontière d'outil.
    expect(pendingOnTerminal).toBe("focus");

    const completed = await client.getRunStatus(runId);
    expect(completed.status).toBe("completed");
    expect(completed.output).toBe("OPENEDBOT_CANARY_OK ping");
    expect(completed.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(completed.pendingSteer).toBe("focus");

    const counters = await client.sessionCounters(sessionId);
    expect(counters.inputTokens).toBe(2);
    expect(counters.outputTokens).toBe(3);

    await expect(client.steerRun(runId, { text: "too late" })).rejects.toBeInstanceOf(HermesClientError);
    await expect(client.getRunStatus("fake_missing")).rejects.toMatchObject({ code: "HERMES_RUN_MISSING" });
  });

  test("serves todo_list events, bridge and legacy transcript messages, and interrupted runs", async () => {
    const scenario = startFakeHermes({ port: 0, token, delayMs: 1, emitTodoScenario: true });
    const interrupted = startFakeHermes({ port: 0, token, delayMs: 1, interruptRun: true });
    try {
      const scenarioOrigin = `127.0.0.1:${scenario.port}`;
      const scenarioClient = new HermesClient({ endpoint: `http://${scenarioOrigin}`, token, mtls: null,
        policy: { environment: "development", insecureOrigins: new Set([scenarioOrigin]) } });
      await scenarioClient.ensureSession("todo-session", "Todo");
      const scenarioRun = await scenarioClient.createRun({ input: "todo", instructions: "", sessionId: "todo-session" });
      const normalizer = new HermesEventNormalizer();
      const eventNames: string[] = [];
      let completed: ReturnType<HermesEventNormalizer["push"]> = [];
      for await (const event of scenarioClient.events(scenarioRun, new AbortController().signal)) {
        eventNames.push(event.event);
        const normalized = normalizer.push(event);
        if (event.event === "run.completed") completed = normalized;
      }
      expect(eventNames).toContain("tool.started");
      expect(eventNames).toContain("message.interim");
      expect(completed.find((entry) => entry.payload.agentPlan)?.payload.agentPlan).toMatchObject({ steps: [
        { id: "inspect", status: "pending" },
        { id: "ship", status: "completed" },
      ] });
      expect((await scenarioClient.sessionMessages("todo-session"))).toHaveLength(1);

      const interruptedOrigin = `127.0.0.1:${interrupted.port}`;
      const interruptedClient = new HermesClient({ endpoint: `http://${interruptedOrigin}`, token, mtls: null,
        policy: { environment: "development", insecureOrigins: new Set([interruptedOrigin]) } });
      const interruptedRun = await interruptedClient.createRun({ input: "interrupt", instructions: "", sessionId: "interrupted" });
      const interruptedEvents: string[] = [];
      for await (const event of interruptedClient.events(interruptedRun, new AbortController().signal)) interruptedEvents.push(event.event);
      expect(interruptedEvents).toContain("run.interrupted");
      expect((await interruptedClient.getRunStatus(interruptedRun)).status).toBe("interrupted");
    } finally {
      scenario.stop(true);
      interrupted.stop(true);
    }
  });
});

test("fake profiles have real existence, isolation and mutable capability contracts", async () => {
  expect(await client.probeProfileIsolation("unknown")).toBe("missing");
  await client.hostCreateProfile("import-fixture", { displayName: "Import fixture", provider: "fake", model: "fake/hermes" });
  expect(await client.probeProfileIsolation("import-fixture")).toBe("isolated");
  await expect(client.hostCreateProfile("import-fixture")).rejects.toMatchObject({ code: "PROFILE_EXISTS" });
  expect(await client.hostSetProfileToolset("import-fixture", "web", false)).toMatchObject({ enabled: false, applied: true });
  expect(await client.hostSetProfileToolset("import-fixture", "web", true)).toMatchObject({ enabled: true, applied: true });
  expect((await client.hostProfileInventory()).profiles[0]?.toolsets).toContainEqual({ name: "web", enabled: true });
  await client.hostDeleteProfile("import-fixture");
  expect(await client.probeProfileIsolation("import-fixture")).toBe("missing");
});

test("streams the extra deltas it was asked for, spaced in time, and keeps them in the output", async () => {
  const streaming = startFakeHermes({ port: 0, token, delayMs: 1, capacity: 1, streamDeltas: 3, streamIntervalMs: 20 });
  try {
    const origin = `127.0.0.1:${streaming.port}`;
    const streamingClient = new HermesClient({
      endpoint: `http://${origin}`, token, mtls: null,
      policy: { environment: "development", insecureOrigins: new Set([origin]) },
    });
    const runId = await streamingClient.createRun({ input: "ping", instructions: "", sessionId: "fake-hermes-stream-test" });
    const deltas: Array<{ at: number; text: string }> = [];
    for await (const event of streamingClient.events(runId, new AbortController().signal)) {
      if (event.event === "message.delta") deltas.push({ at: performance.now(), text: String(event.delta) });
    }
    expect(deltas.map((delta) => delta.text)).toEqual(["OPENEDBOT_", "chunk0 ", "chunk1 ", "chunk2 ", "CANARY_OK"]);
    expect(deltas[3]!.at - deltas[0]!.at).toBeGreaterThanOrEqual(50);
    expect((await streamingClient.getRunStatus(runId)).output).toBe("OPENEDBOT_chunk0 chunk1 chunk2 CANARY_OK ping");
  } finally {
    streaming.stop(true);
  }
});

test("pauses on each FAKE_APPROVAL gate and resolves it by request_id, FIFO otherwise", async () => {
  const sessionId = "fake-hermes-approval-test";
  await client.ensureSession(sessionId, "Approvals");
  const runId = await client.createRun({
    input: "do FAKE_APPROVAL:terminal then FAKE_APPROVAL:plugin:mcp:github:create_issue",
    instructions: "",
    sessionId,
  });
  const answer = (body: Record<string, unknown>) =>
    fetch(`${endpoint}/v1/runs/${runId}/approval`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const requests: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  for await (const event of client.events(runId, new AbortController().signal)) {
    events.push(event.event);
    if (event.event !== "approval.request") continue;
    requests.push(event as Record<string, unknown>);
    expect((await client.getRunStatus(runId)).status).toBe("waiting_for_approval");
    if (requests.length === 1) {
      const stranger = await answer({ choice: "once", request_id: "not-this-gate" });
      expect(stranger.status).toBe(409);
      expect(await stranger.json()).toMatchObject({ error: { code: "approval_not_pending" } });
      const targeted = await answer({ choice: "approve", request_id: event.request_id });
      expect(targeted.status).toBe(200);
      expect(await targeted.json()).toMatchObject({ choice: "once", request_id: event.request_id, resolved: 1 });
    } else {
      expect((await answer({ choice: "deny" })).status).toBe(200);
    }
  }

  expect(requests.map((request) => request.pattern_key)).toEqual([
    "recursive delete",
    "plugin_rule:ohb/v1/mcp:github:create_issue",
  ]);
  expect(requests[1]).toMatchObject({
    command: "<mcp__github__create_issue> (plugin approval rule)",
    choices: ["once", "session", "always", "deny"],
  });
  expect(new Set(requests.map((request) => request.request_id)).size).toBe(2);
  expect(events.filter((name) => name === "approval.responded")).toHaveLength(2);
  expect(events.at(-1)).toBe("run.completed");
  expect((await answer({ choice: "once" })).status).toBe(409);
});

test("a stop withdraws a pending gate instead of answering it", async () => {
  const runId = await client.createRun({ input: "FAKE_APPROVAL:plugin:write_file", instructions: "", sessionId: "fake-hermes-withdraw" });
  const events: string[] = [];
  for await (const event of client.events(runId, new AbortController().signal)) {
    events.push(event.event);
    if (event.event === "approval.request") await client.stopRun(runId);
  }
  expect(events).toContain("approval.request");
  expect(events).not.toContain("approval.responded");
  expect(events.at(-1)).toBe("run.cancelled");
});

test("every fake gate is read by the worker as the gate it stands for", () => {
  for (const toolKey of ["write_file", "patch", "skill_manage", "send_message", "execute_code", "cronjob", "mcp:github:create_issue"]) {
    expect(readGateIdentity(fakeApprovalGate(`plugin:${toolKey}`, "req"))).toMatchObject({ gateKind: "plugin_tool", toolKey, hermesRequestId: "req" });
  }
  expect(readGateIdentity(fakeApprovalGate("terminal", "req"))).toMatchObject({ gateKind: "terminal_danger", gateArgs: { patternKey: "recursive delete" } });
});
