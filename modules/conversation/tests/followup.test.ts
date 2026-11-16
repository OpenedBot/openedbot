import { describe, expect, test } from "bun:test";
import { appendFollowupInput, isAbsorbedRun, mergeFollowupInputs, SUPERSEDED_NOTICE_KIND } from "../src/domain/followup";
import { statusFromEvent } from "../src/domain/thread-snapshot-mutations";
import { runToolTerminalStates } from "../src/domain/thread-tools";

describe("rafale de messages", () => {
  test("a burst merges into one numbered string the model answers as a whole", () => {
    expect(mergeFollowupInputs(["et au havre ?", "  ", "\ntest\n"])).toBe(
      "[2 messages sent in a row by the user — answer all of them together]\n1. et au havre ?\n2. test",
    );
    expect(mergeFollowupInputs(["a", "b\nsuite", "c"])).toBe(
      "[3 messages sent in a row by the user — answer all of them together]\n1. a\n2. b\nsuite\n3. c",
    );
  });

  test("a single message stays verbatim, with no header", () => {
    expect(mergeFollowupInputs(["  capitale du Japon ?\n"])).toBe("capitale du Japon ?");
    expect(mergeFollowupInputs(["", "capitale du Japon ?"])).toBe("capitale du Japon ?");
    expect(mergeFollowupInputs([])).toBe("");
  });

  test("a fold renumbers an already merged burst instead of nesting it", () => {
    const two = appendFollowupInput("et au havre ?", "test");
    expect(two).toBe(mergeFollowupInputs(["et au havre ?", "test"]));
    expect(appendFollowupInput(two, " et à Rouen ? ")).toBe(mergeFollowupInputs(["et au havre ?", "test", "et à Rouen ?"]));
    expect(appendFollowupInput(two, "  ")).toBe(two);
    expect(appendFollowupInput("", "test")).toBe("test");
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
