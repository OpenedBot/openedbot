import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BotDto,
  RosterDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import {
  isHermesReasoningEffort,
  isLocalEngine,
  LOCAL_ENGINES,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import { catalogModelView, globalModelIsAutomatic, resolveThreadModel, runtimeGlobalModel } from "@/lib/bots/model-catalog";
import { toast } from "@openedbot/browser-ui-kit";
import type { RunFallbackServed } from "../lib/run/run-fallback";
import { api, ApiError, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { useBotRuntime } from "../lib/runtime/use-bot-runtime";
import { displayedRuntimeHealth } from "../lib/runtime/runtime-health";
import { trackBotModelSave } from "../lib/bots/bot-model-saves";
import { ComposerModelPicker } from "./composer-model-picker-view";

type ModelSelection = {
  model: string | null;
  effort: HermesReasoningEffort | null;
  /** The bot's fast-mode wish; the worker honours it only on a fast model. */
  fast: boolean;
};

const sameSelection = (left: ModelSelection, right: ModelSelection) =>
  left.model === right.model && left.effort === right.effort && left.fast === right.fast;

const selectionFromBot = (bot: BotDto): ModelSelection => ({
  model: bot.model,
  effort: isHermesReasoningEffort(bot.reasoningEffort) ? bot.reasoningEffort : null,
  fast: bot.fastMode === true,
});

/**
 * Control of the next run: it shares the settings catalogue, but writes
 * the bot's preference directly so the choice made in the composer is
 * the one the worker will actually resolve.
 */
type ThreadModelPickerProps = {
  bot: BotDto;
  /** See `ComposerModelPicker`: the fallback that served the bot's last turn. */
  servedBy?: RunFallbackServed | null;
  disabled?: boolean;
  /** See `ComposerModelPicker`: composer chip, mobile subtitle text, or top-bar pill. */
  variant?: "chip" | "inline" | "header";
};

export function ThreadModelPicker(props: ThreadModelPickerProps) {
  const { t } = useT();
  const host = useBotRuntime(props.bot.runtimeId);
  const { runtime } = host;
  if (props.bot.runtimeId && !runtime) {
    return (
      <span className="truncate text-caption-1-regular text-text-secondary" role="status">
        {t(host.isPending ? "composer.modelLoading" : "newBotDialog.executionHostUnavailable")}
      </span>
    );
  }
  return <RuntimeThreadModelPicker {...props} host={host} />;
}

function RuntimeThreadModelPicker({
  bot,
  disabled = false,
  variant = "chip",
  servedBy = null,
  host,
}: ThreadModelPickerProps & { host: ReturnType<typeof useBotRuntime> }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  // The assignment mode lives on the organization, not on the runtime: the same
  // cache entry as `runtimes` above, read without `select`.
  const assignment = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    refetchOnWindowFocus: true,
  });
  // The picker offers the whole catalogue; a per-bot choice switches
  // the organization to « Par bot » mode in `write`.
  const runtime = host.runtime ?? null;
  // « Le même modèle pour tous » imposes only a global model that is set:
  // without one, the worker runs the bot's own model
  // (`applyRuntimeModelSelection`), so the display must too.
  const globalOnly = assignment.data?.modelAssignmentMode === "global" && Boolean(runtime?.selectedModel?.trim());
  const catalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtime?.id ?? "none"),
    queryFn: () => api.runtimeModels(runtime!.id!),
    // Link closed: the catalogue would only answer 503; it resumes on reopen.
    enabled: Boolean(runtime?.id) && displayedRuntimeHealth(runtime) !== "disconnected",
    // Aligned with the server cache (30 s): reopening a conversation does not replay
    // a round trip to the host, and the picker renders its section without blocking the thread.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const view = useMemo(() => catalogModelView(catalog.data?.providers ?? []), [catalog.data?.providers]);
  const globalModel = runtimeGlobalModel(runtime, catalog.data);
  // Instant change: the displayed choice is authoritative from the click, the server
  // follows behind. Nothing freezes while saving, a single round trip leaves
  // at a time and the last choice asked for always wins: a response
  // that is stale never brings the display back.
  const [selection, setSelection] = useState<ModelSelection>(() => selectionFromBot(bot));
  /** Last state confirmed by the server: the basis of "send only what changes". */
  const confirmed = useRef<ModelSelection>(selection);
  /** Last choice asked for, in flight or pending. Compared by identity. */
  const wanted = useRef<ModelSelection>(selection);
  const inFlight = useRef<Promise<void> | null>(null);
  const toastId = `composer-model-${bot.id}`;

  const write = async (next: ModelSelection): Promise<BotDto> => {
    // Effort alone is only a row in the database. Joining the model would make
    // the API go through the Hermes host (model list, profile) before
    // answering: `modelChanged` in `bot-input.ts`.
    const fastChange = next.fast === confirmed.current.fast ? {} : { fastMode: next.fast };
    const updated = await api.updateBot(bot.id, next.model === confirmed.current.model
      ? { reasoningEffort: next.effort, ...fastChange }
      : {
          model: next.model,
          provider: view.groups.find((group) => group.models.some((entry) => entry.id === next.model))?.slug ?? null,
          reasoningEffort: next.effort,
          ...fastChange,
        });
    // In global mode, the worker would ignore this choice: a model, an effort
    // or the fast mode set here switches the organization to « Par bot » so
    // that it applies.
    if (globalOnly && (next.model !== null || next.effort !== null || next.fast)) {
      await api.saveModelAssignmentMode("per_bot");
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
    }
    return updated;
  };

  const flush = (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    // Declared first: its own `finally` compares the slot with it.
    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        // Choices made during a round trip wait for it to finish, then only the
        // last one leaves: the intermediates are no longer worth anything.
        for (;;) {
          const target = wanted.current;
          if (sameSelection(target, confirmed.current)) break;
          try {
            const updated = await write(target);
            confirmed.current = selectionFromBot(updated);
            queryClient.setQueryData<RosterDto>(queryKeys.roster, (current) => current
              ? { ...current, bots: current.bots.map((entry) => entry.id === updated.id ? updated : entry) }
              : current);
          } catch (error) {
            wanted.current = confirmed.current;
            setSelection(confirmed.current);
            // The pick never reached the server: the next turn still runs
            // where the last one did, so the fallback mark comes back too.
            if (fallbackBeforePick.current !== undefined) {
              setAnsweredFallbackRun(fallbackBeforePick.current);
              fallbackBeforePick.current = undefined;
            }
            toast.error(error instanceof ApiError ? error.message : t("composer.modelSaveFailed"), { id: toastId });
            return;
          }
          if (wanted.current === target) {
            // Nothing left pending: the display takes the confirmed shape
            // (the server may normalize, a null effort for example).
            fallbackBeforePick.current = undefined;
            wanted.current = confirmed.current;
            setSelection(confirmed.current);
            break;
          }
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      } finally {
        // A machine move may have queued behind this save: it keeps its slot.
        if (inFlight.current === run) inFlight.current = null;
      }
    })();
    inFlight.current = run;
    // Every picker of this bot reports here, the bot page included: a send
    // waits for the save wherever the model was chosen (`bot-model-saves.ts`).
    trackBotModelSave(bot.id, run);
    return run;
  };

  // A model picked after a fallback is the next turn's model: the trigger
  // stops naming the fallback of the turn before it, whichever picker wrote
  // it (this one, the bot page, another tab).
  const [answeredFallbackRun, setAnsweredFallbackRun] = useState<string | null>(null);
  // What `answeredFallbackRun` was before a pick dismissed the mark, kept
  // until that pick is confirmed (`undefined`: no pick pending), so a failed
  // save restores it along with the selection.
  const fallbackBeforePick = useRef<string | null | undefined>(undefined);
  const shownFallback = servedBy && servedBy.runId !== answeredFallbackRun ? servedBy : null;
  const servedByRun = useRef<string | null>(servedBy?.runId ?? null);
  servedByRun.current = servedBy?.runId ?? null;
  const syncedBotId = useRef(bot.id);

  useEffect(() => {
    // A bot update that came from elsewhere (another tab, Réglages). During
    // a save, it is our own write: it is not replayed.
    if (inFlight.current) return;
    const current = selectionFromBot(bot);
    // Same bot only: switching bots is not a model change.
    if (syncedBotId.current === bot.id && servedByRun.current && !sameSelection(current, confirmed.current)) {
      setAnsweredFallbackRun(servedByRun.current);
    }
    syncedBotId.current = bot.id;
    setSelection(current);
    confirmed.current = current;
    wanted.current = current;
  }, [bot.id, bot.model, bot.reasoningEffort, bot.fastMode]);

  const resolved = resolveThreadModel({
    botModel: globalOnly ? null : selection.model,
    botEffort: globalOnly ? null : selection.effort,
    globalModel,
    globalEffort: runtime?.reasoningEffort ?? null,
    catalog: view,
  });

  const persist = (next: ModelSelection) => {
    setSelection(next);
    if (sameSelection(next, wanted.current)) return;
    wanted.current = next;
    void flush();
  };

  const selectModel = (model: string | null) => {
    if (servedBy) {
      if (fallbackBeforePick.current === undefined) fallbackBeforePick.current = answeredFallbackRun;
      setAnsweredFallbackRun(servedBy.runId);
    }
    const effectiveId = model ?? globalModel;
    persist({
      model,
      effort: effectiveId && view.reasoningIds.has(effectiveId) && isHermesReasoningEffort(selection.effort)
        && (view.effortsById.get(effectiveId)?.includes(selection.effort) ?? true)
        ? selection.effort
        : null,
      // The wish is kept across models: it shows, and applies, again on a
      // model that offers it.
      fast: selection.fast,
    });
  };

  const allProviders = catalog.data?.providers ?? [];

  // The workspace's other machines: the default one and each agent of a
  // machine, as the bot's Machine page lists them. One opens its catalogue in
  // the list; a model picked there moves the bot (`moveTo`).
  const registry = useQuery({ queryKey: queryKeys.runtimeList, queryFn: api.runtimeList });
  const [browsingId, setBrowsingId] = useState<string | null>(null);
  // A move freezes the picker until it lands: a second pick would race it.
  const [moving, setMoving] = useState(false);
  const machines = (registry.data ?? []).filter((host): host is RuntimePublicDto & { id: string } =>
    host.id !== null && (host.dedicated === true || host.isActive));
  const browsed = browsingId && browsingId !== runtime?.id ? machines.find((host) => host.id === browsingId) ?? null : null;
  const browsedCatalog = useQuery({
    queryKey: queryKeys.runtimeModels(browsed?.id ?? "none"),
    queryFn: () => api.runtimeModels(browsed!.id),
    enabled: browsed !== null && displayedRuntimeHealth(browsed) !== "disconnected",
    staleTime: 30_000,
  });
  const machineLabel = (host: RuntimePublicDto) => host.dedicated
    ? t("newBotDialog.localHost", { host: host.name ?? t("newBotDialog.rulesServerFallback") })
    : t("newBotDialog.defaultExecutionHost", { host: host.name ?? t("newBotDialog.rulesServerFallback") });
  const machineEntries = machines.map((host) => ({
    id: host.id,
    label: machineLabel(host),
    provider: isLocalEngine(host.engine) ? LOCAL_ENGINES[host.engine].provider : null,
  }));


  // The other machine's catalogue cannot be read: the list says why, and offers nothing to pick.
  const browsedNotice = !browsed ? null
    : displayedRuntimeHealth(browsed) === "disconnected" || browsedCatalog.isError ? t("newBotDialog.executionHostUnavailable")
    : browsedCatalog.isLoading ? t("composer.modelLoading") : null;

  const moveTo = (target: RuntimePublicDto & { id: string }, model: string | null) => {
    // Serialized with the model saves, and tracked like them: a send waits
    // for the move, so the next turn never starts on the old machine.
    const before = inFlight.current;
    setMoving(true);
    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        await before;
        const provider = model === null ? null : catalogModelView(browsedCatalog.data?.providers ?? []).groups
          .find((group) => group.models.some((entry) => entry.id === model))?.slug ?? null;
        // One call: the model rides with the move (a separate update would
        // wait for the profile the move queues again).
        let moved: BotDto;
        try {
          moved = await api.moveBot(bot.id, target.dedicated ? target.id : null, model === null ? undefined : { model, provider });
        } catch (error) {
          // The server refuses while the bot still runs a request, and says so.
          toast.error(error instanceof ApiError ? error.message : t("composer.machineMoveFailed"), { id: toastId });
          return;
        }
        setBrowsingId(null);
        // The sync effect skips a bot update while this move holds the slot:
        // the moved bot's model becomes the shown and confirmed one here.
        const landed = selectionFromBot(moved);
        confirmed.current = landed;
        wanted.current = landed;
        setSelection(landed);
        queryClient.setQueryData<RosterDto>(queryKeys.roster, (current) => current
          ? { ...current, bots: current.bots.map((entry) => entry.id === moved.id ? moved : entry) }
          : current);
        toast.success(t("composer.machineMoved", { bot: moved.name, host: target.name ?? machineLabel(target) }), { id: toastId });
        // As `write`: in global mode the worker would ignore the bot's own
        // model. The move stands either way; only this switch is reported.
        if (model !== null && assignment.data?.modelAssignmentMode === "global" && target.selectedModel?.trim()) {
          try {
            await api.saveModelAssignmentMode("per_bot");
          } catch (error) {
            toast.error(error instanceof ApiError ? error.message : t("composer.modelSaveFailed"), { id: `${toastId}-mode` });
          }
          void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
        }
      } finally {
        setMoving(false);
        if (inFlight.current === run) inFlight.current = null;
        void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      }
    })();
    inFlight.current = run;
    trackBotModelSave(bot.id, run);
  };

  return (
    <ComposerModelPicker
      catalogHost={runtime?.name ?? undefined}
      providers={allProviders}
      selectedModel={selection.model}
      effectiveModel={resolved?.model ?? null}
      effectiveEffort={resolved?.effort ?? null}
      efforts={resolved ? view.effortsById.get(resolved.model) : undefined}
      globalModel={globalModel}
      globalAutomatic={globalModelIsAutomatic(runtime)}
      supportsEffort={resolved ? view.reasoningIds.has(resolved.model) : false}
      disabled={disabled}
      variant={variant}
      servedBy={shownFallback}
      // `isLoading`, not `isPending`: a disabled catalog query (runtime without
      // an id) stays pending forever and would pin the chip on "loading".
      loading={host.isPending || catalog.isLoading || assignment.isPending}
      // Never frozen while a model saves (see `flush`); frozen while the bot changes machine.
      saving={moving}
      // A disconnected machine's catalogue is not read at all: unreadable all the same.
      error={Boolean(host.error) || catalog.isError || (!host.isPending && runtime === null) || (runtime !== null && displayedRuntimeHealth(runtime) === "disconnected")}
      onModelChange={(model) => browsed ? moveTo(browsed, model) : selectModel(model)}
      machines={machineEntries}
      machineId={browsed?.id ?? runtime?.id ?? null}
      browsing={browsed ? {
        host: machineLabel(browsed),
        providers: browsedCatalog.data?.providers ?? [],
        globalModel: runtimeGlobalModel(browsed, browsedCatalog.data),
        globalAutomatic: globalModelIsAutomatic(browsed),
        notice: browsedNotice,
      } : null}
      onMachine={(id) => setBrowsingId(id === runtime?.id ? null : id)}
      onClose={() => setBrowsingId(null)}
      onEffortChange={(effort) => setSelection((current) => ({ ...current, effort }))}
      onEffortCommit={(effort) => persist({ ...selection, effort })}
      fast={{
        available: resolved ? view.fastIds.has(resolved.model) : false,
        on: !globalOnly && selection.fast,
        onChange: (on) => persist({ ...selection, fast: on }),
      }}
      onReset={() => persist({ ...selection, effort: null, fast: false })}
      bootBotId={bot.id}
    />
  );
}
