import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, Clock3, Plus } from "lucide-react";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { ROUTINE_LIMITS } from "@openedbot/execution/domain/routines";
import {
  Card,
  CardContent,
  Dialog,
  Separator,
  Skeleton,
  cn,
} from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { browserTimeZone, type RoutineFormValues } from "../lib/routines/schedule";
import { RoutineCard } from "./routine-card";
import { RoutineExecutionsList } from "./routine-executions-list";
import { RoutineForm } from "./routine-form";
import { RoutineToolCard } from "./routine-tool-card";

/*
 * A bot's routines: Hermes Bot Mode's « Routines pane », as a dialog.
 *
 * A recurring routine is a 5-field cron evaluated in the time zone fixed at
 * its creation (the browser's): « tous les jours à 9h » means 9h for the
 * operator. The presets take a time of day; the free cron stays offered.
 */

/**
 * The silhouette of two routines while loading: same frame, same
 * switch on the left, same two lines (name + schedule on the right,
 * message): the dialog keeps its height when the list arrives.
 */
function RoutineRowsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      {[0, 1].map((index) => (
        <Card key={index} size="sm" className="gap-3 py-3 shadow-none">
          <CardContent className="flex items-start gap-3 px-3">
            <Skeleton className="mt-0.5 h-5 w-8 shrink-0 rounded-full motion-reduce:animate-none" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Skeleton className="h-4 w-28 motion-reduce:animate-none" />
                <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
              </div>
              <Skeleton className="h-3 w-3/4 motion-reduce:animate-none" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function BotRoutinesDialog({
  bot,
  group,
  open,
  onClose,
}: {
  bot?: BotDto;
  group?: GroupDto;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const targetName = bot?.name ?? group?.name ?? "";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("botRoutinesDialog.title", { name: targetName })}
      description={t(group ? "botRoutinesDialog.descriptionGroup" : "botRoutinesDialog.description")}
      closeLabel={t("common.close")}
      className="max-w-4xl"
      bodyClassName="p-0"
    >
      <BotRoutinesPanel bot={bot} group={group} open={open} />
    </Dialog>
  );
}

/** Refetch while open: a routine fires, defers or waits for its host without the console's gesture. */
export const ROUTINES_REFETCH_MS = 30_000;

/**
 * The dialog's content, also mounted as-is in the « Routines »
 * section of « Modifier le bot » (`embedded`): the settings scroller already
 * pads, and the history there becomes a card rather than a bordered column.
 */
export function BotRoutinesPanel({
  bot,
  group,
  open,
  embedded = false,
}: {
  bot?: BotDto;
  group?: GroupDto;
  open: boolean;
  embedded?: boolean;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Remounts the creation form empty after a success.
  const [formKey, setFormKey] = useState(0);

  const targetName = bot?.name ?? group?.name ?? "";
  // The same read (cached) as `RoutineToolCard`: the empty state invites one to
  // ask the bot only if its next run can really create the routine itself.
  const routineTool = useQuery({
    queryKey: queryKeys.botRoutineTool(bot?.id ?? "none"),
    queryFn: () => api.botRoutineTool(bot!.id),
    enabled: open && Boolean(bot),
  });
  // Asking the bot works only once its host is back.
  const askBotForRoutine = Boolean(bot && routineTool.data?.status === "active" && routineTool.data.reason === null);
  const routinesKey = bot ? queryKeys.routines(bot.id) : queryKeys.groupRoutines(group!.id);
  const routines = useQuery({
    queryKey: routinesKey,
    queryFn: () => bot ? api.routines(bot.id) : api.groupRoutines(group!.id),
    enabled: open && Boolean(bot || group),
    refetchInterval: ROUTINES_REFETCH_MS,
  });
  const limit = bot ? ROUTINE_LIMITS.maxPerBot : ROUTINE_LIMITS.maxPerGroup;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: routinesKey });
  const selectedRoutine = routines.data?.routines.find((entry) => entry.id === selectedId)
    ?? routines.data?.routines[0]
    ?? null;
  const viewerZone = browserTimeZone();

  const create = useMutation({
    mutationFn: (values: RoutineFormValues) => {
      const input = { name: values.name.trim(), schedule: values.schedule, timezone: values.timezone, message: values.message.trim() };
      return bot ? api.createRoutine(bot.id, input) : api.createGroupRoutine(group!.id, input);
    },
    onSuccess: async () => {
      setFormKey((key) => key + 1);
      await invalidate();
    },
  });

  return (
      <div className={cn("grid min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.65fr)]", embedded && "gap-5")}>
        <div className={cn("min-w-0 space-y-5", !embedded && "p-4 sm:p-5")}>
          {bot ? <RoutineToolCard bot={bot} open={open} onChanged={invalidate} /> : null}
          <section aria-label={t("botRoutinesDialog.title", { name: targetName })} className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CalendarClock aria-hidden className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{t("botRoutinesDialog.listTitle")}</p>
                <p className="text-xs text-muted-foreground">
                  {routines.data?.routines.length ?? 0} / {limit}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              {routines.isPending ? <RoutineRowsSkeleton label={t("common.loading")} /> : null}
              {routines.data?.routines.length === 0 ? (
                <Card className="border-dashed bg-muted/20 py-8 shadow-none">
                  <CardContent className="flex flex-col items-center gap-2 text-center">
                    <Clock3 aria-hidden className="size-5 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {askBotForRoutine
                        ? t("botRoutinesDialog.emptyAskBot", { name: targetName })
                        : t("botRoutinesDialog.empty")}
                    </p>
                  </CardContent>
                </Card>
              ) : null}
              {routines.data?.routines.map((routine) => (
                <RoutineCard
                  key={routine.id}
                  routine={routine}
                  routinesKey={routinesKey}
                  viewerZone={viewerZone}
                  selected={selectedRoutine?.id === routine.id}
                  onSelect={() => setSelectedId(routine.id)}
                />
              ))}
            </div>
          </section>

          <Separator />

          <details className="group/new-routine space-y-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-foreground">
              <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Plus aria-hidden className="size-4" />
              </div>
              <p className="flex-1 text-sm font-semibold text-foreground">
                {t("botRoutinesDialog.newTitle")}
              </p>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open/new-routine:rotate-180" aria-hidden />
            </summary>
            <RoutineForm
              key={formKey}
              idPrefix="routine"
              pending={create.isPending}
              error={create.isError ? (create.error instanceof ApiError ? create.error.message : t("botRoutinesDialog.addFailed")) : null}
              submitLabel={t("botRoutinesDialog.add")}
              pendingLabel={t("botRoutinesDialog.adding")}
              submitIcon={<Plus className="size-4" aria-hidden />}
              onSubmit={(values) => create.mutate(values)}
            />
          </details>
        </div>

        {/* The history has its own cache and its own retry: a failure
            reading the receipts never blocks the routines CRUD above
            nor the form below. */}
        <div
          className={cn(
            "min-w-0 bg-muted/20 p-4 sm:p-5",
            embedded ? "rounded-lg border border-border" : "border-t border-border lg:border-t-0 lg:border-l",
          )}
        >
          <RoutineExecutionsList
            routine={selectedRoutine}
            enabled={open}
          />
        </div>
      </div>
  );
}
