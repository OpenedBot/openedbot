import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { RunStatusPhase } from "../../lib/thread/run-thinking-model";
import { THINKING_LABEL_HOLD_MS, ThinkingDots } from "./thinking-dots";
import { StreamIcon } from "./stream-icons";

/*
 * A run's status row: ONE line of fixed height, the same mounted element
 * from the send to the end of the run, that transforms in place. Pending,
 * the bot's avatar fades in, then turns into the typing dots; working, the
 * agents and the current step (revealed by a left-to-right sweep, then
 * crossfaded); done, « Réflexion : Ns », which opens the log; gone (the
 * bottom row of a finished run), it empties while its turn collapses it
 * (`TurnActivity`), then unmounts.
 */

export type StreamAgent = { id: string; avatar: ReactNode };

/** One line of thread text (15 px at the default size, scaled with the root font). */
export const RUN_STATUS_LINE_CLASS = "h-[1.4375rem] text-[0.9375rem] leading-[1.4375rem]";

/**
 * A replaced label leaves first (`stream-label-out`, 120 ms), then the new
 * one enters (`stream-label-in`, delayed by those 120 ms): never two
 * readable labels on the same spot. The leaving copy unmounts just after.
 */
const SWAP_OUT_MS = 140;

/** `swapped`: the current label replaced another; it keeps its delayed entry until the next change. */
type LabelSwap = { current: string | null; previous: string | null; reveal: boolean; swapped: boolean; seen: boolean };

/**
 * The label on screen and the one leaving it. The first label of a row
 * mounted live is revealed by the sweep; every later one cross-fades. A
 * row mounted done (history) shows its summary as is.
 */
