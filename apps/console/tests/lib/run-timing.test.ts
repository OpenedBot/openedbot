import { expect, test } from "bun:test";
import { formatSeconds, runTimings } from "../../src/lib/run-timing";

const run = (id: string, createdAt: string, endedAt: string | null, outputTokens = 0) => ({
  id,
  createdAt,
  endedAt,
  usage: outputTokens ? { outputTokens } : null,
});
const text = (runId: string, occurredAt: string) => ({ runId, type: "agent.message", occurredAt });

test("premier jeton, total, vitesse et morceaux d'un run terminé", () => {
  const timings = runTimings(
    [run("r1", "2026-10-12T21:20:20.000Z", "2026-10-12T21:20:23.500Z", 85)],
    [
      { runId: "r1", type: "message.admitted", occurredAt: "2026-10-12T21:20:20.040Z" },
      text("r1", "2026-10-12T21:20:23.000Z"),
      text("r1", "2026-10-12T21:20:22.900Z"),
    ],
  );
  const timing = timings.get("r1")!;
  expect(timing.firstTokenMs).toBe(2_900);
  expect(timing.totalMs).toBe(3_500);
  expect(timing.chunks).toBe(2);
  // 85 jetons (raisonnement compris) sur les 3,5 s du run.
  expect(timing.tokensPerSecond).toBeCloseTo(24.29, 1);
});

test("un run en cours n'a pas de durée, un run sans texte ni jetons garde ses champs vides", () => {
  const timings = runTimings(
    [run("live", "2026-10-12T21:00:00.000Z", null), run("tools", "2026-10-12T21:00:00.000Z", "2026-10-12T21:00:02.000Z")],
    [],
  );
  expect(timings.has("live")).toBe(false);
  expect(timings.get("tools")).toEqual({ firstTokenMs: null, totalMs: 2_000, tokensPerSecond: null, chunks: 0 });
});

test("la forme courte garde deux décimales", () => {
  expect(formatSeconds(4_030)).toBe("4.03s");
  expect(formatSeconds(0)).toBe("0.00s");
});
