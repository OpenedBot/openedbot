import { describe, expect, test } from "bun:test";
import { isAbsorbedRun, mergeFollowupInputs, SUPERSEDED_NOTICE_KIND } from "../src/domain/followup";
import { statusFromEvent } from "../src/domain/thread-snapshot-mutations";
import { runToolTerminalStates } from "../src/domain/thread-tools";

describe("rafale de messages", () => {
  test("les messages fusionnent en une seule chaîne, une ligne vide entre deux", () => {
    expect(mergeFollowupInputs(["capitale du Japon ?", "  ", "\ncapitale du Mexique ?\n"]))
      .toBe("capitale du Japon ?\n\ncapitale du Mexique ?");
    expect(mergeFollowupInputs([])).toBe("");
  });

  test("un run absorbé est un run annulé sans réponse propre", () => {
    expect(isAbsorbedRun({ status: "cancelled", completionKind: "steered_into_active" })).toBe(true);
    expect(isAbsorbedRun({ status: "cancelled", completionKind: "folded_into_followup" })).toBe(true);
    expect(isAbsorbedRun({ status: "cancelled", completionKind: "superseded_by_followup" })).toBe(false);
    expect(isAbsorbedRun({ status: "queued", completionKind: null })).toBe(false);
  });

  test("le repère « remplacé » clôt le run comme une annulation, jamais comme une erreur", () => {
    const event = { type: "system.notice", payload: { kind: SUPERSEDED_NOTICE_KIND, message: "x" } } as const;
    expect(statusFromEvent(event)).toBe("cancelled");
    const states = runToolTerminalStates([{
      cursor: 1, sequence: 1, runId: "old", type: "system.notice",
      payload: { kind: SUPERSEDED_NOTICE_KIND }, occurredAt: new Date(0),
    }]);
    expect(states.get("old")).toBe("interrupted");
  });
});
