import { IconCloud, IconServer, IconServerBolt } from "@tabler/icons-react";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@openedbot/browser-ui-kit";
import { useT, type Locale } from "../../lib/i18n";
import { runtimeHealthLabel } from "../../lib/runtime/runtime-health";
import type { RuntimeHealthReading } from "../../lib/runtime/use-runtime-health";

export const RUNTIME_SETTINGS_PATH = "/settings/runtime";

/** `connected` and `ko` are the two words the operator reads; the rest is not a verdict yet. */
export type RailRuntimeState = "pending" | "none" | "connected" | "untested" | "ko" | "degraded";

type Translate = ReturnType<typeof useT>["t"];
type FormatDate = ReturnType<typeof useT>["formatDate"];

export function railRuntimeState(reading: Pick<RuntimeHealthReading, "status" | "pending">): RailRuntimeState {
  // A first read in flight is neither healthy nor KO: no red flash on load.
  if (reading.pending) return "pending";
  switch (reading.status) {
    case "not_configured":
      return "none";
    case "healthy":
      return "connected";
    case "unknown":
      return "untested";
    // Reachable, but no bot will answer: KO in words, amber in colour.
    case "missing_feature":
    case "no_provider":
      return "degraded";
    default:
      return "ko";
  }
}

/**
 * The tooltip, line by line. The same sentences are the button's accessible
 * name, so a touch device (no hover) or a screen reader loses nothing.
 */
export function railRuntimeLines(
  reading: RuntimeHealthReading,
  t: Translate,
  formatDate: FormatDate,
  locale: Locale,
): string[] {
  const state = railRuntimeState(reading);
  if (state === "pending") return [t("runtimeRail.loading")];
  if (state === "none") return [t("runtimeRail.none"), t("runtimeRail.openToConfigure")];
  const word = state === "connected"
    ? t("runtimeRail.connected")
    : state === "untested"
      ? t("runtimeRail.untested")
      : t("runtimeRail.koReason", { reason: runtimeHealthLabel(reading.runtime, reading.error, locale) });
  const name = reading.runtime?.name?.trim();
  const head = name ? t("runtimeRail.named", { name, state: word }) : t("runtimeRail.unnamed", { state: word });
  if (state === "connected") return [head];
  if (state === "untested") return [head, t("runtimeRail.openToTest")];
  const lines = [head];
  const lastSeen = reading.runtime?.link?.lastSeenAt;
  if (lastSeen) lines.push(t("runtimeRail.lastSeen", { date: formatDate(lastSeen) }));
  lines.push(t("runtimeRail.openToReconnect"));
  return lines;
}

export type RailRuntimeIcon = typeof IconServer;

/**
 * The one place that maps a runtime to its rail icon, reusing the icons the
 * console already shows for it. The DTO carries no avatar and no desktop/server
 * kind, only `management.kind` and `reachability`, so nothing finer is invented:
 * - embedded Hermes of the deployment (`hermes_dashboard`): `IconCloud`, the
 *   openedbot side of `cloud-link-hero.tsx`;
 * - a customer host, linked (`connector`) or direct: `IconServer`, the
 *   "votre hote" endpoint of `cloud-link-hero.tsx`;
 * - none yet, or first read in flight: `IconServerBolt`, the Runtime entry of
 *   the settings sidebar and the runtime empty state.
 */
export function railRuntimeIcon(runtime: RuntimePublicDto | null | undefined): RailRuntimeIcon {
  if (!runtime || !runtime.configured) return IconServerBolt;
  if (runtime.management.kind === "hermes_dashboard") return IconCloud;
  return IconServer;
}

const DOT: Record<RailRuntimeState, string> = {
  pending: "bg-muted-foreground/30",
  none: "border-[1.5px] border-muted-foreground/60 bg-transparent",
  connected: "bg-pos-700",
  untested: "bg-muted-foreground/60",
  ko: "bg-destructive",
  degraded: "bg-warn-700",
};

/**
 * Runtime health on the icon rail, right above Support. The runtime's own icon
 * (see `railRuntimeIcon`) with the health as a status badge on its corner: the
 * rail is 56 px wide, so no label. Hover (or focus) names the runtime and the
 * state; a click or a tap opens the runtime settings, where the full state lives.
 */
export function RailRuntimeHealth({
  reading,
  buttonClassName,
  onOpenSettings,
}: {
  reading: RuntimeHealthReading;
  buttonClassName: string;
  onOpenSettings: (to: string) => void;
}) {
  const { t, formatDate, locale } = useT();
  const state = railRuntimeState(reading);
  const lines = railRuntimeLines(reading, t, formatDate, locale);
  const alarm = state === "ko" || state === "degraded";
  // Loading stays on the neutral icon: no swap, no layout shift once the read lands.
  const Icon = state === "pending" ? IconServerBolt : railRuntimeIcon(reading.runtime);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-rail-runtime-health={state}
          aria-label={lines.join(" ")}
          // 36 px to the eye, 44 pt to the finger (a coarse pointer on a tablet).
          className={cn(
            buttonClassName,
            "pointer-coarse:before:absolute pointer-coarse:before:-inset-1 pointer-coarse:before:rounded-[inherit] pointer-coarse:before:content-['']",
          )}
          onClick={() => onOpenSettings(RUNTIME_SETTINGS_PATH)}
        >
          <Icon aria-hidden data-rail-runtime-icon={Icon === IconServerBolt ? "server-bolt" : Icon === IconCloud ? "cloud" : "server"} />
          <span aria-hidden data-rail-runtime-badge={state} className="absolute right-1 bottom-1 inline-flex size-2.5">
            {alarm ? (
              <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none", DOT[state])} />
            ) : null}
            <span className={cn("relative size-2.5 rounded-full ring-2 ring-background", DOT[state])} />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        {lines.map((line) => <p key={line}>{line}</p>)}
      </TooltipContent>
    </Tooltip>
  );
}
