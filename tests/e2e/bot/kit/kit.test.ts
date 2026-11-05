import { describe, expect, test } from "bun:test";
import { ConfigError, readConfig } from "./config";
import { EventStream, splitSseFrames } from "./events";
import { formatMs, renderReport } from "./html";
import { ScenarioRecorder, Skip, StepFailed, warn, worst, type RunReport } from "./report";
import { classCandidates } from "./tailwind";

const env = { E2E_ALLOW_REAL_RUNS: "1", WORKER_DATABASE_URL: "postgres://x@127.0.0.1/openedbot" };

describe("config", () => {
  test("refuses to run without the real-runs opt-in", () => {
    expect(() => readConfig([], { WORKER_DATABASE_URL: "postgres://x" })).toThrow(ConfigError);
  });

  test("reads scenarios and options, lifecycle by default", () => {
    expect(readConfig([], env).scenarios).toEqual(["lifecycle"]);
    const config = readConfig(["greeting", "--samples", "4", "--purge-early", "--label", "après x"], env, new Date("2026-10-23T10:00:00Z"));
    expect(config).toMatchObject({ scenarios: ["greeting"], samples: 4, purgeEarly: true, label: "apr-s-x", outDir: "tmp/e2e-bot/2026-10-23T10-00-00-apr-s-x" });
  });

  test("rejects a non-positive sample count", () => {
    expect(() => readConfig(["--samples", "0"], env)).toThrow("--samples");
  });
});

describe("SSE", () => {
  test("keeps the incomplete tail and joins multi-line data", () => {
    const { frames, rest } = splitSseFrames(": connected\n\ndata: {\"a\":\ndata: 1}\n\ndata: {\"b\"");
    expect(frames).toEqual([{ comment: "connected", data: null }, { comment: null, data: "{\"a\":\n1}" }]);
    expect(rest).toBe("data: {\"b\"");
  });

  test("marks the first event, first text and the first terminal of a run", async () => {
    const stream = new EventStream("http://unused", () => ({}));
    const waiting = stream.waitTerminal("r1", 1_000);
    stream.observe({ type: "run.started", runId: "r1" }, 10);
    stream.observe({ type: "tool.call", runId: "r1" }, 15);
    stream.observe({ type: "agent.message", runId: "r1" }, 20);
    stream.observe({ type: "run.completed", runId: "r1", payload: { completion: { version: 1 } } }, 30);
    stream.observe({ type: "run.error", runId: "r1" }, 40);
    expect(await waiting).toMatchObject({ firstEvent: 10, firstTool: 15, toolCalls: 1, firstText: 20, terminal: 30, terminalType: "run.completed" });
    expect(await stream.waitTerminal("missing", 5)).toBeNull();
  });
});

describe("recorder", () => {
  test("records pass, warn, skip and stops on a failure", async () => {
    const rec = new ScenarioRecorder();
    await rec.step("a", async () => ({ x: 1 }));
    await rec.step("b", async () => warn("format ignored"));
    await rec.step("c", async () => { throw new Skip("feature absent"); });
    await expect(rec.step("d", async () => { throw new Error("boom"); })).rejects.toBeInstanceOf(StepFailed);
    expect(rec.steps.map((step) => [step.name, step.status, step.note])).toEqual([
      ["a", "pass", null], ["b", "warn", "format ignored"], ["c", "skip", "feature absent"], ["d", "fail", "boom"],
    ]);
    expect(worst(rec.steps.map((step) => step.status))).toBe("fail");
    expect(worst(["skip", "skip"])).toBe("skip");
  });

  test("computes bench statistics over the numeric marks only", () => {
    const rec = new ScenarioRecorder();
    rec.setBench([{ key: "completeMs", label: "Fin" }], [{ completeMs: 300 }, { completeMs: 100 }, { completeMs: null }], ["completeMs"]);
    expect(rec.bench?.stats[0]).toMatchObject({ n: 2, missing: 1, p50: 100, max: 300 });
  });
});

describe("HTML report", () => {
  const report: RunReport = {
    label: "t", startedAt: "2026-10-23T10:00:00.000Z", finishedAt: "2026-10-23T10:01:00.000Z", status: "fail",
    apiUrl: "http://127.0.0.1:8790", gitSha: "abc1234", runtime: { id: "r", name: "Lab", features: [] },
    model: { provider: "p", model: "m", reasoningEffort: null }, options: { samples: 1 },
    scenarios: [{
      id: "lifecycle", title: "Cycle", summary: "s", status: "fail", ms: 1200, error: null,
      steps: [{ name: "Étape", status: "fail", ms: 5, detail: { completeMs: 2500 }, note: "<script>alert(1)</script>" }],
      bench: { columns: [{ key: "completeMs", label: "Fin" }], rows: [{ completeMs: 2500 }], stats: [], timeline: { keys: [{ key: "completeMs", label: "fin" }] } },
    }],
    cleanup: [{ botId: "b", name: "E2E Atlas", deleteMs: 40, cleanup: "succeeded", verifyPasses: 1, durationMs: 61_000 }],
    error: null,
  };

  test("escapes untrusted text and inlines the compiled utilities", async () => {
    const html = await renderReport(report);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(".bg-rose-50");
    expect(html).not.toContain("cdn.tailwindcss");
    expect(html).toContain("2,5 s");
  });

  test("collects class candidates and formats durations", () => {
    expect(classCandidates(`<a class="px-2  bg-sky-500"><b class="px-2"></b></a>`)).toEqual(["px-2", "bg-sky-500"]);
    expect([formatMs(850), formatMs(61_000), formatMs(null)]).toEqual(["850 ms", "61,0 s", "n/a"]);
  });
});
