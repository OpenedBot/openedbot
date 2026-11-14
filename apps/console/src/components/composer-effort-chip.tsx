import { useRef, useState } from "react";
import { RiArrowDownSLine, RiFlashlightFill, RiResetLeftLine } from "@remixicon/react";
import {
  DEFAULT_REASONING_EFFORT,
  HERMES_REASONING_EFFORTS,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import { cn, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./boardui/menu";
import { EffortSlider } from "./effort-slider";
import { effortLabel } from "../lib/bots/effort-label";
import { useT } from "../lib/i18n";

/**
 * The effort chip of the checked model row and its panel, after
 * streaming-ui.pulseview.app/components/model-picker: the bolt of the fast
 * mode, « Effort <level> » (« Rapide <level> » once fast), the reset, the
 * billing note, then the Faster → Smarter slider.
 */

export type FastModeControl = {
  /** The chosen model offers it (Hermes `capabilities.fast`). */
  available: boolean;
  /** Asked for by the bot; shown as on only where available. */
  on: boolean;
  onChange: (on: boolean) => void;
};

/**
 * The bolt slid in by width (grid 0fr → 1fr), not inserted: what follows it,
 * and a popover anchored there, glide instead of jumping when fast flips.
 */
export function FastBoltSlot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid transition-[grid-template-columns,opacity,filter] duration-200 ease-out",
        on ? "grid-cols-[1fr] opacity-100 blur-0" : "grid-cols-[0fr] opacity-0 blur-[2px]",
        className,
      )}
    >
      <span className="min-w-0 overflow-hidden">
        <RiFlashlightFill className="me-0.5 size-3.5 text-accent-500" />
      </span>
    </span>
  );
}

/**
 * Every label stacked in one grid cell, only the current one visible: the
 * chip keeps the width of the longest, so moving the slider never resizes it
 * or shifts what is anchored to it.
 */
