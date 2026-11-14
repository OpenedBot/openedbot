import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { CalendarClock, Check, ChevronDown, Pencil, Play, Trash2, Unplug } from "lucide-react";
import type { RoutineDto } from "@openedbot/contracts-api";
import { oneShotTime } from "@openedbot/execution/domain/routines";
import { Button, Card, CardContent, Dialog, Label, Switch, cn, toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { randomId } from "../lib/random-id";
import { useT } from "../lib/i18n";
import { ROUTINE_ERROR_CODES } from "../lib/routines/executions";
import { oneShotOverdue, oneShotSent, routinePatch, routineZoneDiffers, type RoutineFormValues } from "../lib/routines/schedule";
import { RoutineForm } from "./routine-form";
import { useScheduleText } from "./routine-schedule-text";
import { BUTTON } from "./settings/primitives";

type RoutineList = { routines: RoutineDto[] };

/**
 * One routine of the list: its state, its options, and every gesture on it
 * (switch, edit in place, run now, delete after confirmation). Each card
 * owns its mutations, so one pending gesture never freezes the others.
 */
export function RoutineCard({
  routine,
  routinesKey,
  viewerZone,
  selected,
  onSelect,
}: {
  routine: RoutineDto;
  routinesKey: QueryKey;
  viewerZone: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t, formatDate, plural } = useT();
  const { describeRoutine } = useScheduleText();
  const queryClient = useQueryClient();
  const hostHintId = useId();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A network error keeps the gesture's key: the retry click replays
  // the original submission instead of silently creating a second occurrence.
  const pendingRunKey = useRef<string | null>(null);

  const replace = (saved: RoutineDto) => queryClient.setQueryData<RoutineList>(routinesKey, (current) => current ? ({
    routines: current.routines.map((candidate) => candidate.id === saved.id ? saved : candidate),
  }) : current);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: routinesKey });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateRoutine(routine.id, { enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: routinesKey });
      const previous = queryClient.getQueryData<RoutineList>(routinesKey);
      replace({ ...routine, enabled });
      return { previous, sendsNow: enabled && oneShotOverdue(routine, new Date()) };
    },
    onSuccess: (saved, _enabled, context) => {
      replace(saved);
      toast.success(t(!saved.enabled ? "botRoutinesDialog.deactivated"
        : context?.sendsNow ? "botRoutinesDialog.activatedNow" : "botRoutinesDialog.activated", { name: saved.name }));
    },
    onError: (error, _enabled, context) => {
      if (context?.previous) queryClient.setQueryData(routinesKey, context.previous);
      toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.toggleFailed"));
    },
    onSettled: invalidate,
  });

  // PERM2-9: no optimistic write. Turning the option off widens nothing,
  // turning it on narrows; either way the card shows the stored value only.
  const neverWait = useMutation({
    mutationFn: (value: boolean) => api.updateRoutine(routine.id, { neverWait: value }),
    onSuccess: (saved) => {
      replace(saved);
      toast.success(t(saved.neverWait ? "botRoutinesDialog.neverWaitOn" : "botRoutinesDialog.neverWaitOff", { name: saved.name }));
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.neverWaitFailed")),
    onSettled: invalidate,
  });

  const edit = useMutation({
    mutationFn: (values: RoutineFormValues) => api.updateRoutine(routine.id, routinePatch(routine, values)),
    onSuccess: (saved) => {
      replace(saved);
      setEditing(false);
      toast.success(t("botRoutinesDialog.saved", { name: saved.name }));
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteRoutine(routine.id),
    onSuccess: async () => {
      setConfirmingDelete(false);
      await invalidate();
    },
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const key = pendingRunKey.current ?? randomId();
      pendingRunKey.current = key;
      const receipt = await api.runRoutine(routine.id, key);
      pendingRunKey.current = null;
      return receipt;
    },
    onSuccess: async () => {
      toast.success(t("botRoutinesDialog.runStarted", { name: routine.name }));
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: queryKeys.routineExecutions(routine.id) }),
      ]);
    },
    onError: (error) => {
      const hostOffline = error instanceof ApiError && error.code === ROUTINE_ERROR_CODES.hostOffline;
      toast.error(hostOffline ? t("botRoutinesDialog.hostOffline")
        : error instanceof ApiError ? error.message : t("botRoutinesDialog.runFailed"));
      // The refusal means the list's `waitingForHost` may be stale.
      if (hostOffline) void invalidate();
    },
  });

  const sent = oneShotSent(routine);
  const overdue = oneShotOverdue(routine, new Date());
  const nextRun = routine.nextRunAt
    ? formatDate(routine.nextRunAt, routineZoneDiffers(routine, viewerZone)
      // The schedule line names the routine's zone; the instant then names the
      // reader's (`dateStyle` refuses `timeZoneName`, hence the fields).
      ? { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }
      : { dateStyle: "medium", timeStyle: "short" })
    : null;

  return (
    <Card size="sm" data-routine={routine.id} className={cn("gap-0 overflow-hidden py-0 shadow-none", selected && "border-primary/30")}>
      {editing ? (
        <CardContent className="p-4">
          <RoutineForm
            idPrefix={`routine-edit-${routine.id}`}
            routine={routine}
            pending={edit.isPending}
            error={edit.isError ? (edit.error instanceof ApiError ? edit.error.message : t("botRoutinesDialog.saveFailed")) : null}
            submitLabel={t("botRoutinesDialog.save")}
            pendingLabel={t("botRoutinesDialog.saving")}
            onSubmit={(values) => edit.mutate(values)}
            onCancel={() => {
              edit.reset();
              setEditing(false);
            }}
          />
        </CardContent>
      ) : (
        <>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-4">
              <button type="button" onClick={onSelect} aria-pressed={selected}
                className="min-w-0 flex-1 cursor-pointer rounded-sm text-left text-sm font-semibold text-foreground wrap-anywhere outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {routine.name}
              </button>
              {sent ? (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-pos-soft px-2 py-1 text-[0.6875rem] font-medium text-pos-700">
                  <Check className="size-3" aria-hidden />{t("botRoutinesDialog.completed")}
                </span>
              ) : (
                <Switch checked={routine.enabled} onCheckedChange={(enabled) => toggle.mutate(enabled)}
                  aria-label={t(routine.enabled ? "botRoutinesDialog.deactivateAria" : "botRoutinesDialog.activateAria", { name: routine.name })}
                  disabled={toggle.isPending} className="shrink-0" />
              )}
            </div>
            <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <CalendarClock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 wrap-anywhere">{describeRoutine(routine, viewerZone)}</span>
            </div>
            <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">{routine.message}</p>
            {routine.waitingForHost ? (
              <div className="flex items-start gap-2 text-xs leading-5 text-warn-700">
                <Unplug className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <p><span className="font-medium">{t("botRoutinesDialog.waitingForHost")}</span>
                  {" · "}<span id={hostHintId}>{t("botRoutinesDialog.waitingForHostHint")}</span></p>
              </div>
            ) : !sent ? (
              <p className="text-xs text-muted-foreground">
                {routine.enabled && nextRun ? t("botRoutinesDialog.nextRun", { date: nextRun }) : t("botRoutinesDialog.paused")}
              </p>
            ) : null}
            {overdue ? <p className="text-xs leading-5 text-warn-700">{t("botRoutinesDialog.oneShotOverdue")}</p> : null}
            {routine.missedCount > 0 ? <p className="text-xs text-warn-700">{plural(routine.missedCount, {
              one: t("botRoutinesDialog.missedCount_one", { count: routine.missedCount }),
              other: t("botRoutinesDialog.missedCount_other", { count: routine.missedCount }),
            })}</p> : null}
            <details className="group/options border-t border-border/60 pt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between text-xs text-muted-foreground hover:text-foreground">
                {t("botRoutinesDialog.options")}<ChevronDown className="size-3.5 transition-transform group-open/options:rotate-180" aria-hidden />
              </summary>
              <div className="mt-3 flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor={`routine-never-wait-${routine.id}`} className="text-xs font-medium">{t("botRoutinesDialog.neverWaitLabel")}</Label>
                  <p id={`routine-never-wait-hint-${routine.id}`} className="text-xs leading-5 text-muted-foreground">{t("botRoutinesDialog.neverWaitHint")}</p>
                </div>
                <Switch id={`routine-never-wait-${routine.id}`} checked={routine.neverWait}
                  onCheckedChange={(value) => neverWait.mutate(value)}
                  aria-label={t("botRoutinesDialog.neverWaitAria", { name: routine.name })}
                  aria-describedby={`routine-never-wait-hint-${routine.id}`} disabled={neverWait.isPending} />
              </div>
            </details>
          </CardContent>
          <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/15 px-3 py-2">
            {/* Disabled while the host is away: the API would refuse it (409). */}
            <Button variant="ghost" size="sm" leadingIcon={Play} onClick={() => runNow.mutate()}
              disabled={runNow.isPending || routine.waitingForHost}
              aria-describedby={routine.waitingForHost ? hostHintId : undefined}
              aria-label={t("botRoutinesDialog.runNowAria", { name: routine.name })}>
              {runNow.isPending ? t("botRoutinesDialog.runningNow") : t("botRoutinesDialog.runNow")}
            </Button>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" leadingIcon={Pencil} onClick={() => setEditing(true)}
                aria-label={t("botRoutinesDialog.editAria", { name: routine.name })}>
                {/* A phone keeps the pencil only: three labelled actions clip « Exécuter maintenant ». */}
                <span className="max-sm:sr-only">{t("botRoutinesDialog.edit")}</span>
              </Button>
              <Button variant="ghost" size="icon-sm" iconOnly leadingIcon={Trash2} aria-label={t("botRoutinesDialog.delete")}
                onClick={() => setConfirmingDelete(true)} className="text-muted-foreground hover:text-destructive" />
            </div>
          </div>
        </>
      )}
      <RoutineDeleteDialog
        name={routine.name}
        open={confirmingDelete}
        pending={remove.isPending}
        error={remove.isError ? (remove.error instanceof ApiError ? remove.error.message : t("botRoutinesDialog.deleteFailed")) : null}
        onConfirm={() => remove.mutate()}
        onClose={() => {
          if (remove.isPending) return;
          remove.reset();
          setConfirmingDelete(false);
        }}
      />
    </Card>
  );
}

/**
 * The deletion confirmation: the application `Dialog`, never `window.confirm`
 * (cf. `bot-actions.tsx`). Deleting also erases the execution history.
 */
function RoutineDeleteDialog({ name, open, pending, error, onConfirm, onClose }: {
  name: string;
  open: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      title={t("botRoutinesDialog.deleteTitle", { name })}
      description={t("botRoutinesDialog.deleteDescription")}
      closeLabel={t("common.close")}
      swipeToDismiss={false}
      footer={(
        <>
          <button type="button" className={BUTTON.secondary} onClick={onClose} disabled={pending}>{t("common.cancel")}</button>
          <button type="button" className={BUTTON.danger} onClick={onConfirm} disabled={pending}>
            {pending ? t("botRoutinesDialog.deleting") : t("botRoutinesDialog.deleteConfirm")}
          </button>
        </>
      )}
    >
      {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
    </Dialog>
  );
}
