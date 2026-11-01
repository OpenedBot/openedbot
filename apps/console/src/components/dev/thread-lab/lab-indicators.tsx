/**
 * Thread lab "the agent is working" indicators (dev only), from
 * streaming-ui.pulseview.app/responses. `wave` and `infinity` are the
 * console's own `AgentThinking`; the others are ported for comparison.
 */
import { useEffect, useRef, useState } from "react";
import { AgentThinking } from "@openedbot/browser-ui-kit";

export type LabIndicatorStyle = "wave" | "infinity" | "shimmer" | "swap" | "braille";

export const LAB_INDICATORS: ReadonlyArray<{ value: LabIndicatorStyle; label: string }> = [
  { value: "wave", label: "Dot wave (actuel)" },
  { value: "infinity", label: "Infinity" },
  { value: "shimmer", label: "Thinking Shimmer" },
  { value: "swap", label: "Thinking States (swap flou)" },
  { value: "braille", label: "Braille (terminal)" },
];

export function LabIndicator({ style, label, startedAt }: { style: LabIndicatorStyle; label: string; startedAt: string }) {
  if (style === "wave" || style === "infinity") {
    return <AgentThinking variant={style} label={label} startedAt={startedAt} className="py-1" />;
  }
  return (
    <div role="status" className="flex min-w-0 max-w-full items-center gap-2.5 py-1 text-body-medium">
      {style === "braille" ? <BrailleSpinner /> : null}
      {style === "shimmer" ? <ShimmerStatus label={label} /> : null}
      {style === "swap" ? <SwapStatus label={label} /> : null}
      {style === "braille" ? <span className="min-w-0 truncate text-text-secondary">{label}</span> : null}
      <span className="shrink-0"><LabElapsed startedAt={startedAt} /></span>
    </div>
  );
}

/** Two labels are one status when one starts the other: a live narration only grows. */
function sameStatus(previous: string, next: string): boolean {
  return next.startsWith(previous) || previous.startsWith(next);
}

/** "Thinking Shimmer": a 1.8 s sweep; a new status rises 3 px into place. */
function ShimmerStatus({ label }: { label: string }) {
  return (
    <span key={label.slice(0, 24)} className="lab-shimmer min-w-0 truncate animate-in duration-200 fade-in-0 slide-in-from-bottom-[3px]">
      {label}
    </span>
  );
}

/** "Thinking States": the old status leaves up through a 2 px blur while the next enters from below, 150 ms. */
function SwapStatus({ label }: { label: string }) {
  const [items, setItems] = useState([{ id: 0, label, leaving: false }]);
  const next = useRef(1);
  useEffect(() => {
    setItems((current) => {
      const live = current.find((item) => !item.leaving);
      if (live?.label === label) return current;
      // A narration that grows fragment by fragment is the same status: update it in place.
      if (live && sameStatus(live.label, label)) return current.map((item) => (item === live ? { ...item, label } : item));
      return [...current.map((item) => ({ ...item, leaving: true })), { id: next.current++, label, leaving: false }];
    });
    const timer = setTimeout(() => setItems((current) => current.filter((item) => !item.leaving)), 160);
    return () => clearTimeout(timer);
  }, [label]);
  return (
    <span className="lab-swap">
      {items.map((item) => (
        <span key={item.id} data-text={item.label} data-leaving={item.leaving ? "" : undefined} className="lab-swap-item">
          {item.label}
        </span>
      ))}
    </span>
  );
}

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** "Loader: Text & ASCII": the braille frames CLI agents cycle through. */
function BrailleSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setFrame((value) => (value + 1) % BRAILLE.length), 80);
    return () => clearInterval(id);
  }, []);
  return <span aria-hidden className="w-3 font-mono text-text-primary">{BRAILLE[frame]}</span>;
}

export function LabElapsed({ startedAt }: { startedAt: string }) {
  const origin = Date.parse(startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  const seconds = Number.isFinite(origin) ? Math.max(0, (now - origin) / 1000) : 0;
  return <span className="font-mono text-caption-1-regular text-text-tertiary tabular-nums">{seconds.toFixed(1)}s</span>;
}