function EffortLabelStack({ effort, className }: { effort: HermesReasoningEffort | null; className?: string }) {
  const { t } = useT();
  const labels: Array<[HermesReasoningEffort | null, string]> = [
    [null, t("composer.modelEffortDefault")],
    ...HERMES_REASONING_EFFORTS.map((level): [HermesReasoningEffort, string] => [level, effortLabel(t, level)]),
  ];
  return (
    <span className={cn("inline-grid", className)}>
      {labels.map(([level, label]) => (
        <span
          key={level ?? "default"}
          aria-hidden={level !== effort}
          className={cn(
            "col-start-1 row-start-1 whitespace-nowrap transition-[opacity,filter] duration-150 ease-out",
            level === effort ? "opacity-100 blur-0" : "opacity-0 blur-[2px]",
          )}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

/** The panel's content: shared by the chip's popover and the mobile sheet. */
export function EffortPanel({
  effort,
  supportsEffort,
  saving,
  fast,
  onReset,
  look,
  onEffortChange,
  onEffortCommit,
}: {
  /** `null`: the runtime decides (« Par défaut »). */
  effort: HermesReasoningEffort | null;
  supportsEffort: boolean;
  saving: boolean;
  fast?: FastModeControl;
  /** Back to the default effort and normal speed; absent, no reset button. */
  onReset?: () => void;
  look: "popover" | "sheet";
  onEffortChange: (effort: HermesReasoningEffort) => void;
  onEffortCommit: (effort: HermesReasoningEffort) => void;
}) {
  const { t } = useT();
  const fastOn = Boolean(fast?.available && fast.on);
  const label = effort === null ? t("composer.modelEffortDefault") : effortLabel(t, effort);
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <section aria-label={t("composer.modelEffort")} className="flex flex-col pt-1 outline-none">
        <div className="-mb-0.5 flex min-h-6 items-center gap-1 ps-2 pe-0.5">
          {fast?.available ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={fastOn}
                  aria-label={t("composer.modelFastMode")}
                  disabled={saving}
                  onClick={() => fast.onChange(!fastOn)}
                  className={cn(
                    "-ms-1.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed",
                    fastOn
                      ? "bg-accent-500/12 text-accent-500"
                      : "text-foreground-icon-tertiary hover:bg-background-tertiary-default hover:text-foreground-icon-secondary dark:hover:bg-background-primary-hover",
                  )}
                >
                  <RiFlashlightFill aria-hidden className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[130]">
                {fastOn ? t("composer.modelFastModeOn") : t("composer.modelFastMode")}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <p className="min-w-0 flex-1 truncate text-body-medium text-text-secondary">
            {fastOn ? t("composer.modelFast") : t("composer.modelEffort")}{" "}
            <span className={cn("transition-colors duration-150", fastOn ? "text-accent-500" : "text-text-primary")}>
              {supportsEffort ? label : t("boardui.noEffort")}
            </span>
          </p>
          {onReset && (effort !== null || fastOn) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("composer.modelEffortResetAria")}
                  disabled={saving}
                  onClick={onReset}
                  className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-foreground-icon-tertiary outline-none transition-colors duration-150 animate-in fade-in-0 hover:bg-background-tertiary-default hover:text-foreground-icon-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed"
                >
                  <RiResetLeftLine aria-hidden className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[130]">
                {t("composer.modelEffortReset")}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {fastOn ? (
          <p className="ps-2 pt-1.5 text-caption-1-regular text-text-tertiary animate-in fade-in-0 slide-in-from-top-1 duration-200">
            {t("composer.modelFastNote")}
          </p>
        ) : null}
        <EffortSlider
          look={look}
          showTitle={false}
          value={effort ?? DEFAULT_REASONING_EFFORT}
          explicit={effort !== null}
          disabled={saving || !supportsEffort}
          onChange={onEffortChange}
          onCommit={onEffortCommit}
        />
        {saving || !supportsEffort ? (
          <p className="px-2 pb-1 text-caption-1-regular text-text-secondary">
            {saving ? t("composer.modelSaving") : t("composer.modelNoEffort")}
          </p>
        ) : null}
      </section>
    </TooltipProvider>
  );
}

/** The chip at the end of the checked row, opening `EffortPanel` under it. */
export function EffortChip(props: Omit<Parameters<typeof EffortPanel>[0], "look">) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { effort, supportsEffort, fast } = props;
  const fastOn = Boolean(fast?.available && fast.on);
  const label = !supportsEffort
    ? t("boardui.noEffort")
    : effort === null ? t("composer.modelEffortDefault") : effortLabel(t, effort);
  return (
    <BuiPopover open={open} onOpenChange={setOpen}>
      <BuiPopoverTrigger asChild>
        <button
          type="button"
          aria-label={t(fastOn ? "composer.modelEffortValueFast" : "composer.modelEffortValue", { effort: label })}
          className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-full bg-background-tertiary-default py-1 ps-2 pe-1 outline-none transition-colors duration-150 hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <FastBoltSlot on={fastOn} />
          {supportsEffort ? (
            <EffortLabelStack effort={effort} className="text-body-2-medium text-text-secondary" />
          ) : (
            <span className="text-body-2-medium whitespace-nowrap text-text-secondary">{label}</span>
          )}
          {/* To the right when closed, downward when the panel is open. */}
          <RiArrowDownSLine
            aria-hidden
            className={cn("size-[18px] shrink-0 text-foreground-icon-secondary transition-transform duration-200", !open && "-rotate-90")}
          />
        </button>
      </BuiPopoverTrigger>
      <BuiPopoverContent
        side="bottom"
        align="start"
        alignOffset={-8}
        sideOffset={14}
        collisionPadding={16}
        className="bui-popover-ref z-[120] w-[266px] max-w-[calc(100vw-32px)] rounded-[16px] p-1"
        // The default focus is the first button, the bolt: its tooltip would
        // open with no hover and cover the chip. The slider is what one came for.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          panelRef.current?.querySelector<HTMLElement>("[data-composer-effort-slider]")?.focus();
        }}
      >
        <div ref={panelRef}>
          <EffortPanel {...props} look="popover" />
        </div>
      </BuiPopoverContent>
    </BuiPopover>
  );
}
