import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { useT } from "../lib/i18n";
import { useExitGhost } from "../lib/thread/thread-motion";
import { useHeldValue } from "../lib/hooks/use-held-value";
import { GrokAgentsHeader } from "./grok/grok-feed";

/** How often the elapsed timer repaints (the reference ticks every 100 ms). */
export const THINKING_TICK_MS = 100;

/** A status stays at least this long before the next replaces it (Grok Bot: 800 ms). */
export const THINKING_LABEL_HOLD_MS = 800;

/** Grok Bot's typing mark: three dots. */
const DOT_COUNT = 3;

/**
 * "0,7 s" under a minute, "1:05" after. One decimal while it still reads as a
 * stopwatch; a negative span (a client clock behind the server's) is 0.
 */
export function formatElapsed(
  ms: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${formatNumber(seconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Grok Bot's typing mark, three dots in the bot's colour (`.openedbot-thinking-dots`). */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden data-thinking-dots="" className={cn("openedbot-thinking-dots shrink-0", className)}>
      {Array.from({ length: DOT_COUNT }, (_, index) => <i key={index} />)}
    </span>
  );
}

/**
 * The elapsed time since `since` (epoch ms), repainted every 100 ms. It owns
 * its own state: a tick re-renders this one text node, never the turn or the
 * thread around it (thread render invariants, THREAD_PERF_HUD.md).
 */
export function ElapsedTimer({ since, className }: { since: number; className?: string }) {
  const { formatNumber } = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), THINKING_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span data-thinking-elapsed="" className={cn("font-mono text-xs tabular-nums text-text-tertiary", className)}>
      {formatElapsed(now - since, formatNumber)}
    </span>
  );
}

/**
 * "Agent Thinking" of the reference: dot grid, shimmering label, elapsed
 * time. `since` is the run's real start (server `createdAt`), so a reload
 * mid-run keeps counting from the true start instead of from zero.
 */
export const ThinkingStatus = memo(function ThinkingStatus({ since, label, className, announce = true, entering = false }: {
  since: number;
  /**
   * Defaults to the generic thinking status. A running tool passes its
   * concrete line (« Recherche : cours du bitcoin »); a change is held 800 ms
   * and rises into place, so a burst of tools reads as steps.
   */
  label?: string;
  className?: string;
  /** `role="status"`; off inside a button, which cannot host a live region. */
  announce?: boolean;
  /** Under the mark that pops in (`PendingThinking`): the first label lands 220 ms later, as Grok Bot. */
  entering?: boolean;
}) {
  const { t } = useT();
  const generic = t("agentActivity.thinking");
  // The hold paces one tool label after another; a tool that ended goes back
  // to the generic line at once, so a finished tool never looks still running.
  const heldLabel = useHeldValue(label ?? generic, THINKING_LABEL_HOLD_MS);
  const held = label === undefined ? generic : heldLabel;
  // Grok Bot : le premier libellé arrive 220 ms après la marque, les
  // suivants montent tout de suite.
  const firstLabel = useRef<string | null>(held);
  if (firstLabel.current !== null && firstLabel.current !== held) firstLabel.current = null;
  return (
    <span role={announce ? "status" : undefined} data-thinking-status="" className={cn("flex min-w-0 items-center gap-2 text-text-tertiary", className)}>
      <ThinkingDots />
      <span
        key={held}
        data-thinking-label=""
        data-first={firstLabel.current === held ? "" : undefined}
        data-enter={entering ? "" : undefined}
        className="openedbot-thinking-shimmer openedbot-status-swap min-w-0 truncate"
      >
        {held}
      </span>
      <ElapsedTimer since={since} />
    </span>
  );
});

/**
 * The status of a turn that has no block yet: the run is queued or thinking
 * and nothing has been written. It is grok.com's `AgentsHeader` before the
 * agents are called: the bulb and « Réflexion pendant 1s » for a beat, then
 * the 3 × 3 dot loader with « Réflexion • Ns ». The turn's own block takes
 * over (same header, same timer base) the moment the first step arrives; this
 * one leaves as a copy that shrinks to 0.92 and fades out (`useExitGhost`).
 */
export function PendingThinking({ since, author = null }: { since: number | null; author?: MessageAuthorBot | null }) {
  const [mountedAt] = useState(() => Date.now());
  const start = since ?? mountedAt;
  const [pre, setPre] = useState(() => Date.now() - start < PENDING_PRE_BEAT_MS);
  useEffect(() => {
    if (!pre) return;
    const timer = window.setTimeout(() => setPre(false), Math.max(0, PENDING_PRE_BEAT_MS - (Date.now() - start)));
    return () => window.clearTimeout(timer);
  }, [pre, start]);
  const node = useRef<HTMLDivElement>(null);
  useExitGhost(node);
  return (
    <div ref={node} role="status" data-thread-thinking="" data-thinking-status="" data-author={author?.id} className="flex w-full self-start">
      <GrokAgentsHeader agents={[]} started={start} running streaming={false} pre={pre} />
    </div>
  );
}

/** grok.com's first beat: the bulb before the agents are called. */
const PENDING_PRE_BEAT_MS = 400;
