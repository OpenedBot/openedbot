import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RiArrowDownSLine, RiSearchLine, RiSparkling2Fill } from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BotDto,
  RosterDto,
  RuntimeModelProviderDto,
} from "@openedbot/contracts-api";
import {
  DEFAULT_REASONING_EFFORT,
  HERMES_REASONING_EFFORT_LABELS,
  isHermesReasoningEffort,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import { catalogModelView, providerRail, resolveThreadModel, runtimeGlobalModel } from "@/lib/bots/model-catalog";
import {
  cn,
  Dialog,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
  toast,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@openedbot/browser-ui-kit";
import { ProviderIcon, providerLabel } from "./provider-icon";
import { ModelHeaderGlyph, ModelHeaderTooltip } from "./composer-model-header";
import type { RunFallbackServed } from "../lib/run/run-fallback";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./boardui/menu";
import { api, ApiError, queryKeys, runtimesQueryOptions } from "../lib/api";
import { haptics } from "../lib/platform/haptics";
import { useT } from "../lib/i18n";
import { displayedRuntimeHealth } from "../lib/runtime/runtime-health";
import { trackBotModelSave } from "../lib/bots/bot-model-saves";
import { BUTTON } from "./settings/primitives";
import { useOpenSettings } from "../lib/shell/settings-overlay";
import { EffortSlider } from "./effort-slider";

type ModelSelection = {
  model: string | null;
  effort: HermesReasoningEffort | null;
};

/**
 * Le glyphe du template : une marque grise sans pastille, à 30 % du texte (les
 * SVG de boardui.com portent leur gris dans le fichier). `ProviderIcon` garde
 * son composant ; seuls sa teinte et sa taille changent, au bureau.
 */
const PROVIDER_GLYPH = "rounded-none bg-transparent text-text-primary/30";

/** Le rail du template trace OpenAI et Anthropic à 18 px, toutes les autres marques à 20 px. */
const RAIL_GLYPH_18 = new Set(["openai-codex", "openai-api", "anthropic"]);

const sameSelection = (left: ModelSelection, right: ModelSelection) =>
  left.model === right.model && left.effort === right.effort;

const selectionFromBot = (bot: BotDto): ModelSelection => ({
  model: bot.model,
  effort: isHermesReasoningEffort(bot.reasoningEffort) ? bot.reasoningEffort : null,
});


function ModelRadio({
  label,
  detail,
  provider,
  checked,
  disabled,
  onSelect,
  trailing,
  tall = false,
}: {
  label: string;
  detail?: string;
  /** Le fournisseur : son glyphe de 16 px précède le nom, comme le template. */
  provider?: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** Ligne de 44 pt dans la feuille mobile. Le bureau garde ses 36 px. */
  tall?: boolean;
  /** La puce d'effort du modèle choisi. */
  trailing?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex w-full shrink-0 items-center rounded-2lg px-2 transition-colors",
        tall ? "min-h-11 active:bg-background-primary-hover" : "h-9",
        checked ? "bg-background-primary-hover" : "hover:bg-background-primary-hover",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={detail ? `${label} ${detail}` : label}
        title={detail ? `${label} ${detail}` : label}
        disabled={disabled}
        onClick={onSelect}
        className="absolute inset-0 cursor-pointer rounded-2lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring disabled:cursor-not-allowed"
      />
      <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {provider ? <ProviderIcon provider={provider} decorative className={cn("size-4 shrink-0", !tall && PROVIDER_GLYPH)} /> : null}
          <span className="min-w-0 flex-1 truncate text-body-medium whitespace-nowrap">
            <span className="text-text-primary">{label}</span>
            {detail ? <span className="ms-1.5 text-text-tertiary">{detail}</span> : null}
          </span>
          {trailing ? <span className="pointer-events-auto flex shrink-0">{trailing}</span> : null}
        </span>
        <span aria-hidden className="relative flex size-3.5 shrink-0 items-center justify-center rounded-full">
          <span
            className={cn(
              "absolute inset-0 rounded-full border-[0.875px] border-border-button-hover bg-background-primary-default shadow-xs transition-opacity duration-200",
              checked && "opacity-0",
            )}
          />
          <span
            className={cn(
              "absolute inset-0 rounded-full bg-gradient-to-b from-accent-500 to-accent-600 shadow-[inset_0px_0px_0px_0.875px_var(--color-accent-500),inset_0px_1.75px_0px_0px_rgba(255,255,255,0.25)] transition-opacity duration-200",
              !checked && "opacity-0",
            )}
          />
          <span
            className={cn(
              "absolute top-1/2 left-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-control-indicator-background transition-[scale,opacity] duration-200",
              checked ? "scale-100 opacity-100" : "scale-0 opacity-0",
            )}
          />
        </span>
      </span>
    </div>
  );
}

/**
 * Nomme le fournisseur au-dessus de ses modèles : `openai-codex` et
 * `openai-api` partagent la même marque, seul le nom dit lequel répondra.
 */
function ProviderHeading({ provider, name }: { provider: string; name: string }) {
  return (
    <p className="shrink-0 truncate px-2 pt-1 text-caption-1-regular text-text-tertiary">
      {providerLabel(provider, name)}
    </p>
  );
}

function ProviderNotConnectedPanel({ provider, name, onClose }: {
  provider: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const openSettings = useOpenSettings();

  return (
    <div className="flex flex-col items-start gap-3 px-2 py-3">
      <p className="text-body-2-medium text-text-secondary">
        {t("composer.providerNotConnected", { provider: providerLabel(provider, name) })}
      </p>
      <button
        type="button"
        className={BUTTON.secondary}
        onClick={() => {
          onClose();
          openSettings("/settings/models");
        }}
      >
        {t("composer.providerConnectCta")}
      </button>
    </div>
  );
}

/** Partie pure du picker, exportée pour verrouiller son interaction en test. */
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
  variant = "chip",
  servedBy = null,
  onModelChange,
  onEffortChange,
  onEffortCommit,
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
  /** Le déclencheur décrit le mode global, même si un choix permet d'en sortir. */
  globalOnly?: boolean;
  /**
   * `chip` : la puce dans la rangée du composer (bureau), qui s'ouvre vers le
   * haut. `inline` : du texte dans le sous-titre de l'en-tête mobile, qui
   * s'ouvre vers le bas, sans fond ni police machine : le nom du modèle se lit
   * comme un état, pas comme un identifiant.
   * `header` : la pilule de la barre du haut (bureau), « modèle · effort »,
   * qui s'ouvre vers le bas.
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
  const sliderValue = effectiveEffort ?? DEFAULT_REASONING_EFFORT;

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
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const selectedGroup = groups.find((group) => group.models.some((model) => model.id === (selectedModel ?? effectiveModel)))?.slug;
  const [providerTab, setProviderTab] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeTab = providerTab ?? selectedGroup ?? groups[0]?.slug ?? null;
  const activeProvider = rail.find((entry) => entry.slug === activeTab);
  const activeProviderDisconnected = activeProvider?.connected === false;
  const needle = query.trim().toLowerCase();
  // Un autre fournisseur ou une recherche remet la liste en haut, comme le template.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [activeTab, needle]);
  const visibleGroups = needle
    ? groups
        .map((group) => ({ ...group, models: group.models.filter((model) => model.id.toLowerCase().includes(needle)) }))
        .filter((group) => group.models.length > 0)
    : groups.filter((group) => group.slug === activeTab);
  const effortLabel = effectiveEffort !== null
    ? HERMES_REASONING_EFFORT_LABELS[effectiveEffort]
    : t("composer.modelEffortDefault");
  const effortChip = (
    <BuiPopover open={effortOpen} onOpenChange={setEffortOpen}>
      <BuiPopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t("composer.modelEffort")} ${effortLabel}`}
          className="flex shrink-0 cursor-pointer items-center rounded-full bg-background-tertiary-default py-1 ps-2 pe-1 outline-none transition-colors duration-150 hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <span className="text-body-2-medium whitespace-nowrap text-text-secondary">{supportsEffort ? effortLabel : t("boardui.noEffort")}</span>
          {/* Vers la droite fermé, vers le bas quand le panneau est ouvert (BoardUI). */}
          <RiArrowDownSLine
            aria-hidden
            className={cn(
              "size-[18px] shrink-0 text-foreground-icon-secondary transition-transform duration-200",
              !effortOpen && "-rotate-90",
            )}
          />
        </button>
      </BuiPopoverTrigger>
      {/* Le panneau de BoardUI : 266 px sous la puce, rounded-2xl, p-1. La
          ligne d'aide n'apparaît que si elle dit quelque chose (enregistrement,
          pas d'effort). */}
      <BuiPopoverContent side="bottom" align="start" sideOffset={10} collisionPadding={12} className="bui-popover-ref z-[120] w-[266px] rounded-[16px] p-1">
        <EffortSlider
          look="popover"
          value={sliderValue}
          explicit={effectiveEffort !== null}
          disabled={saving || !supportsEffort}
          onChange={onEffortChange}
          onCommit={onEffortCommit}
        />
        {saving || !supportsEffort ? (
          <p className="px-2 pb-1 text-caption-1-regular text-text-secondary">
            {saving ? t("composer.modelSaving") : t("composer.modelNoEffort")}
          </p>
        ) : null}
      </BuiPopoverContent>
    </BuiPopover>
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
            className="ohb-press inline-flex min-h-11 min-w-0 max-w-[14rem] cursor-pointer items-center gap-1 rounded-full bg-background-tertiary-default px-2.5 text-[13px] leading-4 text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
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
          className="flex h-[min(88svh,720px)] max-h-[88svh] flex-col border-0 bg-background-primary-default px-3 pb-[max(0.75rem,var(--ohb-safe-bottom))] text-text-primary"
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
                {t("composer.models", { count: String(modelCount) })}
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
                    detail={globalModel ?? t("composer.modelUnavailable")}
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
            <EffortSlider
              value={sliderValue}
              explicit={effectiveEffort !== null}
              disabled={saving || !supportsEffort}
              onChange={onEffortChange}
              onCommit={onEffortCommit}
            />
            <p className="px-2 pb-1 text-caption-1-regular text-text-secondary">
              {saving
                ? t("composer.modelSaving")
                : supportsEffort
                  ? t("composer.modelEffortHint")
                  : t("composer.modelNoEffort")}
            </p>
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
        ? "ohb-press inline-flex min-w-0 max-w-[12rem] cursor-pointer items-center gap-0.5 rounded-md text-[13px] leading-4 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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
    <section
      aria-label={t("composer.modelSettings")}
      className={cn(
        "relative max-w-full outline-none",
        // Dans la modale, le panneau garde le cadre du popover (bordure, fond
        // un cran plus clair) : sans lui, le rail se fond dans le fond sombre.
        header
          ? "h-[min(26rem,60dvh)] w-full overflow-clip rounded-[20px] border border-border-button-default bg-background-primary-default"
          : "h-[280px] w-[339px]",
      )}
    >
      <div
        role="tablist"
        aria-label={t("boardui.modelProviders")}
        aria-orientation="vertical"
        className="bui-scroll absolute start-0.5 top-0.5 bottom-0.5 w-[42px] overflow-y-auto rounded-[17px] bg-composer-panel-rail-background p-[3px]"
      >
        {/* Infobulle immédiate : le rail n'a que des icônes, et deux fournisseurs y partagent la marque OpenAI. */}
        <TooltipProvider delayDuration={0} skipDelayDuration={0}>
          <div className="flex w-9 flex-col gap-1.5">
            {rail.map((entry) => (
              <Tooltip key={entry.slug}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!needle && entry.slug === activeTab}
                    aria-disabled={entry.connected ? undefined : "true"}
                    aria-label={providerLabel(entry.slug, entry.name)}
                    onClick={() => { setQuery(""); setSearching(false); setProviderTab(entry.slug); }}
                    className={cn(
                      "flex h-[30px] w-9 shrink-0 cursor-pointer items-center justify-center rounded-[50px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                      !needle && entry.slug === activeTab ? "bg-background-tertiary-default" : "hover:bg-background-tertiary-default/50",
                    )}
                  >
                    <ProviderIcon
                      provider={entry.slug}
                      name={entry.name}
                      decorative
                      tagged
                      withTitle={false}
                      className={cn(
                        PROVIDER_GLYPH,
                        RAIL_GLYPH_18.has(entry.slug) ? "size-[18px] [&>svg]:size-[18px]" : "size-5 [&>svg]:size-5",
                        !entry.connected && "opacity-40 grayscale",
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10} className="z-[120]">
                  {entry.connected
                    ? providerLabel(entry.slug, entry.name)
                    : t("composer.providerNotConnectedTooltip", { provider: providerLabel(entry.slug, entry.name) })}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>
      </div>
      <div className="absolute start-[52px] end-2 top-2 bottom-0 flex flex-col">
        <div className="flex h-8 items-center justify-between gap-2 px-0.5">
          {searching ? (
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSearching(false); setQuery(""); } }}
              placeholder={t("boardui.quickSearch")}
              aria-label={t("boardui.quickSearch")}
              className="h-8 min-w-0 flex-1 rounded-full border border-border-button-default bg-[var(--btn-veil)] px-3 text-body-medium text-text-primary caret-accent-500 outline-none placeholder:text-text-tertiary"
            />
          ) : (
            <span className="text-body-medium text-text-tertiary">
              {t("composer.models", { count: String(modelCount) })}
            </span>
          )}
          <button
            type="button"
            onClick={() => { setSearching((value) => !value); setQuery(""); }}
            className={cn(
              "flex cursor-pointer items-center gap-[5px] rounded-[4px] outline-none transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              searching ? "opacity-100" : "opacity-50",
            )}
          >
            {searching ? null : <span className="text-body-medium whitespace-nowrap text-text-secondary">{t("boardui.quickSearch")}</span>}
            <RiSearchLine aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
          </button>
        </div>
        <div className="relative mt-1 flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          role={!needle && activeProviderDisconnected ? undefined : "radiogroup"}
          aria-label={!needle && activeProviderDisconnected ? undefined : t("composer.model")}
          className="bui-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-1"
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
                  label={t("composer.modelGlobal")}
                  detail={globalModel ?? t("composer.modelUnavailable")}
                  checked={selectedModel === null}
                  disabled={saving}
                  onSelect={() => onModelChange(null)}
                  trailing={selectedModel === null ? effortChip : undefined}
                />
              )}
              {visibleGroups.map((group) => (
                <Fragment key={group.slug}>
                  <ProviderHeading provider={group.slug} name={group.name} />
                  {group.models.map((model) => (
                    <ModelRadio
                      key={model.id}
                      label={model.id}
                      provider={group.slug}
                      checked={selectedModel === model.id}
                      disabled={saving}
                      onSelect={() => onModelChange(model.id)}
                      trailing={selectedModel === model.id ? effortChip : undefined}
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
        </div>
      </div>
    </section>
  );

  // La pilule de la barre du haut ouvre une modale : la liste a la place de
  // respirer, au centre, plutôt qu'un panneau accroché à la pilule.
  if (header) {
    return (
      <>
        <ModelHeaderTooltip label={!fallback && effectiveModel && supportsEffort ? `${triggerLabel} · ${effortLabel}` : triggerLabel}>
          {trigger}
        </ModelHeaderTooltip>
        <Dialog
          open={open}
          onClose={closePanel}
          title={t("composer.modelSettings")}
          closeLabel={t("common.close")}
          className="sm:max-w-[560px]"
          bodyClassName="px-2 pt-2 pb-2"
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
        // Le focus par défaut irait au premier onglet du rail et ouvrirait son
        // infobulle sans survol : on le pose sur le modèle coché.
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
 * Contrôle du prochain run : il partage le catalogue des réglages, mais écrit
 * directement la préférence du bot pour que le choix fait au composer soit
 * celui que le worker résoudra réellement.
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
  /** Voir `ComposerModelPicker` : puce du composer, texte du sous-titre mobile, ou pilule de la barre du haut. */
  variant?: "chip" | "inline" | "header";
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  // Relus au retour sur l'onglet : la préférence globale se change dans
  // Réglages → Modèles, souvent dans un autre onglet, et l'app ne refetch pas
  // au focus par défaut (query-client.ts). Ici rien ne stream, rien ne clignote.
  const runtimes = useQuery({ ...runtimesQueryOptions(), refetchOnWindowFocus: true });
  // Le mode d'attribution vit sur l'organisation, pas sur le runtime : même
  // entrée de cache que `runtimes` ci-dessus, lue sans `select`.
  const assignment = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    refetchOnWindowFocus: true,
  });
  // Le picker propose le catalogue entier ; un choix par bot fait passer
  // l'organisation en mode « Par bot » dans `write`.
  const globalOnly = assignment.data?.modelAssignmentMode === "global";
  const runtime = runtimes.data?.runtimes[0] ?? null;
  const catalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtime?.id ?? "none"),
    queryFn: () => api.runtimeModels(runtime!.id!),
    // Lien fermé : le catalogue ne répondrait que 503 ; il reprend à la réouverture.
    enabled: Boolean(runtime?.id) && displayedRuntimeHealth(runtime) !== "disconnected",
    // Aligné sur le cache serveur (30 s) : rouvrir une conversation ne rejoue
    // pas un aller jusqu'à l'hôte, et le sélecteur rend sa section sans bloquer le fil.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const view = useMemo(() => catalogModelView(catalog.data?.providers ?? []), [catalog.data?.providers]);
  const globalModel = runtimeGlobalModel(runtime, catalog.data);
  // Changement instantané : le choix affiché fait foi dès le clic, le serveur
  // suit derrière. Rien ne se fige pendant l'enregistrement, un seul aller part
  // à la fois et le dernier choix demandé gagne toujours : une réponse
  // périmée ne ramène jamais l'affichage en arrière.
  const [selection, setSelection] = useState<ModelSelection>(() => selectionFromBot(bot));
  /** Dernier état confirmé par le serveur : la base de « n'envoyer que ce qui change ». */
  const confirmed = useRef<ModelSelection>(selection);
  /** Dernier choix demandé, en vol ou en attente. Comparé par identité. */
  const wanted = useRef<ModelSelection>(selection);
  const inFlight = useRef<Promise<void> | null>(null);
  const toastId = `composer-model-${bot.id}`;

  const write = async (next: ModelSelection): Promise<BotDto> => {
    // L'effort seul n'est qu'une ligne en base. Joindre le modèle ferait
    // passer l'API par l'hôte Hermes (liste des modèles, profil) avant de
    // répondre : `modelChanged` dans `bot-input.ts`.
    const updated = await api.updateBot(bot.id, next.model === confirmed.current.model
      ? { reasoningEffort: next.effort }
      : {
          model: next.model,
          provider: view.groups.find((group) => group.models.some((entry) => entry.id === next.model))?.slug ?? null,
          reasoningEffort: next.effort,
        });
    // En mode global, le worker ignorerait ce choix : un modèle ou un effort
    // posé ici fait passer l'organisation en « Par bot » pour qu'il serve.
    if (globalOnly && (next.model !== null || next.effort !== null)) {
      await api.saveModelAssignmentMode("per_bot");
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
    }
    return updated;
  };

  const flush = (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        // Les choix faits pendant un aller attendent sa fin, puis seul le
        // dernier part : les intermédiaires ne valent plus rien.
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
            // Plus rien en attente : l'affichage prend la forme confirmée
            // (le serveur peut normaliser, un effort nul par exemple).
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
    // Une mise à jour du bot venue d'ailleurs (autre onglet, Réglages). Pendant
    // un enregistrement, c'est notre propre écriture : on ne la rejoue pas.
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
  }, [bot.id, bot.model, bot.reasoningEffort]);

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
      supportsEffort={resolved ? view.reasoningIds.has(resolved.model) : false}
      disabled={disabled}
      variant={variant}
      servedBy={shownFallback}
      // `isLoading`, not `isPending`: a disabled catalog query (runtime without
      // an id) stays pending forever and would pin the chip on "loading".
      loading={runtimes.isPending || catalog.isLoading || assignment.isPending}
      // Jamais figé pendant l'enregistrement : voir `flush`.
      saving={false}
      error={runtimes.isError || catalog.isError || (!runtimes.isPending && runtime === null)}
      onModelChange={selectModel}
      onEffortChange={(effort) => setSelection((current) => ({ ...current, effort }))}
      onEffortCommit={(effort) => persist({ model: selection.model, effort })}
    />
  );
}
