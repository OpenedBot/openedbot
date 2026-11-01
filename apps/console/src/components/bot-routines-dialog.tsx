import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CalendarClock, Clock3, Play, Plus, Trash2 } from "lucide-react";
import type { BotDto, GroupDto, RoutineDto } from "@openedbot/contracts-api";
import { isValidCron } from "@openedbot/execution/domain/routines";
import {
  Button,
  Card,
  CardContent,
  Dialog,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Switch,
  Textarea,
  cn,
  toast,
} from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { randomId } from "../lib/random-id";
import { useT } from "../lib/i18n";
import { RoutineExecutionsList } from "./routine-executions-list";
import { GatewayRestartCard } from "../screens/settings/installation/connectors-mcp";
import { BUTTON } from "./settings/primitives";

/**
 * Les routines d'un bot : la « Routines pane » d'Hermes Bot Mode, en dialogue.
 *
 * Une routine est un cron 5 champs évalué dans le fuseau du NAVIGATEUR au
 * moment de la création : « tous les jours à 9h » vaut 9h chez l'opérateur.
 * Les presets couvrent l'usage courant ; le cron libre reste offert, comme
 * chez Hermes.
 */
const PRESETS = [
  { id: "hourly", cron: "0 * * * *" },
  { id: "daily", cron: "0 9 * * *" },
  { id: "weekdays", cron: "0 9 * * 1-5" },
  { id: "weekly", cron: "0 9 * * 1" },
  { id: "custom", cron: "" },
] as const;

type PresetId = (typeof PRESETS)[number]["id"];

/**
 * La silhouette de deux routines pendant la lecture : même cadre, même
 * interrupteur à gauche, mêmes deux lignes (nom + planification à droite,
 * message) : le dialogue garde sa hauteur quand la liste arrive.
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

/**
 * L'interrupteur `routine_manage` (DEV-209) : le bot crée, modifie et met en
 * pause SES routines depuis la conversation. Bot seulement : un salon n'a pas
 * de run à lui. Le gateway ne lit ses serveurs MCP qu'au démarrage, d'où la
 * carte de redémarrage nommé après une bascule qui l'exige.
 */
