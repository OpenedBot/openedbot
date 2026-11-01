import { useRef } from "react";

/**
 * The run that had already failed when this thread was first read fresh, or
 * `null`. Its failure is told by its notice in the thread; the blocking modal
 * is for a failure seen happening. Reopening a thread whose last turn failed
 * hours ago must not lock it behind that old sentence (lab, 2026-10-24: an
 * old PERMISSION_POLICY_NOT_EFFECTIVE made a repaired bot look still broken).
 *
 * `ready` is false while the snapshot is missing or restored from the local
 * cache: only a fresh read sets the baseline, once per thread.
 */
export function useRunFailureAtOpen(
  threadId: string | null | undefined,
  ready: boolean,
  run: { id: string; status: string } | undefined,
): string | null {
  const opened = useRef<{ threadId: string; failedRunId: string | null } | null>(null);
  if (threadId && ready && opened.current?.threadId !== threadId) {
    opened.current = { threadId, failedRunId: run?.status === "failed" ? run.id : null };
  }
  return threadId && opened.current?.threadId === threadId ? opened.current.failedRunId : null;
}
