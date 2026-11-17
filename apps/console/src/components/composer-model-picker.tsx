import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BotDto,
  RosterDto,
} from "@openedbot/contracts-api";
import {
  isHermesReasoningEffort,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import { catalogModelView, globalModelIsAutomatic, resolveThreadModel, runtimeGlobalModel } from "@/lib/bots/model-catalog";
import { toast } from "@openedbot/browser-ui-kit";
import type { RunFallbackServed } from "../lib/run/run-fallback";
import { api, ApiError, queryKeys, runtimesQueryOptions } from "../lib/api";
import { useT } from "../lib/i18n";
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
export function ThreadModelPicker({
  bot,
  disabled = false,
  variant = "chip",
  servedBy = null,
}: {
  bot: BotDto;
  /** See `ComposerModelPicker`: the fallback that served the bot's last turn. */
  servedBy?: RunFallbackServed | null;
  disabled?: boolean;
  /** See `ComposerModelPicker`: composer chip, mobile subtitle text, or top-bar pill. */
  variant?: "chip" | "inline" | "header";
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  // Reread on return to the tab: the global preference is changed in
  // Réglages → Modèles, often in another tab, and the app does not refetch
  // on focus by default (query-client.ts). Here nothing streams, nothing flickers.
  const runtimes = useQuery({ ...runtimesQueryOptions(), refetchOnWindowFocus: true });
  // The assignment mode lives on the organization, not on the runtime: the same
  // cache entry as `runtimes` above, read without `select`.
  const assignment = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    refetchOnWindowFocus: true,
  });
  // The picker offers the whole catalogue; a per-bot choice switches
  // the organization to « Par bot » mode in `write`.
  const runtime = runtimes.data?.runtimes[0] ?? null;
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
    const run = (async () => {
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
        inFlight.current = null;
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
        ? selection.effort
        : null,
      // The wish is kept across models: it shows, and applies, again on a
      // model that offers it.
      fast: selection.fast,
    });
  };

  const allProviders = catalog.data?.providers ?? [];

  return (
    <ComposerModelPicker
      providers={allProviders}
      selectedModel={selection.model}
      effectiveModel={resolved?.model ?? null}
      effectiveEffort={resolved?.effort ?? null}
      globalModel={globalModel}
      globalAutomatic={globalModelIsAutomatic(runtime)}
      supportsEffort={resolved ? view.reasoningIds.has(resolved.model) : false}
      disabled={disabled}
      variant={variant}
      servedBy={shownFallback}
      // `isLoading`, not `isPending`: a disabled catalog query (runtime without
      // an id) stays pending forever and would pin the chip on "loading".
      loading={runtimes.isPending || catalog.isLoading || assignment.isPending}
      // Never frozen while saving: see `flush`.
      saving={false}
      error={runtimes.isError || catalog.isError || (!runtimes.isPending && runtime === null)}
      onModelChange={selectModel}
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
