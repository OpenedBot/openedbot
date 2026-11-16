import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { formatSeconds, type RunTiming } from "../lib/run/run-timing";

/**
 * A reply's real duration (dev builds), on its action row after « … ».
 * Hover or focus: the detail, like assistant-ui (first token, total, speed,
 * chunks). The row appears once the run ends, so there is no live counter.
 */
export function RunTimingBadge({ timing }: { timing?: RunTiming | null }) {
  const { t, formatNumber } = useT();
  const badge = "rounded-md px-1 font-mono text-[11px] leading-4 tabular-nums text-text-tertiary";
  if (!timing) return null;

  const rows: Array<[string, string]> = [
    [t("threadTimeline.timingFirstToken"), timing.firstTokenMs === null ? "–" : formatSeconds(timing.firstTokenMs)],
    [t("threadTimeline.timingTotal"), formatSeconds(timing.totalMs)],
    [
      t("threadTimeline.timingSpeed"),
      timing.tokensPerSecond === null
        ? "–"
        : t("threadTimeline.timingSpeedValue", { value: formatNumber(timing.tokensPerSecond, { maximumFractionDigits: 1 }) }),
    ],
    [t("threadTimeline.timingChunks"), formatNumber(timing.chunks)],
  ];

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${t("threadTimeline.timingLabel")} ${formatSeconds(timing.totalMs)}`}
            className={`${badge} cursor-default outline-none transition-colors hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring`}
          >
            {formatSeconds(timing.totalMs)}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          sideOffset={6}
          // The BoardUI menu card, not the kit's black chip: tokens
          // of the theme only, and no arrow (assistant-ui has none): one
          // hides its container, the SVG carrying an inline `display: block`.
          className="max-w-none rounded-xl border border-border-button-default bg-background-primary-default p-2.5 text-text-primary shadow-dropdown [&>span]:hidden"
        >
          <dl className="grid grid-cols-[auto_auto] gap-x-8 gap-y-1 text-body-2-medium">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-text-secondary">{label}</dt>
                <dd className="text-end font-mono tabular-nums text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
