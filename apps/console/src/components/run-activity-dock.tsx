import { memo, useMemo } from "react";
import type { ApprovalRequestDto, MessageAuthorBot, RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { useT } from "../lib/i18n";
import { deriveRunActivity, type RunActivityState } from "../lib/thread/thread-activity";
import { toolProgressLabel } from "../lib/run/tool-progress-label";
import { useHeldValue } from "../lib/hooks/use-held-value";

type RunActivityDockProps = {
  runs: readonly RunDto[];
  events: readonly StoredProductEvent[];
  approvals: readonly ApprovalRequestDto[];
  running: boolean;
  /** SSE stream connected. Cut, the animation would lie: one says so instead. */
  streaming: boolean;
  runAuthors?: ReadonlyMap<string, MessageAuthorBot>;
  /**
   * The turn rail widens the thread's left gutter to 3.5rem
   * (`thread-timeline.css`): the activity aligns with the message column.
   */
  alignWithTurnRail?: boolean;
  /**
   * The thread itself shows the live status (`ThinkingStatus` in the turn):
   * the dock then keeps only what the thread cannot say, the interrupted
   * stream notice.
   */
  statusInThread?: boolean;
};

/**
 * The current turn's activity, set just above the composer like BoardUI's
 * `agent-thinking` block. It does not live in the thread: its place
 * therefore depends on no entry, and the thread does not jump when it changes.
 *
 * A column row in `shrink-0`, never `position: fixed` (PWA contract:
 * Safari would detach it on keyboard focus).
 */
function RunActivityDockView({ runs, events, approvals, running, streaming, runAuthors, alignWithTurnRail = false, statusInThread = false }: RunActivityDockProps) {
  const { t } = useT();
  const inset = alignWithTurnRail ? "pl-14 pr-4 sm:pr-6" : "px-4 sm:px-6";
  const activity = useMemo(
    () => (running ? deriveRunActivity(runs, events, approvals) : null),
    [running, runs, events, approvals],
  );
  if (!running || approvals.length > 0) return null;

  if (!streaming) {
    return (
      <p data-run-activity="interrupted" className={`flex min-h-7 w-full shrink-0 items-center text-xs text-muted-foreground ${inset}`}>
        {t("conversation.streamInterrupted")}
      </p>
    );
  }

  if (statusInThread) return null;

  return (
    <RunActivityLine
      kind={activity?.kind ?? "thinking"}
      label={activityLabel(t, activity, runAuthors)}
      inset={inset}
    />
  );
}

/** How long a status stays before the next one may replace it (the reference app: 800 ms). */
export const RUN_ACTIVITY_HOLD_MS = 800;

function activityLabel(
  t: ReturnType<typeof useT>["t"],
  activity: RunActivityState | null,
  runAuthors: ReadonlyMap<string, MessageAuthorBot> | undefined,
): string {
  // Salon between two turns: the room is working with no run to point at.
  const label = !activity ? t("agentActivity.thinking")
    : activity.kind === "queued" ? t("agentActivity.queued")
    : activity.kind === "waitingFor" ? t("agentActivity.waitingFor", { name: activity.name })
    : activity.kind === "tool" ? toolProgressLabel(t, activity.tool, activity.preview)
    : activity.kind === "writing" ? t("agentActivity.writing")
    : t("agentActivity.thinking");
  const author = activity ? runAuthors?.get(activity.runId) ?? null : null;
  return author?.name ? `${author.name}: ${label}` : label;
}

/**
 * The thinking line itself, as « Thinking Shimmer » (streaming-ui.pulseview.app,
 * Stream collection): the status alone, a gradient sweeping it every 1.8 s
 * (`.openedbot-thinking-shimmer`, agent-activity.css), a new status rising 3 px into
 * place. Its label is held at least 800 ms: a burst of tools reads as a
 * sequence of steps instead of a flicker.
 */
function RunActivityLine({ kind, label, inset }: {
  kind: string;
  label: string;
  inset: string;
}) {
  const held = useHeldValue(label, RUN_ACTIVITY_HOLD_MS);
  return (
    <div data-run-activity={kind} className={`flex min-h-7 w-full shrink-0 items-center ${inset}`}>
      {/* No seconds counter, by operator decision. */}
      <span role="status" className="flex min-w-0 items-center text-body-medium">
        <span
          key={held}
          data-thinking-label=""
          className="openedbot-thinking-shimmer min-w-0 truncate animate-in duration-200 fade-in-0 slide-in-from-bottom-[3px] motion-reduce:animate-none"
        >
          {held}
        </span>
      </span>
    </div>
  );
}

export const RunActivityDock = memo(RunActivityDockView);
