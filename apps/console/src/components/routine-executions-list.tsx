import { useId, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { RoutineDto, RoutineExecutionOutcome } from "@openedbot/contracts-api";
import { Badge, Skeleton } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

const OUTCOME_TONE: Record<RoutineExecutionOutcome, string> = {
  fired: "border-pos-100 bg-pos-soft text-pos-700",
  catch_up: "border-info-100 bg-info-soft text-info-700",
  deferred: "border-warn-100 bg-warn-soft text-warn-700",
  abandoned: "border-neg-100 bg-neg-soft text-neg-700",
  group_empty: "border-neg-100 bg-neg-soft text-neg-700",
};

export type RoutineExecutionsListProps = {
  routine: Pick<RoutineDto, "id" | "name"> | null;
  enabled?: boolean;
};

/**
 * Historique paginé d'un tick de routine : tirs, rattrapages, reports et
 * abandons. Autonome : une panne de lecture ne bloque pas le CRUD.
 */
export function RoutineExecutionsList({ routine, enabled = true }: RoutineExecutionsListProps) {
  const { t, formatDate } = useT();
  const titleId = useId();
  const routineId = routine?.id ?? "";
  const executions = useInfiniteQuery({
    queryKey: queryKeys.routineExecutions(routineId),
    queryFn: ({ pageParam }) => api.routineExecutions(routineId, { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: enabled && Boolean(routineId),
  });
  const rows = useMemo(
    () => executions.data?.pages.flatMap((page) => page.executions) ?? [],
    [executions.data],
  );
  if (!enabled) return null;

  const outcomeLabel = (outcome: RoutineExecutionOutcome) =>
    outcome === "fired" ? t("botRoutinesDialog.executions.outcomeFired")
    : outcome === "catch_up" ? t("botRoutinesDialog.executions.outcomeCatchUp")
    : outcome === "deferred" ? t("botRoutinesDialog.executions.outcomeDeferred")
    : outcome === "abandoned" ? t("botRoutinesDialog.executions.outcomeAbandoned")
    : t("botRoutinesDialog.executions.outcomeGroupEmpty");

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <h3 id={titleId} className="text-sm font-medium">{t("botRoutinesDialog.executions.title")}</h3>
      {!routineId ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
          {t("botRoutinesDialog.executions.empty")}
        </p>
      ) : executions.isPending ? (
        <div role="status" aria-label={t("botRoutinesDialog.executions.loading")} aria-busy="true" className="space-y-2">
          <Skeleton className="h-16 w-full motion-reduce:animate-none" />
          <Skeleton className="h-16 w-full motion-reduce:animate-none" />
        </div>
      ) : executions.isError && rows.length === 0 ? (
        <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive-text">
          <p>{executions.error instanceof ApiError ? executions.error.message : t("botRoutinesDialog.executions.failed")}</p>
          <button type="button" onClick={() => void executions.refetch()} className={`${BUTTON.small} mt-2`}>
            {t("botRoutinesDialog.retry")}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
          {t("botRoutinesDialog.executions.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              data-execution={row.id}
              className="rounded-xl border border-border bg-card p-3 shadow-sm"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{routine?.name ?? row.routineId}</span>
                <Badge variant="outline" className={OUTCOME_TONE[row.outcome]}>
                  {outcomeLabel(row.outcome)}
                </Badge>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <time dateTime={row.createdAt}>{formatDate(row.createdAt)}</time>
                <span>{t(row.trigger === "manual"
                  ? "botRoutinesDialog.receipts.triggerManual"
                  : "botRoutinesDialog.receipts.triggerScheduled")}</span>
                {row.missedCount > 0 ? (
                  <span>{t("botRoutinesDialog.missedCount_other", { count: row.missedCount })}</span>
                ) : null}
              </div>
              {row.errorCode || row.errorMessage ? (
                <p className="mt-1 text-xs text-destructive-text">
                  {row.errorCode ? `${row.errorCode}: ` : ""}{row.errorMessage}
                </p>
              ) : null}
            </li>
          ))}
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
