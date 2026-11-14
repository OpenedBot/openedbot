import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RiArrowDownSLine, RiSearchLine, RiSparkling2Fill } from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BotDto,
  RosterDto,
  RuntimeModelProviderDto,
} from "@openedbot/contracts-api";
import {
  isHermesReasoningEffort,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import { catalogModelView, globalModelIsAutomatic, providerRail, resolveThreadModel, runtimeGlobalModel } from "@/lib/bots/model-catalog";
import {
  cn,
  Dialog,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
  toast,
} from "@openedbot/browser-ui-kit";
import { ProviderIcon, providerLabel } from "./provider-icon";
import { ModelHeaderGlyph } from "./composer-model-header";
import type { RunFallbackServed } from "../lib/run/run-fallback";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./boardui/menu";
import { api, ApiError, queryKeys, runtimesQueryOptions } from "../lib/api";
import { haptics } from "../lib/platform/haptics";
import { useT } from "../lib/i18n";
import { displayedRuntimeHealth } from "../lib/runtime/runtime-health";
import { trackBotModelSave } from "../lib/bots/bot-model-saves";
import { EffortChip, EffortPanel, FastBoltSlot, type FastModeControl } from "./composer-effort-chip";
import { ModelRadio, ProviderHeading, ProviderNotConnectedPanel } from "./composer-model-picker-panels";
import { ModelCatalogPanel } from "./model-catalog-panel";

type ModelSelection = {
  model: string | null;
  effort: HermesReasoningEffort | null;
  /** The bot's fast-mode wish; the worker honours it only on a fast model. */
  fast: boolean;
};

/**
 * The template's glyph: a grey mark with no chip, at 30% of the text (the
 * SVGs from boardui.com carry their grey in the file). `ProviderIcon` keeps
 * its component; only its tint and its size change, on desktop.
 */


const sameSelection = (left: ModelSelection, right: ModelSelection) =>
  left.model === right.model && left.effort === right.effort && left.fast === right.fast;

const selectionFromBot = (bot: BotDto): ModelSelection => ({
  model: bot.model,
  effort: isHermesReasoningEffort(bot.reasoningEffort) ? bot.reasoningEffort : null,
  fast: bot.fastMode === true,
});


/**
 * Names the provider above its models: `openai-codex` and
 * `openai-api` share the same mark, only the name says which one will answer.
 */
/** The picker's pure part, exported to lock its interaction in tests. */
export function ComposerModelPicker({
  providers,
  selectedModel,
  effectiveModel,
  effectiveEffort,
  globalModel,
  supportsEffort,
  disabled,
  loading,
  saving,
  error,
  globalOnly = false,
  globalAutomatic = false,
  variant = "chip",
  servedBy = null,
  onModelChange,
  onEffortChange,
  onEffortCommit,
  fast,
  onReset,
}: {
  providers: RuntimeModelProviderDto[];
  selectedModel: string | null;
  effectiveModel: string | null;
  effectiveEffort: HermesReasoningEffort | null;
  globalModel: string | null;
  supportsEffort: boolean;
  disabled: boolean;
  loading: boolean;
  saving: boolean;
  error: boolean;
  /** The trigger describes the global mode, even if a choice lets one leave it. */
  globalOnly?: boolean;
  /**
   * The global model is no preference of the operator's: openedbot or the host
   * picked it (`automaticModel`). The « Modèle global » row says « Auto ».
   */
  globalAutomatic?: boolean;
  /**
   * `chip`: the chip in the composer's row (desktop), which opens upward.
   * `inline`: text in the mobile header's subtitle, which
   * opens downward, with no background and no monospace face: the model name reads
   * as a state, not as an identifier.
   * `header`: the top bar's pill (desktop), « modèle · effort »,
   * which opens downward.
   */
  variant?: "chip" | "inline" | "header";
  /**
   * Who served the bot's last turn when the worker moved it off the
   * configured provider (`latestRunFallback`). The trigger then names that
   * model with a « fallback » mark; the setting and the list stay the
   * configured ones.
   */
  servedBy?: RunFallbackServed | null;
  onModelChange: (model: string | null) => void;
  onEffortChange: (effort: HermesReasoningEffort) => void;
  onEffortCommit: (effort: HermesReasoningEffort) => void;
  /** The chosen model's fast mode; absent where it cannot be saved (a bot draft). */
  fast?: FastModeControl;
  /** Back to the default effort and normal speed. */
  onReset?: () => void;
}) {
  const { t } = useT();
  const groups = useMemo(
    () => catalogModelView(providers, [selectedModel, effectiveModel, globalModel]).groups,
    [providers, selectedModel, effectiveModel, globalModel],
  );
  const rail = providerRail(providers);
  const modelCount = groups.reduce((total, group) => total + group.models.length, 0);
  const unavailable = disabled || loading || error || modelCount === 0;
  const emptyCatalog = !loading && modelCount === 0;

  const inline = variant === "inline";
  const header = variant === "header";
  // "Loading" only while a request is in flight. Loaded without a model (the
  // bot has none of its own, the runtime names none): ask for one rather than
  // pretend something is still coming.
  const unchosen = !loading && !error && !emptyCatalog && effectiveModel === null;
  // The last turn ran elsewhere: say so on the trigger, without touching
  // the setting. Same model under another provider is still a fallback.
  const fallback = servedBy && !loading && !error ? servedBy : null;
  const triggerLabel = fallback?.model ?? effectiveModel ?? t(
    error || emptyCatalog ? "composer.modelUnavailable" : unchosen ? "composer.modelChoose" : "composer.modelLoading",
  );
  const triggerProvider = fallback?.provider ?? groups.find((group) => group.models.some((model) => model.id === effectiveModel))?.slug ?? null;
  const fallbackTitle = fallback
    ? t("composer.modelFallbackTitle", {
      provider: providerLabel(fallback.provider),
      model: fallback.model,
      configured: effectiveModel ?? t("composer.modelChoose"),
    })
    : undefined;
  const fallbackBadge = fallback ? (
    <span
      data-model-fallback=""
      className="shrink-0 rounded-full bg-warn-soft px-1.5 text-caption-1-regular leading-4 text-warn-700"
    >
      {t("composer.modelFallbackBadge")}
    </span>
  ) : null;
  const pickerAria = (globalOnly
    ? t("composer.modelPickerGlobalAria", { model: effectiveModel ?? t(unchosen ? "composer.modelChoose" : "composer.modelUnavailable") })
    : t("composer.modelPickerAria", { model: effectiveModel ?? t(unchosen ? "composer.modelChoose" : "composer.modelUnavailable") }))
    + (fallbackTitle ? `. ${fallbackTitle}` : "");
  const globalDetail = globalModel === null
    ? t("composer.modelUnavailable")
    : globalAutomatic ? t("composer.modelGlobalAuto", { model: globalModel }) : globalModel;
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const selectedGroup = groups.find((group) => group.models.some((model) => model.id === (selectedModel ?? effectiveModel)))?.slug;
  const [providerTab, setProviderTab] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeTab = providerTab ?? selectedGroup ?? groups[0]?.slug ?? null;
  const activeProvider = rail.find((entry) => entry.slug === activeTab);
  const activeProviderDisconnected = activeProvider?.connected === false;
  const needle = query.trim().toLowerCase();
  // Another provider or a search puts the list back at the top, as in the template.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [activeTab, needle]);
  const visibleGroups = needle
    ? groups
        .map((group) => ({ ...group, models: group.models.filter((model) => model.id.toLowerCase().includes(needle)) }))
        .filter((group) => group.models.length > 0)
    : groups.filter((group) => group.slug === activeTab);
  const fastOn = Boolean(fast?.available && fast.on);
  const effortChip = (
    <EffortChip
      effort={effectiveEffort}
      supportsEffort={supportsEffort}
      saving={saving}
      fast={fast}
      onReset={onReset}
      onEffortChange={onEffortChange}
      onEffortCommit={onEffortCommit}
    />
  );

  if (inline) {
    return (
      <Drawer
        open={open}
        shouldScaleBackground={false}
        onOpenChange={(next) => {
          if (next) haptics.light();
          setOpen(next);
          if (!next) {
            setSearching(false);
            setQuery("");
            setProviderTab(null);
          }
        }}
      >
        <DrawerTrigger asChild>
          <button
            data-composer-model-picker=""
            data-variant="inline"
            type="button"
            disabled={unavailable}
            aria-label={pickerAria}
            title={fallbackTitle}
            className="openedbot-press inline-flex min-h-11 min-w-0 max-w-[14rem] cursor-pointer items-center gap-1 rounded-full bg-background-tertiary-default px-2.5 text-[13px] leading-4 text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FastBoltSlot on={fastOn && !fallback} />
            <span className={cn("truncate whitespace-nowrap", (unchosen || fallback) && "text-warn-700")}>{triggerLabel}</span>
            {fallbackBadge}
            <RiArrowDownSLine
              aria-hidden
              className={cn("size-3.5 shrink-0 text-foreground-icon-secondary transition-transform duration-200", open && "rotate-180")}
            />
          </button>
        </DrawerTrigger>
        <DrawerContent
          aria-label={t("composer.modelSettings")}
          className="flex h-[min(88svh,720px)] max-h-[88svh] flex-col border-0 bg-background-primary-default px-3 pb-[max(0.75rem,var(--openedbot-safe-bottom))] text-text-primary"
          style={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}
        >
          <DrawerTitle className="sr-only">{t("composer.modelSettings")}</DrawerTitle>
          <div className="flex h-11 items-center justify-between gap-2 px-1">
            {searching ? (
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSearching(false); setQuery(""); } }}
                placeholder={t("boardui.quickSearch")}
                aria-label={t("boardui.quickSearch")}
                className="min-w-0 flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-tertiary"
              />
            ) : (
              <span className="text-body-medium text-text-tertiary">
                {t("composer.models")}
              </span>
            )}
            <button
              type="button"
              onClick={() => { setSearching((value) => !value); setQuery(""); }}
              className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiSearchLine aria-hidden className="size-5 text-foreground-icon-secondary" />
            </button>
          </div>
          <div
            role="tablist"
            aria-label={t("boardui.modelProviders")}
            aria-orientation="horizontal"
            className="flex gap-2 overflow-x-auto px-1 pb-2"
          >
            {rail.map((entry) => (
              <button
                key={entry.slug}
                type="button"
                role="tab"
                aria-selected={!needle && entry.slug === activeTab}
                aria-disabled={entry.connected ? undefined : "true"}
                aria-label={providerLabel(entry.slug, entry.name)}
                title={entry.connected
                  ? providerLabel(entry.slug, entry.name)
                  : t("composer.providerNotConnectedTooltip", { provider: providerLabel(entry.slug, entry.name) })}
                onClick={() => { setQuery(""); setSearching(false); setProviderTab(entry.slug); }}
                className={cn(
                  "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                  !needle && entry.slug === activeTab ? "bg-background-tertiary-default" : "active:bg-background-tertiary-default",
                )}
              >
                <ProviderIcon
                  provider={entry.slug}
                  name={entry.name}
                  decorative
                  tagged
                  withTitle={false}
                  className={cn("size-5", !entry.connected && "opacity-40 grayscale")}
                />
              </button>
            ))}
          </div>
          <div
            role={!needle && activeProviderDisconnected ? undefined : "radiogroup"}
            aria-label={!needle && activeProviderDisconnected ? undefined : t("composer.model")}
            className="bui-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2"
          >
            {!needle && activeProviderDisconnected ? (
              <ProviderNotConnectedPanel
                provider={activeProvider.slug}
                name={activeProvider.name}
                onClose={() => setOpen(false)}
              />
            ) : (
              <>
                {needle ? null : (
                  <ModelRadio
                    tall
                    label={t("composer.modelGlobal")}
                    detail={globalDetail}
                    checked={selectedModel === null}
                    disabled={saving}
                    onSelect={() => onModelChange(null)}
                  />
                )}
                {visibleGroups.map((group) => (
                  <Fragment key={group.slug}>
                    <ProviderHeading provider={group.slug} name={group.name} />
                    {group.models.map((model) => (
                      <ModelRadio
                        key={model.id}
                        tall
                        label={model.id}
                        provider={group.slug}
                        checked={selectedModel === model.id}
                        disabled={saving}
                        onSelect={() => onModelChange(model.id)}
                      />
                    ))}
                  </Fragment>
                ))}
                {needle && visibleGroups.length === 0 ? (
                  <p className="px-2 py-3 text-body-2-medium text-text-tertiary">{t("boardui.noModelMatch")}</p>
                ) : null}
              </>
            )}
          </div>
          <div data-composer-effort="" className="border-t border-border-button-default pt-2">
            <EffortPanel
              look="sheet"
              effort={effectiveEffort}
              supportsEffort={supportsEffort}
              saving={saving}
              fast={fast}
              onReset={onReset}
              onEffortChange={onEffortChange}
              onEffortCommit={onEffortCommit}
            />
            {!saving && supportsEffort ? (
              <p className="px-2 pb-1 text-caption-1-regular text-text-secondary">{t("composer.modelEffortHint")}</p>
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  const closePanel = () => {
    setOpen(false);
    setSearching(false);
    setQuery("");
    setProviderTab(null);
  };
  const trigger = (
    <button
      data-composer-model-picker=""
      data-variant={inline ? "inline" : header ? "header" : undefined}
      type="button"
      onClick={header ? () => setOpen(true) : undefined}
      disabled={unavailable}
      aria-label={pickerAria}
      title={fallbackTitle}
      className={inline
        ? "openedbot-press inline-flex min-w-0 max-w-[12rem] cursor-pointer items-center gap-0.5 rounded-md text-[13px] leading-4 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        : header
        ? cn(
            "flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-border-button-default bg-background-primary-default outline-none transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50",
            open && "bg-background-primary-hover",
          )
        : cn(
            "flex h-11 max-w-[11rem] shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-xl bg-background-primary-default py-1.5 ps-2 pe-1 outline-none transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:max-w-[15rem]",
            open && "bg-background-primary-hover",
          )}
    >
      {inline ? (
        <>
          <span className={cn("truncate whitespace-nowrap", (unchosen || fallback) && "text-warn-700")}>{triggerLabel}</span>
          {fallbackBadge}
        </>
      ) : header ? (
        <ModelHeaderGlyph provider={triggerProvider} warn={unchosen || !!fallback} fallback={!!fallback} />
      ) : (
        <>
          <FastBoltSlot on={fastOn && !fallback} />
          <span className={cn("truncate px-0.5 text-body-medium whitespace-nowrap", unchosen || fallback ? "text-warn-700" : "text-text-secondary")}>{triggerLabel}</span>
          {fallbackBadge}
        </>
      )}
      {header ? null : (
        <RiArrowDownSLine
          aria-hidden
          className={cn("shrink-0 text-foreground-icon-secondary transition-transform duration-200", inline ? "size-3.5" : "size-[18px]", open && "rotate-180")}
        />
      )}
    </button>
  );
  const panel = (
    <ModelCatalogPanel
      // In the modal, the panel sits flat in the dialog's card (`DESIGN.md`
      // › Bureau › Carte, Cloudflare's LayerDialog): no frame of its own, a
      // hairline under the title, the rail as a column beside the list.
      layout={header ? "flat" : "popover"}
      className={header ? "mt-3 h-[min(26rem,60dvh)] w-full border-t border-border/60" : "h-[280px] w-[339px]"}
      groups={groups}
      rail={rail}
      selectedModel={selectedModel}
      openOnModel={selectedModel ?? effectiveModel}
      globalLabel={t("composer.modelGlobal")}
      globalDetail={globalDetail}
      disabled={saving}
      onModelChange={onModelChange}
      trailing={effortChip}
      onClose={() => setOpen(false)}
      listRef={listRef}
    />
  );

  // The top bar's pill opens a modal: the list has room to
  // breathe, in the centre, rather than a panel stuck to the pill.
  if (header) {
    return (
      <>
        {trigger}
        <Dialog
          open={open}
          onClose={closePanel}
          title={t("composer.modelSettings")}
          closeLabel={t("common.close")}
          className="sm:max-w-[560px]"
          bodyClassName="p-0"
        >
          {panel}
        </Dialog>
      </>
    );
  }

  return (
    <BuiPopover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else closePanel();
      }}
    >
      <BuiPopoverTrigger asChild>
        {trigger}
      </BuiPopoverTrigger>
      <BuiPopoverContent
        side={inline || header ? "bottom" : "top"}
        align={inline ? "start" : "end"}
        sideOffset={8}
        collisionPadding={12}
        className="bui-popover-ref bui-popover-ref-panel overflow-clip p-0"
        // The default focus would land on the rail's first tab and open its
        // tooltip with no hover: it is placed on the checked model.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const list = listRef.current;
          (list?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? list?.querySelector<HTMLElement>('[role="radio"]'))?.focus();
        }}
      >
        {panel}
      </BuiPopoverContent>
    </BuiPopover>
  );
}

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
    />
  );
}