function RoutineToolCard({ bot, open, onChanged }: { bot: BotDto; open: boolean; onChanged: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const key = queryKeys.botRoutineTool(bot.id);
  const tool = useQuery({ queryKey: key, queryFn: () => api.botRoutineTool(bot.id), enabled: open });
  const [restartPending, setRestartPending] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setBotRoutineTool(bot.id, enabled),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      setRestartPending(saved.restartPending);
      toast.success(t(saved.enabled ? "botRoutinesDialog.toolEnabled" : "botRoutinesDialog.toolDisabled", { name: bot.name }));
      onChanged();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.toolFailed")),
  });
  const data = tool.data;
  const unavailable = data && !data.available
    ? t(data.reason === "https_required"
      ? "botRoutinesDialog.toolUnavailableHttps"
      : data.reason === "runtime_required"
      ? "botRoutinesDialog.toolUnavailableRuntime"
      : data.reason === "profile_unsupported"
        ? "botRoutinesDialog.toolUnavailableProfile"
        : "botRoutinesDialog.toolUnavailableHost")
    : null;
  return (
    <section aria-labelledby="routine-tool-title" className="space-y-3">
      <Card size="sm" className="gap-3 py-3 shadow-none">
        <CardContent className="flex items-start gap-3 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot aria-hidden className="size-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <p id="routine-tool-title" className="text-sm font-semibold text-foreground">{t("botRoutinesDialog.toolTitle")}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("botRoutinesDialog.toolDescription", { name: bot.name })}</p>
            {unavailable ? <p className="text-xs text-muted-foreground">{unavailable}</p> : null}
            {tool.isError ? (
              <p role="alert" className="text-xs text-destructive-text">
                {tool.error instanceof ApiError ? tool.error.message : t("botRoutinesDialog.toolFailed")}
              </p>
            ) : null}
          </div>
          {tool.isPending ? (
            <Skeleton className="mt-0.5 h-5 w-8 shrink-0 rounded-full motion-reduce:animate-none" />
          ) : (
            <Switch
              checked={data?.enabled === true}
              onCheckedChange={(enabled) => toggle.mutate(enabled)}
              aria-label={t("botRoutinesDialog.toolAria", { name: bot.name })}
              disabled={!data?.available || toggle.isPending}
              className="mt-0.5 shrink-0"
            />
          )}
        </CardContent>
      </Card>
      {restartPending ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("botRoutinesDialog.toolRestart")}</p>
          <GatewayRestartCard onRestarted={() => setRestartPending(false)} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Le contenu de la boîte, monté aussi tel quel dans la rubrique « Routines »
 * de « Modifier le bot » (`embedded`) : le défileur des réglages rembourre
 * déjà, et l'historique y devient une carte plutôt qu'une colonne bordée.
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
  const { t, formatDate, plural } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<PresetId>("daily");
  const [customCron, setCustomCron] = useState("");
  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Une erreur réseau conserve la clé du geste : le clic de reprise rejoue
  // l'accusé original au lieu de créer silencieusement une seconde occurrence.
  const pendingRunKeys = useRef(new Map<string, string>());

  const targetName = bot?.name ?? group?.name ?? "";
  // Même lecture (en cache) que `RoutineToolCard` : l'état vide n'invite à
  // demander au bot que s'il peut vraiment créer la routine lui-même.
  const routineTool = useQuery({
    queryKey: queryKeys.botRoutineTool(bot?.id ?? "none"),
    queryFn: () => api.botRoutineTool(bot!.id),
    enabled: open && Boolean(bot),
  });
  const askBotForRoutine = Boolean(bot && routineTool.data?.available && routineTool.data.enabled);
  const routinesKey = bot ? queryKeys.routines(bot.id) : queryKeys.groupRoutines(group!.id);
  const routines = useQuery({
    queryKey: routinesKey,
    queryFn: () => bot ? api.routines(bot.id) : api.groupRoutines(group!.id),
    enabled: open && Boolean(bot || group),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: routinesKey });
  const selectedRoutine = routines.data?.routines.find((entry) => entry.id === selectedId)
    ?? routines.data?.routines[0]
    ?? null;

  const schedule = preset === "custom" ? customCron.trim() : PRESETS.find((entry) => entry.id === preset)!.cron;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const canSubmit = Boolean(name.trim()) && Boolean(message.trim()) && isValidCron(schedule);

  const create = useMutation({
    mutationFn: () => bot
      ? api.createRoutine(bot.id, { name: name.trim(), schedule, timezone, message: message.trim() })
      : api.createGroupRoutine(group!.id, { name: name.trim(), schedule, timezone, message: message.trim() }),
    onSuccess: async () => {
      setName("");
      setMessage("");
      await invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: ({ routine, enabled }: { routine: RoutineDto; enabled: boolean }) =>
      api.updateRoutine(routine.id, { enabled }),
    onMutate: async ({ routine, enabled }) => {
      await queryClient.cancelQueries({ queryKey: routinesKey });
      const previous = queryClient.getQueryData<{ routines: RoutineDto[] }>(routinesKey);
      queryClient.setQueryData<{ routines: RoutineDto[] }>(routinesKey, (current) => current ? ({
        routines: current.routines.map((candidate) =>
          candidate.id === routine.id ? { ...candidate, enabled } : candidate),
      }) : current);
      return { previous };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<{ routines: RoutineDto[] }>(routinesKey, (current) => current ? ({
        routines: current.routines.map((candidate) => candidate.id === saved.id ? saved : candidate),
      }) : current);
      toast.success(t(saved.enabled ? "botRoutinesDialog.activated" : "botRoutinesDialog.deactivated", {
        name: saved.name,
      }));
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(routinesKey, context.previous);
      toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.toggleFailed"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: routinesKey }),
  });

  // PERM2-9: no optimistic write. Turning the option off widens nothing,
  // turning it on narrows; either way the card shows the stored value only.
  const neverWait = useMutation({
    mutationFn: ({ routine, value }: { routine: RoutineDto; value: boolean }) =>
      api.updateRoutine(routine.id, { neverWait: value }),
    onSuccess: (saved) => {
      queryClient.setQueryData<{ routines: RoutineDto[] }>(routinesKey, (current) => current ? ({
        routines: current.routines.map((candidate) => candidate.id === saved.id ? saved : candidate),
      }) : current);
      toast.success(t(saved.neverWait ? "botRoutinesDialog.neverWaitOn" : "botRoutinesDialog.neverWaitOff", {
        name: saved.name,
      }));
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.neverWaitFailed"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: routinesKey }),
  });

  const remove = useMutation({
    mutationFn: (routineId: string) => api.deleteRoutine(routineId),
    onSuccess: invalidate,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.deleteFailed")),
  });

  const runNow = useMutation({
    mutationFn: async (routine: RoutineDto) => {
      const key = pendingRunKeys.current.get(routine.id) ?? randomId();
      pendingRunKeys.current.set(routine.id, key);
      const receipt = await api.runRoutine(routine.id, key);
      pendingRunKeys.current.delete(routine.id);
      return { routine, receipt };
    },
    onSuccess: async ({ routine }) => {
      toast.success(t("botRoutinesDialog.runStarted", { name: routine.name }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: routinesKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routineReceiptsRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routineExecutions(routine.id) }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.runFailed"));
    },
  });

  const presetLabel = (id: PresetId) =>
    id === "hourly" ? t("botRoutinesDialog.presetHourly")
    : id === "daily" ? t("botRoutinesDialog.presetDaily")
    : id === "weekdays" ? t("botRoutinesDialog.presetWeekdays")
    : id === "weekly" ? t("botRoutinesDialog.presetWeekly")
    : t("botRoutinesDialog.presetCustom");

  const scheduleLabel = (routine: RoutineDto) => {
    const match = PRESETS.find((entry) => entry.cron === routine.schedule && entry.id !== "custom");
    return match ? presetLabel(match.id) : routine.schedule;
  };

  return (
      <div className={cn("grid min-h-0 lg:grid-cols-[minmax(0,1.08fr)_minmax(19rem,0.92fr)]", embedded && "gap-5")}>
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
                  {routines.data?.routines.length ?? 0} / 20
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
                <Card
                  key={routine.id}
                  size="sm"
                  className={`gap-3 py-3 shadow-none transition-colors hover:border-primary/25 ${
                    selectedRoutine?.id === routine.id ? "border-primary/40" : ""
                  }`}
                  onClick={() => setSelectedId(routine.id)}
                >
                  <CardContent className="flex items-start gap-3 px-3">
                  <Switch
                    checked={routine.enabled}
                    onCheckedChange={(enabled) => toggle.mutate({ routine, enabled })}
                    aria-label={t(
                      routine.enabled ? "botRoutinesDialog.deactivateAria" : "botRoutinesDialog.activateAria",
                      { name: routine.name },
                    )}
                    disabled={toggle.isPending}
                    className="mt-0.5"
                  />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-col items-start gap-1 sm:flex-row sm:justify-between sm:gap-2">
                        <span className="line-clamp-2 text-sm font-medium text-foreground">{routine.name}</span>
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {scheduleLabel(routine)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{routine.message}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock3 aria-hidden className="size-3.5" />
                        {routine.enabled && routine.nextRunAt
                          ? t("botRoutinesDialog.nextRun", {
                              date: formatDate(routine.nextRunAt, { dateStyle: "medium", timeStyle: "short" }),
                            })
                          : t("botRoutinesDialog.paused")}
                      </p>
                      {routine.missedCount > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {plural(routine.missedCount, {
                            one: t("botRoutinesDialog.missedCount_one", { count: routine.missedCount }),
                            other: t("botRoutinesDialog.missedCount_other", { count: routine.missedCount }),
                          })}
                        </p>
                      ) : null}
                      <div className="flex items-start gap-2 pt-1">
                        <Switch
                          id={`routine-never-wait-${routine.id}`}
                          checked={routine.neverWait}
                          onCheckedChange={(value) => neverWait.mutate({ routine, value })}
                          aria-label={t("botRoutinesDialog.neverWaitAria", { name: routine.name })}
                          aria-describedby={`routine-never-wait-hint-${routine.id}`}
                          disabled={neverWait.isPending}
                          className="mt-0.5"
                        />
                        <div className="min-w-0">
                          <Label htmlFor={`routine-never-wait-${routine.id}`} className="text-xs font-medium">
                            {t("botRoutinesDialog.neverWaitLabel")}
                          </Label>
                          <p id={`routine-never-wait-hint-${routine.id}`} className="text-xs leading-5 text-muted-foreground">
                            {t("botRoutinesDialog.neverWaitHint")}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={t("botRoutinesDialog.runNowAria", { name: routine.name })}
                        onClick={() => runNow.mutate(routine)}
                        disabled={runNow.isPending}
                        className={BUTTON.small}
                      >
                        <Play className="size-3.5" aria-hidden />
                        {runNow.isPending && runNow.variables?.id === routine.id
                          ? t("botRoutinesDialog.runningNow")
                          : t("botRoutinesDialog.runNow")}
                      </button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      iconOnly
                      leadingIcon={Trash2}
                      aria-label={t("botRoutinesDialog.delete")}
                      title={t("botRoutinesDialog.delete")}
                      onClick={() => remove.mutate(routine.id)}
                      disabled={remove.isPending}
                      className="-mt-1 -mr-1 text-muted-foreground hover:text-destructive"
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <Separator />

          <section aria-labelledby="new-routine-title" className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Plus aria-hidden className="size-4" />
              </div>
              <p id="new-routine-title" className="text-sm font-semibold text-foreground">
                {t("botRoutinesDialog.newTitle")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="routine-name">{t("botRoutinesDialog.nameLabel")}</Label>
                <Input
                  id="routine-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("botRoutinesDialog.namePlaceholder")}
                  maxLength={100}
                />
              </div>
              <div className="space-y-1.5">
                <Label id="routine-schedule-label">{t("botRoutinesDialog.scheduleLabel")}</Label>
                <Select value={preset} onValueChange={(value) => setPreset(value as PresetId)}>
                  <SelectTrigger size="sm" aria-labelledby="routine-schedule-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESETS.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>{presetLabel(entry.id)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {preset === "custom" ? (
              <div className="space-y-1.5">
                <Label htmlFor="routine-cron">{t("botRoutinesDialog.customLabel")}</Label>
                <Input
                  id="routine-cron"
                  value={customCron}
                  onChange={(event) => setCustomCron(event.target.value)}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">{t("botRoutinesDialog.customHint")}</p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="routine-message">{t("botRoutinesDialog.messageLabel")}</Label>
              <Textarea
                id="routine-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t("botRoutinesDialog.messagePlaceholder")}
                rows={3}
                maxLength={4000}
                className="min-h-24 resize-y"
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">{t("botRoutinesDialog.timezoneNote", { timezone })}</p>
              <button
                type="button"
                onClick={() => create.mutate()}
                disabled={!canSubmit || create.isPending}
                className={BUTTON.primary}
              >
                <Plus className="size-4" aria-hidden />
                {create.isPending ? t("botRoutinesDialog.adding") : t("botRoutinesDialog.add")}
              </button>
            </div>
            {create.isError ? (
              <p role="alert" className="text-sm text-destructive-text">
                {create.error instanceof ApiError ? create.error.message : t("botRoutinesDialog.addFailed")}
              </p>
            ) : null}
          </section>
        </div>

        {/* L'historique a son propre cache et sa propre reprise : une panne de
            lecture des reçus ne bloque jamais le CRUD des routines au-dessus
            ni le formulaire au-dessous. */}
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
