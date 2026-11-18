import { IconCloud, IconServer, IconServerBolt } from "@tabler/icons-react";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
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

/** The runtime's health as a dot: the last mark of the models pill, and the badge of the runtime row. KO and degraded pulse. */
export function RailRuntimeDot({ state, className }: { state: RailRuntimeState; className?: string }) {
  const alarm = state === "ko" || state === "degraded";
  return (
    <span aria-hidden data-rail-runtime-badge={state} className={cn("relative inline-flex size-2.5 shrink-0", className)}>
      {alarm ? (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none", DOT[state])} />
      ) : null}
      <span className={cn("relative size-2.5 rounded-full", DOT[state])} />
    </span>
  );
}

/**
 * The runtime row of the models pill's popover (`RailModelsPill`): the
 * runtime's own icon (see `railRuntimeIcon`) with its health as a badge on the
 * corner, then its sentences. A click opens the runtime settings, where the
 * full state lives.
 */
export function RailRuntimeHealth({
  reading,
  className,
  onOpenSettings,
}: {
  reading: RuntimeHealthReading;
  className: string;
  onOpenSettings: (to: string) => void;
}) {
  const { t, formatDate, locale } = useT();
  const state = railRuntimeState(reading);
  const [head, ...rest] = railRuntimeLines(reading, t, formatDate, locale);
  // Loading stays on the neutral icon: no swap once the read lands.
  const Icon = state === "pending" ? IconServerBolt : railRuntimeIcon(reading.runtime);
  return (
    <button
      type="button"
      data-rail-runtime-health={state}
      // Spans glue their sentences together in the computed name: say them with their spaces.
      aria-label={[head, ...rest].join(" ")}
      className={className}
      onClick={() => onOpenSettings(RUNTIME_SETTINGS_PATH)}
    >
      <span className="relative inline-flex size-7 shrink-0 items-center justify-center text-foreground-icon-secondary">
        <Icon aria-hidden className="size-[18px]" data-rail-runtime-icon={Icon === IconServerBolt ? "server-bolt" : Icon === IconCloud ? "cloud" : "server"} />
        {/* The popover's own surface as the ring: the dot stands off the icon. */}
        <span className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full bg-card p-0.5">
          <RailRuntimeDot state={state} />
        </span>
      </span>
      <span className="min-w-0">
        <span className="block">{head}</span>
        {rest.map((line) => <span key={line} className="block text-text-tertiary">{line}</span>)}
      </span>
    </button>
  );
}
