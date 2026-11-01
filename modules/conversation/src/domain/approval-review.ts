import type { ApprovalReviewDto, ApprovalReviewReason } from "@openedbot/contracts-api";

/** The reviewer's verdict reason is bounded by the worker; the API bounds it again. */
export const REVIEW_NOTE_MAX_CHARS = 300;

const REVIEW_REASONS: ReadonlySet<string> = new Set<ApprovalReviewReason>([
  "review_escalated",
  "review_timeout",
  "review_circuit_open",
  "review_runtime_busy",
]);

/**
 * PERM2-7: what the card says about the automatic review, read from
 * `decision_detail.reason` and `decision_detail.reviewerReason`. Only a
 * `review_*` reason means a review took part; any other value (a floor, a
 * legacy revert) is not the review's business and yields `null`. An unknown
 * `review_*` code is still a hand-off to the human, so it reads as
 * `review_escalated` rather than leaking an unlisted code to the client.
 */
export function approvalReview(reason: string | null | undefined, reviewerReason: string | null | undefined): ApprovalReviewDto | null {
  if (typeof reason !== "string" || !reason.startsWith("review_")) return null;
  const code = (REVIEW_REASONS.has(reason) ? reason : "review_escalated") as ApprovalReviewReason;
  return { reason: code, note: reviewNote(reviewerReason) };
}

/** Plain text on one line: control characters become spaces, then trimmed and capped. */
function reviewNote(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > REVIEW_NOTE_MAX_CHARS ? chars.slice(0, REVIEW_NOTE_MAX_CHARS).join("") : flat;
}
