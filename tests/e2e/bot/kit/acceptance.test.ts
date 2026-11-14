import { describe, expect, test } from "bun:test";
import { completed, waitUntil } from "./acceptance";
import { readConfig } from "./config";
import { EventStream } from "./events";
import { ScenarioRecorder, Skip, StepFailed, warn, worst } from "./report";
import { replayAgreement } from "../scenarios/concurrency-idempotency";
import { cleanupVerdict } from "./bots";
import { enforceAcceptanceTarget, isAcceptance, pickScenarios } from "./scenarios";

const env = { E2E_ALLOW_REAL_RUNS: "1", WORKER_DATABASE_URL: "postgres://unused@127.0.0.1/e2e" };

describe("acceptance is not a benchmark success", () => {
  test("missing cleanup cannot pass when the API promised work or a managed profile was ready", () => {
    expect(cleanupVerdict("queued", "none", false)).toBe("failed");
    expect(cleanupVerdict("none", "none", true)).toBe("failed");
    expect(cleanupVerdict("none", "none", false)).toBe("none");
    expect(cleanupVerdict("queued", "succeeded", true)).toBe("succeeded");
    expect(cleanupVerdict("queued", "timeout", true)).toBe("timeout");
  });
  test("suite selection covers all eleven priorities without duplicate execution or hidden typos", () => {
    expect(pickScenarios(["p0"])).toHaveLength(5);
    expect(pickScenarios(["p1"])).toHaveLength(6);
    const acceptance = pickScenarios(["p0", "p1", "acceptance", "tool-execution"]);
    expect(acceptance).toHaveLength(11);
    expect(acceptance.every(isAcceptance)).toBe(true);
    expect(pickScenarios(["all"])).toHaveLength(17);
    expect(() => pickScenarios(["all", "typo"])).toThrow("typo");
    expect(() => pickScenarios(["constructor"])).toThrow("constructor");
  });
  test("strict mode refuses unsupported features and model reservations", async () => {
    for (const outcome of [() => { throw new Skip("missing"); }, () => warn("no tool")]) {
      const rec = new ScenarioRecorder(true);
      await expect(rec.step("required", async () => outcome())).rejects.toBeInstanceOf(StepFailed);
      expect(rec.steps).toHaveLength(1);
      expect(rec.steps[0]?.status).toBe("fail");
    }
    expect(worst(["pass", "skip"])).toBe("skip");
    expect(worst([])).toBe("skip");
  });

  test("acceptance requires an explicit target and forbids keeping test bots", () => {
    const config = readConfig([], env);
    expect(() => enforceAcceptanceTarget(config, pickScenarios(["p0"]))).toThrow("E2E_RUNTIME_ID");
    config.expectedRuntimeId = "explicit-lab";
    enforceAcceptanceTarget(config, pickScenarios(["p1"]));
    expect(config.strict).toBe(true);
    config.keep = true;
    expect(() => enforceAcceptanceTarget(config, pickScenarios(["p1"]))).toThrow("--keep");
  });

  test("completed requires exact terminal count, persistence, and expected marker", () => {
    const evidence = { runId: "r", run: { status: "completed", output: "MARK" }, marks: { terminalType: "run.completed", terminalEvents: 1 } };
    // The fixture deliberately supplies only the evidence read by this function.
    const check = (value: unknown) => completed(value as Parameters<typeof completed>[0], "MARK");
    expect(() => check(evidence)).not.toThrow();
    for (const invalid of [
      { ...evidence, run: { status: "failed", output: "MARK" } },
      { ...evidence, run: { status: "completed", output: "other" } },
      { ...evidence, marks: { terminalType: "run.completed", terminalEvents: 2 } },
    ]) expect(() => check(invalid)).toThrow();
  });

  test("replay agreement rejects changed message, run and workflow identities", () => {
    const a = { runId: "r", message: { id: "m" }, workflowId: null };
    expect(replayAgreement([a, a])).toBe(a);
    for (const changed of [{ ...a, runId: "other" }, { ...a, message: { id: "other" } }, { ...a, workflowId: "w" }]) {
      expect(() => replayAgreement([a, changed])).toThrow("different");
    }
    expect(() => replayAgreement([])).toThrow();
  });

  test("polling propagates actual errors and rejects a missed deadline", async () => {
    await expect(waitUntil("probe", async () => { throw new Error("unavailable"); }, Boolean, 10)).rejects.toThrow("unavailable");
    await expect(waitUntil("probe", async () => false, Boolean, 5)).rejects.toThrow("within 5 ms");
  });
});

