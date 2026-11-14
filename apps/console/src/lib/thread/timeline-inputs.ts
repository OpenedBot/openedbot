import { useMemo } from "react";
import type { ApprovalRequestDto, RunDto } from "@openedbot/contracts-api";
import { liveApprovals } from "../run/live-approvals";

/*
  Inputs of `ThreadTimeline` derived from the thread snapshot, kept stable:
  the timeline is under `memo`, so a new array on every render would make it
  re-render on every composer keystroke.
*/

type RoutineRun = Pick<RunDto, "id" | "routineId">;

/**
 * The messages the thread shows. A routine's prompt is the bot's own trigger,
 * not something the user wrote: the timeline shows a routine stamp instead
 * (`RoutineStamp`), so the user message of a routine run is left out. Keyed on
 * the routine runs' ids, not on `runs`, which changes with every run update.
 */
export function useTimelineMessages<M extends { role: string; runId?: string | null }>(
  messages: M[] | undefined,
  runs: readonly RoutineRun[] | undefined,
): M[] {
  const routineRunKey = (runs ?? []).filter((run) => run.routineId).map((run) => run.id).join(",");
  return useMemo(() => {
    const all = messages ?? [];
    if (!routineRunKey) return all;
    const routineRuns = new Set(routineRunKey.split(","));
    return all.filter((message) => message.role !== "user" || !message.runId || !routineRuns.has(message.runId));
  }, [messages, routineRunKey]);
}

/**
 * Only gates still awaiting a human on a live run: a stale `pending` row of a
 * concluded run must neither render a card nor hide the composer.
 */
export function useLiveApprovals(
  approvals: ApprovalRequestDto[] | undefined,
  runs: readonly Pick<RunDto, "id" | "status">[] | undefined,
): ApprovalRequestDto[] {
  return useMemo(() => liveApprovals(approvals ?? [], runs ?? []), [approvals, runs]);
}
