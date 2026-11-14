import { useState, type ReactNode } from "react";
import type { RoutineDto } from "@openedbot/contracts-api";
import { ROUTINE_LIMITS, oneShotTime } from "@openedbot/execution/domain/routines";
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import {
  DEFAULT_SCHEDULE,
  SCHEDULE_KINDS,
  browserTimeZone,
  cronFromDraft,
  draftFromCron,
  parseTimeValue,
  routinePatch,
  timeValue,
  type RoutineFormValues,
  type ScheduleDraft,
  type ScheduleKind,
} from "../lib/routines/schedule";
import { useScheduleText } from "./routine-schedule-text";
import { ACTIONS, BUTTON } from "./settings/primitives";

const KIND_LABEL = {
  hourly: "botRoutinesDialog.presetHourly",
  daily: "botRoutinesDialog.presetDaily",
  weekdays: "botRoutinesDialog.presetWeekdays",
  weekly: "botRoutinesDialog.presetWeekly",
  custom: "botRoutinesDialog.presetCustom",
} as const satisfies Record<ScheduleKind, string>;

/**
 * The routine form, for a new routine and for an edit (`routine`). A preset
 * takes a time of day (and a weekday) and still writes a plain 5-field cron;
 * a cron that fits no preset opens in « custom », untouched. A one-shot
 * reminder keeps its instant: only its name and message are editable.
 */
export function RoutineForm({
  idPrefix,
  routine,
  pending,
  error,
  submitLabel,
  pendingLabel,
  submitIcon,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  routine?: RoutineDto;
  pending: boolean;
  error: string | null;
  submitLabel: string;
  pendingLabel: string;
  submitIcon?: ReactNode;
  onSubmit: (values: RoutineFormValues) => void;
  onCancel?: () => void;
}) {
  const { t } = useT();
  const { weekday, describeDraft, describeOnce } = useScheduleText();
  const viewerZone = browserTimeZone();
  const once = routine ? oneShotTime(routine.schedule) : null;
  const [name, setName] = useState(routine?.name ?? "");
  const [message, setMessage] = useState(routine?.message ?? "");
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    routine && !once ? draftFromCron(routine.schedule) : DEFAULT_SCHEDULE);
  const [timezone, setTimezone] = useState(routine?.timezone ?? viewerZone);

  const cron = once ? routine!.schedule : cronFromDraft(draft);
  const values: RoutineFormValues | null = cron === null ? null : { name, message, schedule: cron, timezone };
  const patch = routine && values ? routinePatch(routine, values) : null;
  const changed = patch === null || Object.keys(patch).length > 0;
  const canSubmit = Boolean(values && name.trim() && message.trim() && changed);
  const update = (next: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...next }));
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={id("name")}>{t("botRoutinesDialog.nameLabel")}</Label>
          <Input id={id("name")} value={name} onChange={(event) => setName(event.target.value)}
            placeholder={t("botRoutinesDialog.namePlaceholder")} maxLength={ROUTINE_LIMITS.nameMax} />
        </div>
        <div className="space-y-1.5">
          <Label id={id("schedule-label")}>{t("botRoutinesDialog.scheduleLabel")}</Label>
          {once ? (
            <p className="flex min-h-9 items-center text-sm text-foreground">
              {describeOnce(once)}
            </p>
          ) : (
            <Select value={draft.kind} onValueChange={(kind) => update({ kind: kind as ScheduleKind })}>
              <SelectTrigger size="sm" aria-labelledby={id("schedule-label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{t(KIND_LABEL[kind])}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      {once ? <p className="text-xs leading-5 text-muted-foreground">{t("botRoutinesDialog.oneShotFixed")}</p> : null}
      {!once && draft.kind !== "custom" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {draft.kind === "weekly" ? (
            <div className="space-y-1.5">
              <Label id={id("weekday-label")}>{t("botRoutinesDialog.weekdayLabel")}</Label>
              <Select value={String(draft.weekday)} onValueChange={(day) => update({ weekday: Number(day) })}>
                <SelectTrigger size="sm" aria-labelledby={id("weekday-label")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Monday first, as a French week reads; Sunday stays cron's 0. */}
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => <SelectItem key={day} value={String(day)}>{weekday(day)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {draft.kind === "hourly" ? (
            <div className="space-y-1.5">
              <Label htmlFor={id("minute")}>{t("botRoutinesDialog.minuteLabel")}</Label>
              <Input id={id("minute")} type="number" inputMode="numeric" min={0} max={59} step={1}
                value={Number.isNaN(draft.minute) ? "" : draft.minute}
                onChange={(event) => update({ minute: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor={id("time")}>{t("botRoutinesDialog.timeLabel")}</Label>
              <Input id={id("time")} type="time" step={60} value={Number.isNaN(draft.hour) || Number.isNaN(draft.minute) ? "" : timeValue(draft)}
                onChange={(event) => update(parseTimeValue(event.target.value) ?? { hour: Number.NaN, minute: Number.NaN })} />
            </div>
          )}
        </div>
      ) : null}
      {!once && draft.kind === "custom" ? (
        <div className="space-y-1.5">
          <Label htmlFor={id("cron")}>{t("botRoutinesDialog.customLabel")}</Label>
          <Input id={id("cron")} value={draft.cron} onChange={(event) => update({ cron: event.target.value })}
            placeholder="0 9 * * 1-5" className="font-mono" />
          <p className="text-xs text-muted-foreground">{t("botRoutinesDialog.customHint")}</p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={id("message")}>{t("botRoutinesDialog.messageLabel")}</Label>
        <Textarea id={id("message")} value={message} onChange={(event) => setMessage(event.target.value)}
          placeholder={t("botRoutinesDialog.messagePlaceholder")} rows={3} maxLength={ROUTINE_LIMITS.messageMax}
          className="min-h-24 resize-y" />
      </div>
      <div className="space-y-3">
        <div className="min-w-0 space-y-1 text-xs leading-5 text-muted-foreground">
          {!once ? <p className="font-medium text-foreground">{describeDraft(draft)}</p> : null}
          {!once ? (
            <p>
              {t("botRoutinesDialog.timezoneNote", { timezone })}
              {timezone !== viewerZone ? (
                <>
                  {" "}
                  <button type="button" onClick={() => setTimezone(viewerZone)}
                    className="cursor-pointer rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary">
                    {t("botRoutinesDialog.useBrowserTimezone", { timezone: viewerZone })}
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          {patch ? (
            <p>{t(patch.schedule !== undefined || patch.timezone !== undefined
              ? "botRoutinesDialog.editReschedules" : "botRoutinesDialog.editKeepsClock")}</p>
          ) : null}
        </div>
        <div className={ACTIONS}>
          {onCancel ? (
            <button type="button" onClick={onCancel} disabled={pending} className={BUTTON.secondary}>
              {t("common.cancel")}
            </button>
          ) : null}
          <button type="button" onClick={() => values && onSubmit(values)} disabled={!canSubmit || pending} className={BUTTON.primary}>
            {submitIcon}
            {pending ? pendingLabel : submitLabel}
          </button>
        </div>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
    </div>
  );
}