describe("bounded test target configuration", () => {
  test("rejects non-origin URLs, remote cleartext and invalid fixture ports", () => {
    for (const apiUrl of ["http://example.com", "https://example.com/api", "ftp://127.0.0.1", "https://user:pass@example.com"]) {
      expect(() => readConfig([], { ...env, E2E_API_URL: apiUrl })).toThrow("E2E_API_URL");
    }
    expect(() => readConfig([], { ...env, E2E_FIXTURE_PORT: "65536" })).toThrow("PORT");
    expect(() => readConfig([], { ...env, E2E_FIXTURE_ORIGIN: "http://user:pass@127.0.0.1" })).toThrow("FIXTURE");
  });

  test("fault commands require deliberate opt-in and argv, never shell interpolation", () => {
    for (const argv of ['["ssh","lab"]', '[]', '["ssh",4]', '"ssh lab"']) {
      expect(() => readConfig([], { ...env, E2E_RECOVERY_ARGV: argv })).toThrow();
    }
    expect(readConfig(["--strict"], { ...env, E2E_ALLOW_RUNTIME_FAULTS: "1", E2E_RECOVERY_ARGV: '["helper","literal;arg"]' }))
      .toMatchObject({ strict: true, recoveryCommand: ["helper", "literal;arg"] });
  });
});

describe("SSE recovery evidence on a real socket", () => {
  test("resumes cursor and records replay duplicates, malformed data and explicit gaps", async () => {
    const cursors: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      cursors.push(new URL(request.url).searchParams.get("cursor") ?? "");
      const frame = `data: ${JSON.stringify({ runId: "r", type: "tool.call", cursor: 1, sequence: 1 })}\n\n`;
      const content = cursors.length === 1 ? `: connected\n\n${frame}`
        : `: connected\n\n${frame}event: runtime.changed\ndata: {"runtimeId":null,"reason":"resync"}\n\nevent: stream.cursor\ndata: {"organizationId":"org","cursor":2}\n\ndata: broken\n\nevent: stream.gap\ndata: {"from":1,"to":2}\n\ndata: ${JSON.stringify({ runId: "r", type: "run.completed", cursor: 3, sequence: 3 })}\n\n`;
      return new Response(content, { headers: { "Content-Type": "text/event-stream" } });
    } });
    const stream = new EventStream(server.url.origin, () => ({}));
    try {
      await stream.start();
      const terminal = await stream.waitTerminal("r", 2_000);
      expect(terminal).toMatchObject({ terminalType: "run.completed", terminalEvents: 1, toolCalls: 1 });
      expect(cursors.slice(0, 2)).toEqual(["0", "1"]);
      expect(stream.duplicates).toBeGreaterThanOrEqual(1);
      expect(stream.gaps).toBeGreaterThanOrEqual(1);
      expect(stream.malformed).toBe(1);
    } finally { await stream.stop(); await server.stop(true); }
  });

  test("access revocation stops observation with a fatal error", async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return new Response(': connected\n\nevent: stream.revoked\ndata: {"code":"WORKSPACE_ACCESS_REVOKED"}\n\n');
    } });
    const stream = new EventStream(server.url.origin, () => ({}));
    try {
      await stream.start();
      await Bun.sleep(10);
      expect(stream.fatalError).toContain("revoked");
      expect(requests).toBe(1);
    } finally { await stream.stop(); await server.stop(true); }
  });
});
