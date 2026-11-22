import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api";

/**
 * The run that had already failed when this thread was first read fresh, or
 * `null`. Its failure is told by its notice in the thread and says nothing
 * new about the bot: only a failure seen happening does (lab, 2026-10-24: an
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

/**
 * A run that fails during this visit may come from a profile gone from the
 * runtime: reread the bot's profile status once per run so the repair notice
 * can follow. The failure itself is told by its turn in the thread
 * (`RunFailureNotice`): a blocking modal would hide it while the next send may
 * succeed.
 */
export function useProfileRereadOnRunFailure(
  threadId: string | null | undefined,
  ready: boolean,
  run: { id: string; status: string } | undefined,
  botId: string | undefined,
): void {
  const queryClient = useQueryClient();
  const notified = useRef<string | null>(null);
  const failedAtOpen = useRunFailureAtOpen(threadId, ready, run);
  useEffect(() => {
    if (run?.status !== "failed" || run.id === notified.current || run.id === failedAtOpen) return;
    notified.current = run.id;
    if (botId) void queryClient.invalidateQueries({ queryKey: queryKeys.botProfileStatus(botId) });
  }, [run?.id, run?.status, failedAtOpen, botId, queryClient]);
}