function useLabelSwap(text: string | null, mountedLive: boolean): LabelSwap {
  const [swap, setSwap] = useState<LabelSwap>(() => ({
    current: text,
    previous: null,
    reveal: mountedLive && text !== null,
    swapped: false,
    seen: text !== null,
  }));
  if (swap.current !== text) {
    const reveal = !swap.seen && mountedLive;
    setSwap({ current: text, previous: swap.current, reveal, swapped: !reveal && swap.current !== null, seen: swap.seen || text !== null });
  }
  useEffect(() => {
    if (swap.previous === null) return;
    const timer = window.setTimeout(() => setSwap((state) => ({ ...state, previous: null })), SWAP_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [swap.previous, swap.current]);
  return swap;
}

/**
 * The text the row reads. Between two live steps, each stays at least
 * 800 ms (`THINKING_LABEL_HOLD_MS`) so a burst of tools stays readable; the
 * first step after pending, and the summary once done, show at once.
 */
function useHeldText(text: string | null, hold: boolean): string | null {
  const [shown, setShown] = useState<{ text: string | null; at: number }>(() => ({ text, at: Date.now() }));
  const immediate = !hold || shown.text === null || text === null;
  if (immediate && text !== shown.text) setShown({ text, at: Date.now() });
  useEffect(() => {
    if (immediate || text === shown.text) return;
    const swap = () => setShown({ text, at: Date.now() });
    const wait = shown.at + THINKING_LABEL_HOLD_MS - Date.now();
    if (wait <= 0) {
      swap();
      return;
    }
    const timer = window.setTimeout(swap, wait);
    return () => window.clearTimeout(timer);
  }, [immediate, text, shown]);
  return immediate ? text : shown.text;
}

/** Width of the avatar stack: 22 px for the first, 12 px more per agent. */
const stackWidth = (count: number) => `${1.375 + Math.max(0, count - 1) * 0.75}rem`;

export function RunStatusLine({
  phase,
  agents,
  overflow = 0,
  label,
  summary,
  open,
  onOpen,
  controls,
  trailing,
}: {
  phase: RunStatusPhase;
  /** The run's bot, then its delegates (`thinkingAgents`). */
  agents: readonly StreamAgent[];
  /** Agents beyond `agents`, counted in a « +N » chip. */
  overflow?: number;
  /** The live step (working / waiting), held at least 800 ms. */
  label: string;
  /** What the done row reads. */
  summary: string;
  open?: boolean;
  onOpen?: () => void;
  /** The id of the inline log the row opens. */
  controls?: string;
  trailing?: ReactNode;
}) {
  const live = phase === "working" || phase === "waiting";
  const [mountedLive] = useState(phase !== "done" && phase !== "gone");
  // The dots exist only for a row that was pending: they fade out once, never flash in.
  const [sawPending] = useState(phase === "pending");
  const text = useHeldText(live ? label : phase === "done" ? summary : null, live);
  const swap = useLabelSwap(text, mountedLive);
  // Live too: the operator follows the steps while the bot works, not only after.
  const openable = (phase === "done" || live) && onOpen !== undefined;
  const marks = agents.length + (overflow > 0 ? 1 : 0);
  return (
    <button
      type="button"
      data-activity-head=""
      data-run-status={phase}
      aria-hidden={phase === "gone" ? true : undefined}
      tabIndex={phase === "gone" ? -1 : undefined}
      aria-expanded={openable ? open === true : undefined}
      aria-controls={openable ? controls : undefined}
      onClick={openable ? onOpen : undefined}
      className={cn(
        "openedbot-run-status group flex w-full min-w-0 items-center whitespace-nowrap text-start text-[var(--stream-fg2)] outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none",
        RUN_STATUS_LINE_CLASS,
        openable ? "cursor-pointer" : "cursor-default",
        phase === "gone" && "pointer-events-none",
      )}
    >
      <span
        data-run-status-mark=""
        className="relative me-1.5 flex h-full shrink-0 items-center transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: phase === "done" || phase === "gone" ? "1rem" : stackWidth(Math.max(1, marks)) }}
      >
        <span
          data-run-status-agents=""
          className={cn(
            "absolute inset-y-0 left-0",
            phase === "pending" && "openedbot-run-status-avatar",
            live && sawPending && "openedbot-run-status-mark-in",
            // Animated out of a live row; a row mounted done never showed it.
            !live && phase !== "pending" && (mountedLive ? "openedbot-run-status-mark-out" : "opacity-0"),
          )}
        >
          {agents.map((agent, index) => (
            <span
              key={agent.id}
              data-stream-agent={agent.id}
              className="stream-spring absolute top-[0.03125rem] grid size-[1.375rem] place-items-center rounded-full bg-[var(--stream-base)]"
              style={{ left: `${index * 0.75}rem`, zIndex: 10 - index }}
            >
              <span className="grid size-[1.125rem] place-items-center overflow-hidden rounded-full">{agent.avatar}</span>
            </span>
          ))}
          {overflow > 0 ? (
            <span
              key="overflow"
              data-stream-agent="overflow"
              className="stream-spring absolute top-[0.03125rem] grid size-[1.375rem] place-items-center rounded-full bg-[var(--stream-raised)] text-[0.6875rem] leading-none tabular-nums text-[var(--stream-fg2)]"
              style={{ left: `${agents.length * 0.75}rem`, zIndex: 11, boxShadow: "0 0 0 1.5px var(--stream-base)" }}
            >
              {`+${overflow}`}
            </span>
          ) : null}
        </span>
        {sawPending ? (
          <span
            data-run-status-dots=""
            className={cn(
              "absolute inset-y-0 left-0.5 flex items-center",
              phase === "pending" ? "openedbot-run-status-dots" : "openedbot-run-status-mark-out",
            )}
          >
            <ThinkingDots />
          </span>
        ) : null}
        {phase === "done" ? (
          <span className={cn("absolute inset-y-0 left-0 grid w-4 place-items-center", mountedLive && "stream-swap-in")}>
            <StreamIcon name="bulb" className={cn("size-4 transition-opacity duration-150", openable && "group-hover:opacity-0")} />
            {openable ? <StreamIcon name="panel" className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" /> : null}
          </span>
        ) : null}
      </span>
      <span className="relative flex h-full min-w-0 items-center">
        {swap.previous !== null ? (
          <span key={`out:${swap.previous}`} aria-hidden="true" className="stream-label-out pointer-events-none absolute inset-y-0 left-0 truncate">
            {swap.previous}
          </span>
        ) : null}
        {swap.current !== null ? (
          <span
            key={swap.current}
            data-activity-summary=""
            className={cn(
              "min-w-0 truncate transition-colors",
              swap.reveal ? "stream-reveal" : swap.swapped && "stream-label-in",
              openable && "group-hover:text-[var(--stream-fg)]",
            )}
          >
            {swap.current}
          </span>
        ) : null}
      </span>
      {phase === "done" ? trailing : null}
    </button>
  );
}
