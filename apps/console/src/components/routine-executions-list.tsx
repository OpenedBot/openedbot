import { useId, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { RoutineDto, RoutineExecutionOutcome } from "@openedbot/contracts-api";
import { oneShotTime } from "@openedbot/execution/domain/routines";
import { Skeleton } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  executionReason,
  groupExecutions,
  isLiveRunStatus,
  runStatusTone,
  type ExecutionEntry,
  type StatusTone,
} from "../lib/routines/executions";
import { BUTTON, ToneBadge } from "./settings/primitives";

/**
 * The tick's outcome says whether the occurrence was fired, never how its
 * run ended: « fired » stays neutral, and the run's own status carries the
 * colour (a failed run is never green).
 */
const OUTCOME_TONE: Record<RoutineExecutionOutcome, StatusTone> = {
  fired: "neutral",
  catch_up: "info",
  deferred: "warning",
  abandoned: "danger",
  group_empty: "danger",
};

const OUTCOME_LABEL = {
  fired: "botRoutinesDialog.executions.outcomeFired",
  catch_up: "botRoutinesDialog.executions.outcomeCatchUp",
  deferred: "botRoutinesDialog.executions.outcomeDeferred",
  abandoned: "botRoutinesDialog.executions.outcomeAbandoned",
  group_empty: "botRoutinesDialog.executions.outcomeGroupEmpty",
} as const satisfies Record<RoutineExecutionOutcome, string>;

const RUN_STATUS_LABEL = {
  queued: "workflowOverview.status.queued",
  running: "workflowOverview.status.running",
  awaiting_approval: "workflowOverview.status.awaitingApproval",
  reconciling: "workflowOverview.status.reconciling",
  completed: "workflowOverview.status.completed",
  failed: "workflowOverview.status.failed",
  cancelled: "workflowOverview.status.cancelled",
  expired: "workflowOverview.status.expired",
  unknown: "workflowOverview.status.unknown",
} as const;

/** Refetch while the dialog is open: quickly while a run moves, slowly otherwise (ticks, deferrals). */
export const EXECUTIONS_LIVE_REFETCH_MS = 5_000;
export const EXECUTIONS_IDLE_REFETCH_MS = 30_000;

export type RoutineExecutionsListProps = {
  routine: Pick<RoutineDto, "id" | "name" | "schedule"> | null;
  enabled?: boolean;
};

/**
 * Paginated history of a routine tick: firings, catch-ups, postponements and
 * abandonments. Standalone: a read failure does not block the CRUD.
 */
export function RoutineExecutionsList({ routine, enabled = true }: RoutineExecutionsListProps) {
  const { t } = useT();
  const titleId = useId();
  const routineId = routine?.id ?? "";
  const executions = useInfiniteQuery({
    queryKey: queryKeys.routineExecutions(routineId),
    queryFn: ({ pageParam }) => api.routineExecutions(routineId, { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: enabled && Boolean(routineId),
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.executions.some((row) => isLiveRunStatus(row.workflowStatus)))
        ? EXECUTIONS_LIVE_REFETCH_MS
        : EXECUTIONS_IDLE_REFETCH_MS,
  });
  const entries = useMemo(
    () => groupExecutions(executions.data?.pages.flatMap((page) => page.executions) ?? []),
    [executions.data],
  );
  if (!enabled) return null;
  const oneShot = routine ? oneShotTime(routine.schedule) !== null : false;

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="space-y-1">
        <h3 id={titleId} className="text-sm font-semibold">{t("botRoutinesDialog.executions.title")}</h3>
        {routine ? <p className="text-xs leading-5 text-muted-foreground wrap-anywhere">{routine.name}</p> : null}
      </div>
      {!routineId ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
          {t("botRoutinesDialog.executions.empty")}
        </p>
      ) : executions.isPending ? (
        <div role="status" aria-label={t("botRoutinesDialog.executions.loading")} aria-busy="true" className="space-y-2">
          <Skeleton className="h-16 w-full motion-reduce:animate-none" />
          <Skeleton className="h-16 w-full motion-reduce:animate-none" />
        </div>
      ) : executions.isError && entries.length === 0 ? (
        <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive-text">
          <p>{executions.error instanceof ApiError ? executions.error.message : t("botRoutinesDialog.executions.failed")}</p>
          <button type="button" onClick={() => void executions.refetch()} className={`${BUTTON.small} mt-2`}>
            {t("botRoutinesDialog.retry")}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
          {t("botRoutinesDialog.executions.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => <ExecutionItem key={entry.key} entry={entry} oneShot={oneShot} />)}
        </ul>
      )}

      {executions.hasNextPage && !executions.isFetchNextPageError ? (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={executions.isFetchingNextPage}
            onClick={() => void executions.fetchNextPage()}
            className={BUTTON.small}
          >
            {executions.isFetchingNextPage
              ? t("botRoutinesDialog.executions.loadingMore")
              : t("botRoutinesDialog.executions.loadMore")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ExecutionItem({ entry, oneShot }: { entry: ExecutionEntry; oneShot: boolean }) {
  const { t, formatDate, plural } = useT();
  const row = entry.rows[0];
  const count = entry.rows.length;
  const oldest = entry.rows[count - 1]!;
  const reason = executionReason(row, oneShot);
  return (
    <li data-execution={row.id} data-count={count} className="relative border-l border-border py-3 pl-4 first:pt-0 last:pb-0">
      <span aria-hidden className="absolute -left-[3px] top-3 size-[5px] rounded-full bg-muted-foreground/50" />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{t(row.trigger === "manual"
          ? "botRoutinesDialog.receipts.triggerManual" : "botRoutinesDialog.receipts.triggerScheduled")}</span>
        <ToneBadge tone={OUTCOME_TONE[row.outcome]} className="font-medium">
          {count > 1 ? t("botRoutinesDialog.executions.deferredTimes", { count }) : t(OUTCOME_LABEL[row.outcome])}
        </ToneBadge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <time dateTime={row.createdAt}>{formatDate(row.createdAt)}</time>
        {row.missedCount > 0 ? (
          <span>{plural(row.missedCount, {
            one: t("botRoutinesDialog.missedCount_one", { count: row.missedCount }),
            other: t("botRoutinesDialog.missedCount_other", { count: row.missedCount }),
          })}</span>
        ) : null}
        {row.workflowStatus ? (
          <span className="inline-flex items-center gap-1.5" data-run-status={row.workflowStatus}>
            {t("botRoutinesDialog.executions.runResult")}
            <ToneBadge tone={runStatusTone(row.workflowStatus)}>{t(RUN_STATUS_LABEL[row.workflowStatus])}</ToneBadge>
          </span>
        ) : null}
      </div>
      {count > 1 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("botRoutinesDialog.executions.deferredSince", { date: formatDate(oldest.createdAt) })}
        </p>
      ) : null}
      {reason ? (
        <p className={reason.error ? "mt-1 text-xs text-destructive-text" : "mt-1 text-xs text-muted-foreground"}>
          {reason.kind === "message" ? t(reason.key) : reason.text}
        </p>
      ) : null}
    </li>
  );
}
