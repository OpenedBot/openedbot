import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownSLine, RiSearchLine } from "@remixicon/react";
import type { RuntimeModelProviderDto } from "@openedbot/contracts-api";
import type { HermesReasoningEffort } from "@openedbot/contracts-api";
import { catalogModelView, providerRail } from "@/lib/bots/model-catalog";
import {
  cn,
  Dialog,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@openedbot/browser-ui-kit";
import { ProviderIcon, providerLabel } from "./provider-icon";
import { ModelHeaderGlyph } from "./composer-model-header";
import type { RunFallbackServed } from "../lib/run/run-fallback";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./boardui/menu";
import { haptics } from "../lib/platform/haptics";
import { useT } from "../lib/i18n";
import { rememberBootBot } from "../lib/session/boot-bots";
import { readCloudSession } from "../lib/session/cloud-session";
import { EffortChip, EffortPanel, FastBoltSlot, type FastModeControl } from "./composer-effort-chip";
import { ModelRadio, ProviderHeading, ProviderNotConnectedPanel } from "./composer-model-picker-panels";
import { ModelCatalogPanel } from "./model-catalog-panel";

/**
 * The template's glyph: a grey mark with no chip, at 30% of the text (the
 * SVGs from boardui.com carry their grey in the file). `ProviderIcon` keeps
 * its component; only its tint and its size change, on desktop.
 */

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
  bootBotId,
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
  /** The bot whose model mark the next refresh redraws at once (`lib/session/boot-bots.ts`). */
  bootBotId?: string;
}) {
  const { t } = useT();
  const glyphRef = useRef<HTMLSpanElement>(null);
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
  // The mark as drawn now, for the composer the next refresh paints before
  // any read answers. Only a settled reading: a loading spark is not the mark.
  const settledGlyph = header && bootBotId && !loading && !error;
  useEffect(() => {
    if (!settledGlyph || !glyphRef.current) return;
    rememberBootBot(readCloudSession()?.userId, bootBotId, { glyph: glyphRef.current.innerHTML, provider: triggerProvider });
  }, [settledGlyph, bootBotId, triggerProvider, unchosen, fallback]);
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
        <span ref={glyphRef} className="contents">
          <ModelHeaderGlyph provider={triggerProvider} warn={unchosen || !!fallback} fallback={!!fallback} />
        </span>
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
