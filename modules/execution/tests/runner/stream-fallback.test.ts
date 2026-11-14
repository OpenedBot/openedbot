import { describe, expect, test } from "bun:test";
import type { HermesClient, HermesEvent, HermesModelOptions } from "@openedbot/hermes";
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { RunTrace } from "@openedbot/platform-observability/run-trace";
import { streamHermesEvents } from "../../src/application/runner/event-stream";
import { createRunState } from "../../src/application/runner/run-state";
import type { RunContext } from "../../src/application/runner/types";
import type { WorkerConfig } from "../../src/application/worker-config";

const catalog: HermesModelOptions = {
  provider: "primary", model: "model-a",
  providers: ["primary", "backup"].map((slug, index) => ({
    slug, name: slug, isCurrent: index === 0, authenticated: true, authType: "api_key", warning: null,
    models: [{ id: index === 0 ? "model-a" : "model-b", fast: false, reasoning: false }],
  })),
};
const frame = (event: string, extra: Record<string, unknown> = {}): HermesEvent => ({
  event, run_id: "remote-1", timestamp: 1, ...extra,
});
const quota = (event = "run.failed") => frame(event, { message: "HTTP 429: The usage limit has been reached" });

type StoredEvent = { sequence: number; type: string; payload: Record<string, unknown> };

/** The real stream, normalizer, recovery and persistence with an in-memory SQL boundary. */
async function follow(frames: HermesEvent[], options: {
  resumed?: boolean; replay?: boolean; priorTools?: boolean; watermark?: number;
} = {}) {
  const stored: StoredEvent[] = options.priorTools
    ? [{ sequence: 0, type: "tool.call", payload: { tool: "write_file", toolCallId: "old-call" } }]
    : [];
  const sql = (strings: TemplateStringsArray | unknown[], ...values: unknown[]): unknown => {
    if (!("raw" in strings)) return strings;
    const query = strings.join("?");
    if (query.includes("select max(sequence) as last")) return Promise.resolve([{ last: stored.at(-1)?.sequence ?? null }]);
    if (query.includes("select cursor from run_events")) {
      return Promise.resolve(stored.some((row) => row.type.startsWith("tool.")) ? [{ cursor: 1 }] : []);
    }
    if (query.includes("from run_events call_row")) {
      return Promise.resolve(stored.filter((row) => row.type === "tool.call").map((row) => ({ ...row.payload, unfinished: true })));
    }
    if (query.includes("insert into run_events")) {
      stored.push({ sequence: values[3] as number, type: values[4] as string, payload: values[5] as Record<string, unknown> });
      return Promise.resolve([{
        cursor: stored.length, botId: "bot-1", turnId: "run-1", sessionKey: "session-1",
        leaseGeneration: 1, occurredAt: new Date(),
      }]);
    }
    if (query.includes("select id from runs") || query.startsWith("update runs")) return Promise.resolve([{ id: "run-1" }]);
    return Promise.resolve([]);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) }) as unknown as Bun.SQL;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 204 }) });
  const config = {
    workerId: "worker-1", apiInternalUrl: server.url.origin, webAppUrl: "https://console.test",
    internalSecrets: testInternalSecrets("worker", "test-token"),
  } as WorkerConfig;
  const context = {
    id: "run-1", organizationId: "org-1", threadId: "thread-1", botId: "bot-1", runtimeId: "rt-1",
    sessionId: "session-1", hermesRunId: options.resumed ? "remote-1" : null,
    remoteStopState: null, externalState: "streaming", leaseGeneration: 1,
    lastHermesSequence: options.watermark ?? 0, provider: "primary", model: "model-a",
    hermesProfile: null, workflowId: null, groupId: null, originRunId: null,
    runtimeSelectedProvider: null, runtimeSelectedModel: null,
  } as RunContext;
  const state = createRunState(context);
  state.hermesRunId = "remote-1";
  // Supply these even on resume, so safety does not depend on today's null createArgs shortcut.
  state.createArgs = { input: "write once", history: [], instructions: "", images: [] };
  state.selection = { provider: "primary", model: "model-a", reasoningEffort: null };
  const creates: unknown[] = [];
  const streams: string[] = [];
  const client = {
    async modelOptions() { return catalog; },
    async createRun(args: unknown) { creates.push(args); return "remote-2"; },
    async *events(id: string) {
      streams.push(id);
      for (const raw of id === "remote-1" ? frames : [frame("run.failed", { message: "unrecoverable error", sequence: 1 })]) yield raw;
    },
  } as unknown as HermesClient;
  try {
    await streamHermesEvents(db, config, context, client, state, new RunTrace(), "remote-1",
      Promise.resolve(options.replay ?? false), async () => {});
    return { creates, streams, stored, state };
  } finally {
    server.stop(true);
  }
}

describe("provider fallback does not repeat tool effects", () => {
  for (const terminal of ["run.failed", "run.error"]) {
    test(`tool started then ${terminal} quota keeps the original remote run`, async () => {
      const result = await follow([frame("run.started"), frame("tool.started", { tool: "write_file" }), quota(terminal)]);
      expect(result.creates).toHaveLength(0);
      expect(result.streams).toEqual(["remote-1"]);
      expect(result.stored.map((row) => row.type)).toContain("run.error");
      expect(result.stored.map((row) => row.type)).not.toContain("run.provider_fallback");
    });
  }

  test("quota before any tool still creates and streams one fallback", async () => {
    const result = await follow([frame("run.started"), quota()]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({ provider: "backup", input: "write once" });
    expect(result.streams).toEqual(["remote-1", "remote-2"]);
    expect(result.stored.filter((row) => row.type === "run.provider_fallback")).toHaveLength(1);
  });

  test("a completed tool without its start is sufficient to block fallback", async () => {
    const result = await follow([frame("run.started"), frame("tool.completed", { tool: "write_file", result: "done" }), quota()]);
    expect(result.creates).toHaveLength(0);
  });

  test("durable tool events block fallback even when the current stream contains only quota", async () => {
    const result = await follow([frame("run.started"), quota()], { priorTools: true });
    expect(result.creates).toHaveLength(0);
    expect(result.state.providerFallbackUnsafe).toBe(true);
  });

  test("resuming a remote run blocks fallback even without a persisted tool", async () => {
    const result = await follow([{ ...quota(), sequence: 4 }], { resumed: true, replay: true, watermark: 3 });
    expect(result.creates).toHaveLength(0);
    expect(result.stored.map((row) => row.type)).toContain("run.error");
  });

  test("a skipped tool frame still blocks replaying the original request", async () => {
    const result = await follow([frame("tool.started", { tool: "write_file", sequence: 1 }), { ...quota(), sequence: 2 }], { watermark: 1 });
    expect(result.creates).toHaveLength(0);
  });

  test("a sequence gap without replay support cannot prove no tools acted", async () => {
    const result = await follow([frame("run.started", { sequence: 1 }), { ...quota(), sequence: 3 }]);
    expect(result.creates).toHaveLength(0);
  });

  test("an unnumbered stream attached without its start cannot prove no tools acted", async () => {
    const result = await follow([quota()]);
    expect(result.creates).toHaveLength(0);
  });

  test("a contiguous replay journal before tools retains fallback", async () => {
    const result = await follow([{ ...quota(), sequence: 1 }], { replay: true });
    expect(result.creates).toHaveLength(1);
  });
});
