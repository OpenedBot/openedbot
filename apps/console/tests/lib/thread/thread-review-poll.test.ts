import { describe, expect, test } from "bun:test";
import { nextReviewWatch, REVIEW_POLL_WINDOW_MS, reviewHeldRunIds } from "../../../src/lib/thread/thread-review-poll";

const held = {
  runs: [{ id: "run-b", status: "awaiting_approval" }, { id: "run-a", status: "running" }],
  approvals: [],
};

describe("thread re-read while a gate is under automatic review (PERM2-7)", () => {
  test("a run awaiting approval with no card is held; one with a card is not", () => {
    expect(reviewHeldRunIds(held)).toEqual(["run-b"]);
    expect(reviewHeldRunIds({
      runs: [{ id: "run-b", status: "awaiting_approval" }],
      approvals: [{ runId: "run-b", status: "pending" }],
    })).toEqual([]);
    expect(reviewHeldRunIds({ runs: [{ id: "run-b", status: "running" }], approvals: [] })).toEqual([]);
    expect(reviewHeldRunIds(undefined)).toEqual([]);
  });

  test("polls from the first observation, stops when the condition ends", () => {
    const first = nextReviewWatch(null, held, 1_000);
    expect(first).toEqual({ next: { key: "run-b", since: 1_000 }, poll: true });
    const again = nextReviewWatch(first.next, held, 5_000);
    expect(again.poll).toBe(true);
    expect(again.next?.since).toBe(1_000);
    const settled = nextReviewWatch(again.next, {
      runs: [{ id: "run-b", status: "awaiting_approval" }],
      approvals: [{ runId: "run-b", status: "pending" }],
    }, 7_000);
    expect(settled).toEqual({ next: null, poll: false });
  });

  test("gives up after the window on the same runs, restarts for a new gate", () => {
    const first = nextReviewWatch(null, held, 0);
    const late = nextReviewWatch(first.next, held, REVIEW_POLL_WINDOW_MS);
    expect(late.poll).toBe(false);
    const other = nextReviewWatch(late.next, {
      runs: [{ id: "run-c", status: "awaiting_approval" }],
      approvals: [],
    }, REVIEW_POLL_WINDOW_MS + 1);
    expect(other).toEqual({ next: { key: "run-c", since: REVIEW_POLL_WINDOW_MS + 1 }, poll: true });
  });
});
