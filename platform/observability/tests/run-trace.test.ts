import { describe, expect, test } from "bun:test";
import {
  endRunTrace,
  RunTrace,
  runLatencyRecord,
  runLatencyVerdicts,
  runTrace,
  startRunTrace,
  type RunTraceClock,
} from "../src/run-trace";

function fakeClock(start = 1_000): RunTraceClock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    epoch: () => 1_760_000_000_000 + now,
    advance: (ms) => { now += ms; },
  };
}

describe("RunTrace", () => {
  test("des marques monotones depuis l'origine, la première gagne", () => {
    const clock = fakeClock();
    const trace = new RunTrace(clock);
    clock.advance(12.34);
    trace.mark("worker.claimed");
    clock.advance(5);
    trace.mark("worker.claimed");
    expect(trace.summary().marks).toEqual({ "worker.claimed": 12.3 });
    expect(trace.offset("worker.claimed")).toBe(12.3);
    expect(trace.has("hermes.first_event")).toBe(false);
  });

  test("une origine antérieure date l'ouverture de la trace", () => {
    const clock = fakeClock(1_000);
    clock.advance(40);
    const trace = new RunTrace(clock, 1_000);
    trace.mark("worker.claimed");
    expect(trace.summary().marks["worker.claimed"]).toBe(40);
    expect(trace.summary().startedAt).toBe(new Date(1_760_000_001_000).toISOString());
  });

  test("span mesure l'étape et pose sa marque de fin, même sur échec", async () => {
    const clock = fakeClock();
    const trace = new RunTrace(clock);
    clock.advance(3);
    expect(await trace.span("preflight.toolsets", () => { clock.advance(20); return 7; })).toBe(7);
    await expect(trace.span("preflight.ensure_session", async () => {
      clock.advance(8);
      throw new Error("down");
    })).rejects.toThrow("down");
    const summary = trace.summary();
    expect(summary.spans).toEqual({ "preflight.toolsets": 20, "preflight.ensure_session": 8 });
    expect(summary.marks).toEqual({ "preflight.toolsets": 23, "preflight.ensure_session": 31 });
  });

  test("aucun contenu ne passe : noms et valeurs hors motif sont ignorés", () => {
    const trace = new RunTrace(fakeClock());
    trace.mark("Bonjour, mon mot de passe est hunter2");
    trace.mark("x".repeat(65));
    trace.set("outcome", "completed");
    trace.set("input", "écris un poème sur Stockholm");
    trace.set("resumed", false);
    trace.set("queued_ms", Number.NaN);
    const summary = trace.summary();
    expect(summary.marks).toEqual({});
    expect(summary.attributes).toEqual({ outcome: "completed", resumed: false });
    expect(JSON.stringify(summary)).not.toContain("hunter2");
    expect(JSON.stringify(summary)).not.toContain("Stockholm");
  });
});

describe("registre des traces", () => {
  test("la trace passe de la réclamation à l'exécution par l'identifiant du run", () => {
    const started = startRunTrace("run-a");
    expect(runTrace("run-a")).toBe(started);
    expect(endRunTrace("run-a")).toBe(started);
    expect(runTrace("run-a")).toBeUndefined();
    expect(endRunTrace("run-a")).toBeUndefined();
  });

  test("une trace jamais close est évincée par ancienneté", () => {
    startRunTrace("run-oldest");
    for (let index = 0; index < 1_024; index += 1) startRunTrace(`run-${index}`);
    expect(runTrace("run-oldest")).toBeUndefined();
    expect(runTrace("run-1023")).toBeDefined();
    for (let index = 0; index < 1_024; index += 1) endRunTrace(`run-${index}`);
  });
});

describe("seuils de latence", () => {
  test("trois seuils distincts, une étape non mesurée reste absente", () => {
    expect(runLatencyVerdicts({ admission: 120, firstRuntimeEvent: null, firstVisibleText: 4_200 })).toEqual({
      admission: { ms: 120, budgetMs: 250, pass: true },
      firstVisibleText: { ms: 4_200, budgetMs: 4_000, pass: false },
    });
  });

  test("run.latency compte les seuils runtime depuis la création du run", () => {
    const clock = fakeClock();
    const trace = new RunTrace(clock);
    clock.advance(30);
    trace.mark("worker.claimed");
    clock.advance(900);
    trace.mark("hermes.first_event");
    clock.advance(400);
    trace.mark("openedbot.first_text_published");
    const record = runLatencyRecord({ runId: "run-1", organizationId: "org-1", queuedMs: 70, trace });
    expect(record).toMatchObject({
      runId: "run-1",
      queuedMs: 70,
      marks: { "worker.claimed": 30, "hermes.first_event": 930, "openedbot.first_text_published": 1_330 },
      verdicts: {
        firstRuntimeEvent: { ms: 1_000, pass: true },
        firstVisibleText: { ms: 1_400, pass: true },
      },
    });
    expect(runLatencyRecord({ runId: "run-1", organizationId: "org-1", queuedMs: null, trace }).verdicts).toEqual({});
  });
});
