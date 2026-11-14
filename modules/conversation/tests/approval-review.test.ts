import { describe, expect, test } from "bun:test";
import { approvalReview, REVIEW_NOTE_MAX_CHARS } from "../src/domain/approval-review";

describe("approvalReview (PERM2-7)", () => {
  test("no review reason, no review", () => {
    expect(approvalReview(null, null)).toBeNull();
    expect(approvalReview(undefined, "ignored")).toBeNull();
    // A floor or a legacy revert is not the review's business.
    expect(approvalReview("floor_sensitive_path", "ignored")).toBeNull();
    expect(approvalReview("reviewing", "ignored")).toBeNull();
  });

  test("known reasons pass through with the reviewer's note", () => {
    expect(approvalReview("review_escalated", "Le fil ne parle pas de ce dossier.")).toEqual({
      reason: "review_escalated",
      note: "Le fil ne parle pas de ce dossier.",
    });
    expect(approvalReview("review_timeout", null)).toEqual({ reason: "review_timeout", note: null });
    expect(approvalReview("review_circuit_open", "")).toEqual({ reason: "review_circuit_open", note: null });
    expect(approvalReview("review_runtime_busy", null)).toEqual({ reason: "review_runtime_busy", note: null });
  });

  test("an unlisted review code still reads as a hand-off, never as itself", () => {
    expect(approvalReview("review_invalid_output", null)).toEqual({ reason: "review_escalated", note: null });
  });

  test("the note is one line of plain text, bounded", () => {
    expect(approvalReview("review_escalated", "  ligne 1\n\tligne\u0000 2  ")?.note).toBe("ligne 1 ligne 2");
    expect(approvalReview("review_escalated", " \n ")?.note).toBeNull();
    const long = "é".repeat(REVIEW_NOTE_MAX_CHARS + 50);
    expect(Array.from(approvalReview("review_escalated", long)?.note ?? "")).toHaveLength(REVIEW_NOTE_MAX_CHARS);
  });
});
