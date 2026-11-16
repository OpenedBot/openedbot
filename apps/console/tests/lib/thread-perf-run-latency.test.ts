import { describe, expect, test } from "bun:test";
import {
  applyRunEventReceipt,
  emptyRunLatency,
  linkAcceptedRun,
  recordPaintedRunText,
  intersectPaintBounds,
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
      firstPaintedTextMs: null,
      answerPaintedMs: null,
      completedMs: null,
    });
    expect(linkAcceptedRun(samples, "run-1", 1_200, undefined)).toBeNull();
  });

  test("un 202 sans envoi récent en attente n'est pas l'échantillon de la sonde", () => {
    expect(linkAcceptedRun([sample("stale", 0)], "run-2", 10_001, undefined)).toBeNull();
    expect(linkAcceptedRun([], "run-2", 5, undefined)).toBeNull();
  });

  test("des 202 intercalés se lient à leur soumission, jamais au dernier fil ouvert", () => {
    const first = { ...sample("first", 1_000), submissionId: "key-first" };
    const second = { ...sample("second", 1_050), submissionId: "key-second" };
    const samples = [first, second];
    expect(linkAcceptedRun(samples, "unrelated", 1_100, undefined, "unknown-key")).toBeNull();
    expect(linkAcceptedRun(samples, "ambiguous", 1_100, undefined)).toBeNull();
    expect(linkAcceptedRun(samples, "run-first", 1_120, undefined, "key-first")?.id).toBe("first");
    expect(linkAcceptedRun(samples, "run-second", 1_130, undefined, "key-second")?.id).toBe("second");
    expect(first.run.acceptedMs).toBe(120);
    expect(second.run.acceptedMs).toBe(80);
  });

  test("une clé exacte lie aussi un 202 tardif, en comptant l'attente depuis la demande originale", () => {
    const original = { ...sample("original", 1_000), submissionId: "same-key" };
    const retry = sample("retry", 12_000);
    expect(linkAcceptedRun([original, retry], "run", 12_100, { firstEventAt: 12_020, firstTextAt: 12_050, completedAt: 12_080 }, "same-key")?.id).toBe("original");
    expect(original.run).toMatchObject({ acceptedMs: 11_100, firstTextMs: 11_050, completedMs: 11_080 });
    expect(retry.run.runId).toBeNull();
  });

  test("un texte reçu ou un terminal ne prouve pas un affichage ; le feed et la bulle se mesurent séparément", () => {
    const run = emptyRunLatency();
    expect(recordPaintedRunText(run, "activity", 100)).toBe(false);
    run.firstTextMs = 800;
    expect(recordPaintedRunText(run, "activity", 799)).toBe(false);
    expect(recordPaintedRunText(run, "activity", Number.NaN)).toBe(false);
    expect(recordPaintedRunText(run, "activity", 850)).toBe(true);
    expect(recordPaintedRunText(run, "activity", 900)).toBe(false);
    run.completedMs = 1_100;
    expect(run.answerPaintedMs).toBeNull();
    expect(recordPaintedRunText(run, "answer", 1_130)).toBe(true);
    expect(run.firstPaintedTextMs).toBe(850);
    expect(run.answerPaintedMs).toBe(1_130);
    expect(recordPaintedRunText(run, "answer", 1_200)).toBe(false);
  });

  test("une réponse directement rendue en bulle fournit aussi le premier paint", () => {
    const run = { ...emptyRunLatency(), firstTextMs: 700 };
    expect(recordPaintedRunText(run, "answer", 740)).toBe(true);
    expect(run.firstPaintedTextMs).toBe(740);
    expect(run.answerPaintedMs).toBe(740);
  });

  test("un texte dans la fenêtre mais sous le scrollport ne compte pas comme peint", () => {
    const text = { top: 750, bottom: 780, left: 100, right: 400 };
    expect(intersectPaintBounds(text, { top: 0, bottom: 900, left: 0, right: 1000 })).toEqual(text);
    expect(intersectPaintBounds(text, { top: 100, bottom: 700 })).toBeNull();
    expect(intersectPaintBounds(text, { top: 100, bottom: 760 })).toEqual({ ...text, bottom: 760 });
    expect(intersectPaintBounds(text, { left: 500, right: 900 })).toBeNull();
  });
});
