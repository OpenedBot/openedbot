import { describe, expect, test } from "bun:test";
import {
  applyRunEventReceipt,
  emptyRunLatency,
  linkAcceptedRun,
  type RunEventReceipts,
  type SendSample,
} from "../../src/lib/dev/thread-perf-probe";

function sample(id: string, triggeredAt: number): SendSample {
  return {
    id,
    triggeredAt,
    composerEmptiedMs: null,
    bubblePaintedMs: null,
    latencyMs: null,
    pass: null,
    longFrames: [],
    worstLongFrameMs: 0,
    longFramesPass: true,
    renders: [],
    run: emptyRunLatency(),
  };
}

function receipts(): RunEventReceipts {
  return { firstEventAt: null, firstTextAt: null, completedAt: null };
}

describe("latence d'un run vue du PWA", () => {
  test("distingue premier événement, premier texte et réponse complète", () => {
    const seen = receipts();
    expect(applyRunEventReceipt(seen, "tool.call", 1_200)).toBe(true);
    expect(applyRunEventReceipt(seen, "tool.result", 1_300)).toBe(false);
    expect(applyRunEventReceipt(seen, "agent.message", 1_800)).toBe(true);
    expect(applyRunEventReceipt(seen, "agent.message", 1_900)).toBe(false);
    expect(applyRunEventReceipt(seen, "run.completed", 2_400)).toBe(true);
    expect(seen).toEqual({ firstEventAt: 1_200, firstTextAt: 1_800, completedAt: 2_400 });
  });

  test("le 202 se lie au dernier envoi non lié, avec les événements arrivés avant lui", () => {
    const samples = [sample("old", 0), sample("send", 1_000)];
    samples[0]!.run.runId = "run-old";
    const early = receipts();
    applyRunEventReceipt(early, "agent.message", 1_150);

    const linked = linkAcceptedRun(samples, "run-1", 1_120, early);
    expect(linked?.id).toBe("send");
    expect(linked?.run).toEqual({
      runId: "run-1",
      acceptedMs: 120,
      firstEventMs: 150,
      firstTextMs: 150,
      completedMs: null,
    });
    expect(linkAcceptedRun(samples, "run-1", 1_200, undefined)).toBeNull();
  });

  test("un 202 sans envoi récent en attente n'est pas l'échantillon de la sonde", () => {
    expect(linkAcceptedRun([sample("stale", 0)], "run-2", 10_001, undefined)).toBeNull();
    expect(linkAcceptedRun([], "run-2", 5, undefined)).toBeNull();
  });
});
