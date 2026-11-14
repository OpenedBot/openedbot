import { Fragment, useEffect, useState, type ReactNode, type RefObject } from "react";
import { RiSearchLine } from "@remixicon/react";
import { cn, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit";
import type { ModelGroup, ProviderRailEntry } from "@/lib/bots/model-catalog";
import { useT } from "../lib/i18n";
import { ProviderIcon, providerLabel } from "./provider-icon";
import { ModelRadio, PROVIDER_GLYPH, ProviderHeading, ProviderNotConnectedPanel } from "./composer-model-picker-panels";

/** The template's rail draws OpenAI and Anthropic at 18 px, every other mark at 20 px. */
const RAIL_GLYPH_18 = new Set(["openai-codex", "openai-api", "anthropic"]);

/**
 * The desktop model catalogue: the provider rail (brand marks, one tab
 * each) beside the chosen provider's models, with a quick search across
 * every provider. Shared by the composer chip, the top bar's modal and the
 * settings fields (Réglages › Modèles, « Un par bot »), so a model is
 * picked the same way wherever it is picked.
 *
 * Its search and tab live here: the panel unmounts when its popover or
 * modal closes, so each opening starts on the chosen model's provider.
 */
export function ModelCatalogPanel({
  layout,
  groups,
  rail,
  selectedModel,
  openOnModel = selectedModel,
  globalLabel,
  globalDetail,
  disabled,
  onModelChange,
  trailing,
  onClose,
  listRef,
  className,
}: {
  /**
   * `popover`: the composer's floating panel, the rail in its own pill.
   * `flat`: sits on a card (the top bar's modal, a settings field's
   * popover): hairlines instead of fills.
   */
  layout: "popover" | "flat";
  groups: ModelGroup[];
  rail: ProviderRailEntry[];
  selectedModel: string | null;
  /** The model whose provider tab opens first: the effective one when `selectedModel` follows the default. */
  openOnModel?: string | null;
  /** The first row, `null`: follow the default (global) model. */
  globalLabel: string;
  globalDetail: string;
  disabled: boolean;
  onModelChange: (model: string | null) => void;
  /** Placed at the end of the checked row (the composer's effort chip). */
  trailing?: ReactNode;
  onClose: () => void;
  listRef?: RefObject<HTMLDivElement | null>;
  /** The panel's size. */
  className?: string;
}) {
  const { t } = useT();
  const flat = layout === "flat";
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [providerTab, setProviderTab] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.models.some((model) => model.id === openOnModel))?.slug;
  const activeTab = providerTab ?? selectedGroup ?? groups[0]?.slug ?? null;
  const activeProvider = rail.find((entry) => entry.slug === activeTab);
  const needle = query.trim().toLowerCase();
  const showNotConnected = !needle && activeProvider?.connected === false;
  // Another provider or a search puts the list back at the top, as in the template.
  useEffect(() => {
    if (listRef?.current) listRef.current.scrollTop = 0;
  }, [activeTab, needle, listRef]);
  const visibleGroups = needle
    ? groups
        .map((group) => ({ ...group, models: group.models.filter((model) => model.id.toLowerCase().includes(needle)) }))
        .filter((group) => group.models.length > 0)
    : groups.filter((group) => group.slug === activeTab);

  return (
    <section
      aria-label={t("composer.modelSettings")}
      className={cn(
        "relative max-w-full outline-none",
        flat && "overflow-clip",
        className,
      )}
    >
      <div
        role="tablist"
        aria-label={t("boardui.modelProviders")}
        aria-orientation="vertical"
        className={cn(
          "bui-scroll absolute overflow-y-auto",
          flat
            ? "start-0 top-0 bottom-0 w-[52px] border-e border-border/60 px-2 py-2"
            : "start-0.5 top-0.5 bottom-0.5 w-[42px] rounded-[17px] bg-composer-panel-rail-background p-[3px]",
        )}
      >
        {/* Instant tooltip: the rail has only icons, and two providers there share the OpenAI mark. */}
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
                      // On a card the tertiary fill is the card's colour in
                      // dark, so the chosen tab takes a veil of the text colour instead.
                      !needle && entry.slug === activeTab
                        ? flat ? "bg-foreground/10" : "bg-background-tertiary-default"
                        : flat ? "hover:bg-foreground/5" : "hover:bg-background-tertiary-default/50",
                    )}
                  >
                    <ProviderIcon
                      provider={entry.slug}
                      name={entry.name}
                      decorative
                      tagged
                      withTitle={false}
                      colored
                      className={cn(
                        PROVIDER_GLYPH,
                        RAIL_GLYPH_18.has(entry.slug) ? "size-[18px] [&>svg]:size-[18px]" : "size-5 [&>svg]:size-5",
                        // Not connected: its colour, faded, not greyed: the brand
                        // stays recognisable, the tooltip says it must be connected.
                        !entry.connected && "opacity-45",
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
      <div className={cn("absolute bottom-0 flex flex-col", flat ? "start-[52px] end-0 top-0" : "start-[52px] end-2 top-2")}>
        <div className={cn("flex items-center justify-between gap-2", flat ? "h-11 shrink-0 border-b border-border/60 px-3" : "h-8 px-0.5")}>
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
              {t("composer.models")}
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
        <div className={cn("relative flex min-h-0 flex-1 flex-col", flat ? "px-1.5 pt-1.5" : "mt-1")}>
          <div
            ref={listRef}
            role={showNotConnected ? undefined : "radiogroup"}
            aria-label={showNotConnected ? undefined : t("composer.model")}
            className="bui-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-1"
          >
            {showNotConnected ? (
              <ProviderNotConnectedPanel provider={activeProvider.slug} name={activeProvider.name} onClose={onClose} />
            ) : (
              <>
                {needle ? null : (
                  <ModelRadio
                    label={globalLabel}
                    detail={globalDetail}
                    checked={selectedModel === null}
                    disabled={disabled}
                    onSelect={() => onModelChange(null)}
                    trailing={selectedModel === null ? trailing : undefined}
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
                        disabled={disabled}
                        fastAvailable={model.fast}
                        onSelect={() => onModelChange(model.id)}
                        trailing={selectedModel === model.id ? trailing : undefined}
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
}
