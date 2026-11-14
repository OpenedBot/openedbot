import { useRouterState } from "@tanstack/react-router";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { displayedRuntimeHealth, runtimeHealthLabel } from "../../lib/runtime/runtime-health";
import { useRuntimeHealth } from "../../lib/runtime/use-runtime-health";
import { linkHealthErrorText } from "../../lib/runtime/link-health-error";
import { ALIVE_BADGE, ToneBadge, type Tone } from "../settings/primitives";
import { connectorUpgradeLevel } from "../../lib/runtime/connector-upgrade";
import { ConnectorUpgradeDot } from "./connector-upgrade-badge";

const TONE_DOT: Record<Tone, string> = {
  success: "bg-pos-700",
  info: "bg-info-700",
  neutral: "bg-muted-foreground/50",
  warning: "bg-warn-700",
  danger: "bg-destructive",
};

/** BoardUI chart-2: Tailwind lime-400 (`--color-lime-400` in ui-kit app.css). */
const ALIVE_DOT = "bg-lime-400";

function healthTone(status: ReturnType<typeof displayedRuntimeHealth>): Tone {
  switch (status) {
    case "healthy":
      return "success";
    case "disconnected":
    case "unreachable":
      return "danger";
    case "unauthorized":
    case "missing_feature":
    case "no_provider":
      return "warning";
    default:
      return "neutral";
  }
}

function isConversationHeaderRoute(routeIds: readonly string[]): boolean {
  return routeIds.some((id) => id === "/_app/bot/$botId" || id === "/_app/g/$groupId");
}

/**
 * The runtime's status pill, to the left of the header's actions, on a thread.
 *
 * A fact, not a button. The healthy state reads « runtime alive » (lime-400,
 * BoardUI chart-2). The other statuses share `runtimeHealthLabel` with
 * the foot of the bar and the Runtime screen. On the phone, a coloured dot
 * (the bar has no room for a label); the word stays in `aria-label`.
 */
export function RuntimeHealthBadge() {
  const onConversation = useRouterState({
    select: (state) => isConversationHeaderRoute(state.matches.map((match) => match.routeId)),
  });
  if (!onConversation) return null;
  return <LiveRuntimeHealthBadge />;
}

function LiveRuntimeHealthBadge() {
  const { t, locale, formatDate } = useT();
  const isMobile = useIsMobile();
  const { runtime, error, status, pending } = useRuntimeHealth();
  const alive = !pending && status === "healthy";
  const label = pending
    ? t("common.loading")
    : alive
      ? t("runtimeHealth.alive")
      : runtimeHealthLabel(runtime, error, locale);
  const tone = pending ? "neutral" : healthTone(status);
  const aria = t("runtimeHealth.headerAria", { status: label });
  const detail = linkHealthErrorText(
    runtime?.lastHealthError,
    runtime?.link?.lastSeenAt,
    (seen) => t("cloudRuntimeSettings.linkClosedAfterRestart", { date: formatDate(seen) }),
  );
  const title = detail ? `${label} : ${detail}` : label;
  // A connector below the minimum is not a health failure: the runtime still
  // answers. It gets its own dot, linked to the runtime screen.
  const upgrade = connectorUpgradeLevel(runtime?.link?.connector) === "outdated" ? <ConnectorUpgradeDot /> : null;

  if (isMobile) {
    // Healthy or reading: nothing. Silence is the normal state, and the room
    // goes back to the thread's title. Only a runtime in trouble sets its dot.
    if (alive || pending) return upgrade;
    return (
      <>
        <span
          data-runtime-health=""
          role="status"
          aria-live="polite"
          aria-label={aria}
          title={title}
          className="flex h-11 shrink-0 items-center px-1.5"
        >
          <span aria-hidden className={cn("size-2.5 rounded-full", alive ? ALIVE_DOT : TONE_DOT[tone])} />
        </span>
        {upgrade}
      </>
    );
  }

  const badge = (
    <span
      data-runtime-health=""
      role="status"
      aria-live="polite"
      aria-label={aria}
      title={title}
      className="inline-flex shrink-0"
    >
      <ToneBadge tone={tone} className={cn("whitespace-nowrap", alive && ALIVE_BADGE)}>
        {label}
      </ToneBadge>
    </span>
  );

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="bottom">{title}</TooltipContent>
      </Tooltip>
      {upgrade}
    </TooltipProvider>
  );
}
