import { useContext, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cn,
  DotMatrix,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from "@openedbot/browser-ui-kit";
import {
  HERMES_REASONING_EFFORTS,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import type { BotDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { catalogModelView } from "@/lib/bots/model-catalog";
import { BotFace } from "../../../../components/bot-face";
import { Note } from "../../../../components/settings/primitives";
import { activeProviderIncident, ProviderIncidentsContext } from "../../../../components/provider-incident-banner";
import { BotModelField } from "./models-bot-model-field";
import { BOT_TABLE_BOT_CELL, BOT_TABLE_GRID, BOT_TABLE_HEAD, NONE } from "./models-shared";
import { effortLabel } from "@/lib/bots/effort-label";

/**
 * In global mode, some bots keep their own model, ignored by the worker:
 * say so and offer the way out: put everything back on the default model, at once.
 * A single request: the database is reset before the response, then the
 * host profiles align in the background (`ProfileModelSyncProgress`). The
 * bot-by-bot PATCH paid a host write of about 2 s per bot, in series.
 */
export function GlobalOverridesNote({ bots }: { bots: BotDto[] }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const clear = useMutation({
    mutationFn: api.resetBotModelOverrides,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.botProfileModelSync, { sync: result.sync });
      toast.success(t("modelsSettings.clearOverridesDone"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
    onError: (error: Error) => toast.error(error.message || t("modelsSettings.clearOverridesFailed")),
  });
  return (
    // BoardUI `status-yellow` pair (yellow-200 / yellow-800, `warn-100` /
    // `warn-700` in app.css), no border, at the width of its text.
    <Note tone="warning" className="w-fit min-w-0 border-0 bg-warn-100 text-warn-700">
      <span>{t("modelsSettings.overridesIgnoredNote", { count: bots.length })} </span>
      <button
        type="button"
        className="cursor-pointer font-bold underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={clear.isPending}
        onClick={() => clear.mutate()}
      >
        {clear.isPending ? t("modelsSettings.clearingOverrides") : t("modelsSettings.clearOverridesToDefault")}
      </button>
    </Note>
  );
}

const SYNC_POLL_MS = 500;

/**
 * The host-profile alignment that follows « Repasser tous les bots au modèle
 * global »: a real bar, `done / total` read on the server while it
 * runs. Reread on mount, it resumes after a page reload.
 */
export function ProfileModelSyncProgress() {
  const { t } = useT();
  const sync = useQuery({
    queryKey: queryKeys.botProfileModelSync,
    queryFn: api.botProfileModelSync,
    refetchInterval: (query) => (query.state.data?.sync?.status === "running" ? SYNC_POLL_MS : false),
  });
  const current = sync.data?.sync ?? null;
  // Only an end seen mid-route is announced: not yesterday's alignment reread on mount.
  const seenRunning = useRef<string | null>(null);
  useEffect(() => {
    if (!current) return;
    if (current.status === "running") {
      seenRunning.current = current.id;
      return;
    }
    if (seenRunning.current !== current.id) return;
    seenRunning.current = null;
    if (current.failed > 0) toast.warning(t("modelsSettings.profileSyncFailed", { count: current.failed }));
    else toast.success(t("modelsSettings.profileSyncDone"));
  }, [current, t]);
  if (current?.status !== "running") return null;
  const percent = current.total === 0 ? 100 : Math.round((current.done / current.total) * 100);
  const label = t("modelsSettings.profileSyncProgress", { done: current.done, total: current.total });
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5 px-4 py-3 [&>*]:max-w-sm" role="status">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={current.total}
        aria-valuenow={current.done}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Each active bot's model, with its effort, on desktop.
 * « Modèle par défaut » (null value) = follow the choice above; every
 * other choice is sent by the worker with EACH run of the bot, and wins, in
 * « Un modèle par bot » mode only. In global mode (`inactive`), the
 * table stays readable but greyed out: the worker ignores these choices
 * (`modules/roster/src/sql/bots.ts`), without erasing them.
 *
 * The options come from the catalog of AUTHENTICATED providers: that is the
 * condition for the worker to honor the choice instead of falling back in silence
 * to the runtime's default (`resolveRunnableSelection`). An inherited model that
 * is no longer in it stays listed, marked unfindable, so it can be seen and corrected.
 */
export function PerBotModelsTable({
  bots,
  rosterPending,
  rosterError,
  providers,
  globalModel,
  globalProvider,
  inactive,
}: {
  bots: BotDto[];
  rosterPending: boolean;
  rosterError: boolean;
  providers: RuntimeModelProviderDto[];
  globalModel: string | null;
  /** The global choice's provider: that of the bots that follow it. */
  globalProvider: string | null;
  /** Global mode: the worker ignores these choices, the table is greyed out and frozen. */
  inactive: boolean;
}) {
  const { t } = useT();
  const incidents = useContext(ProviderIncidentsContext);
  const queryClient = useQueryClient();
  const { groups: modelGroups, knownIds: knownModelIds, reasoningIds: reasoningModelIds } = catalogModelView(
    providers,
    [globalModel, ...bots.map((bot) => bot.model)],
  );

  const save = useMutation({
    mutationFn: (input: { bot: BotDto; model: string | null; effort: HermesReasoningEffort | null }) =>
      api.updateBot(input.bot.id, { model: input.model, reasoningEffort: input.effort }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
    onSuccess: (_data, input) => toast.success(t("modelsSettings.perBotSaved", { name: input.bot.name })),
    onError: (error: Error) => toast.error(error.message || t("modelsSettings.saveFailed")),
  });

  if (rosterError) {
    return (
      <div className="px-4 py-3">
        <Note tone="danger" role="alert">{t("modelsSettings.perBotRosterFailed")}</Note>
      </div>
    );
  }

  // Flat in the card (`DESIGN.md` › Bureau: no bordered sub-list inside a
  // card): the column band at its top, then the rows.
  return (
    <div className="@container" data-bot-models-inactive={inactive ? "" : undefined}>
      {inactive && bots.length > 0 ? (
        <p className="border-b border-border/60 px-4 py-2.5 text-xs leading-5 text-muted-foreground">
          {t("modelsSettings.botTableInactiveHint")}
        </p>
      ) : null}
      {rosterPending ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-12 w-full motion-reduce:animate-none" />)}
        </div>
      ) : bots.length === 0 ? (
        <div className="p-4"><Note tone="neutral">{t("modelsSettings.perBotEmpty")}</Note></div>
      ) : (
        <div className={cn(inactive && "opacity-60")}>
          <div className={cn(BOT_TABLE_GRID, BOT_TABLE_HEAD)} aria-hidden>
            <span>{t("modelsSettings.perBotColumnBot")}</span>
            <span>{t("modelsSettings.perBotColumnModel")}</span>
            <span>{t("modelsSettings.perBotColumnEffort")}</span>
          </div>
          <ul className="divide-y divide-border/60">
            {bots.map((bot) => {
              const pendingRow = save.isPending && save.variables?.bot.id === bot.id;
              const unknownModel = bot.model !== null && !knownModelIds.has(bot.model);
              // Effort is chosen only if the bot's EFFECTIVE model reasons:
              // the worker strips the effort from a model that does not reason.
              const effectiveModelId = bot.model ?? globalModel;
              const effortPickable = effectiveModelId !== null && reasoningModelIds.has(effectiveModelId);
              // In « Par bot », no more « ce qu'un run utilisera » inset: a provider's
              // failure is read on the row of the bot it will make fail,
              // through the authenticated provider that lists its model.
              const rowProvider = bot.model === null
                ? globalProvider
                : providers.find((provider) => provider.authenticated && provider.models.some((model) => model.id === bot.model))?.slug ?? null;
              const rowIncident = activeProviderIncident(incidents, rowProvider);
              return (
                <li key={bot.id} className={cn(BOT_TABLE_GRID, "px-4 py-3")}>
                  <span className={cn("flex min-w-0 items-center gap-3", BOT_TABLE_BOT_CELL)}>
                    <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-8 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{bot.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">@{bot.slug}</span>
                    </span>
                    {pendingRow ? (
                      <DotMatrix state="syncing" label={t("modelsSettings.saving")} className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </span>
                  <BotModelField
                    id={`bot-model-${bot.id}`}
                    ariaLabel={t("modelsSettings.perBotModelAria", { name: bot.name })}
                    providers={providers}
                    value={bot.model}
                    globalModel={globalModel}
                    disabled={inactive || save.isPending}
                    onValueChange={(model) => {
                      const nextEffective = model ?? globalModel;
                      save.mutate({
                        bot,
                        model,
                        // A model that does not reason loses the stored effort, as at run time.
                        effort:
                          nextEffective !== null && reasoningModelIds.has(nextEffective)
                            ? (bot.reasoningEffort as HermesReasoningEffort | null)
                            : null,
                      });
                    }}
                  />
                  <Select
                    value={bot.reasoningEffort ?? NONE}
                    disabled={inactive || save.isPending || !effortPickable}
                    onValueChange={(value) =>
                      save.mutate({
                        bot,
                        model: bot.model,
                        effort: value === NONE ? null : (value as HermesReasoningEffort),
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={t("modelsSettings.perBotEffortAria", { name: bot.name })}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="bottom" avoidCollisions={false} rows={6}>
                      <SelectGroup>
                        <SelectItem value={NONE}>{t("modelsSettings.perBotEffortDefault")}</SelectItem>
                        {HERMES_REASONING_EFFORTS.map((effort) => (
                          <SelectItem key={effort} value={effort}>{effortLabel(t, effort)}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {unknownModel ? (
                    <p className="col-span-full text-xs leading-5 text-warn-700">{t("modelsSettings.perBotUnknownHint")}</p>
                  ) : null}
                  {rowIncident ? (
                    <p className="col-span-full text-xs leading-5 text-destructive-text" role="status">
                      {t("providerIncidents.runsWillFail", { provider: rowIncident.provider })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {modelGroups.length === 0 ? (
        <p className="border-t border-border/60 px-4 py-3 text-xs leading-5 text-muted-foreground">{t("modelsSettings.perBotNoProviders")}</p>
      ) : null}
    </div>
  );
}
