import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { formatSeconds, type RunTiming } from "../lib/run/run-timing";

/**
 * A reply's real duration, under its bubble, in place of the face and the name
 * of the bot (a DM thread has only one speaker). Hover or focus: the detail,
 * like assistant-ui (first token, total, speed, chunks).
 *
 * While it is writing, the counter advances from the run's creation: it stands
 * in as the activity indicator.
 */
export function RunTimingBadge({ timing, liveSince }: { timing?: RunTiming | null; liveSince?: string | null }) {
  const { t, formatNumber } = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!liveSince) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [liveSince]);

  const badge = "mt-1 rounded-md px-1 font-mono text-[11px] leading-4 tabular-nums text-text-tertiary";
  if (liveSince && !timing) {
    const elapsed = Math.max(0, now - new Date(liveSince).getTime());
    return <span aria-live="off" className={badge}>{formatSeconds(elapsed)}</span>;
  }
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
