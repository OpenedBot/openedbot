import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";

/*
 * the reference app's rolling feed, the streaming-ui engine verbatim
 * (MakFly/streaming-ui `src/components/agent-feed/agent-feed.tsx`): the last
 * `max` items show, a new one blurs in below, the others slide up into place
 * (FLIP) and the oldest leaves upward. The window empties once the run
 * stops, so the header can fold it into « Réflexion : Ns ».
 */

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function AgentFeed<T extends { id: string }>({
  items,
  renderItem,
  running = true,
  max = 3,
  enterClassName = "stream-feed-in",
  exitClassName = "stream-feed-out",
  exitMs = 420,
  moveMs = 380,
  easing = EASE,
  className,
}: {
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
  /** While false the window is empty: every visible row leaves. */
  running?: boolean;
  /** Rows on screen at once. */
  max?: number;
  /** Class a row mounts with, and the one its leaving copy plays before it unmounts after `exitMs`. */
  enterClassName?: string;
  exitClassName?: string;
  exitMs?: number;
  /** Duration of the slide up and of the height change. */
  moveMs?: number;
  easing?: string;
  className?: string;
}) {
  const visible = running ? items.slice(-max) : [];
  const [leaving, setLeaving] = useState<T[]>([]);
  const prev = useRef<readonly T[]>([]);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const tops = useRef(new Map<string, number>());
  const timers = useRef(new Set<number>());
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const ids = new Set(visible.map((item) => item.id));
    const gone = prev.current.filter((item) => !ids.has(item.id));
    prev.current = visible;
    if (gone.length) {
      setLeaving((current) => [...current, ...gone]);
      const timer = window.setTimeout(() => {
        timers.current.delete(timer);
        setLeaving((current) => current.filter((item) => !gone.includes(item)));
      }, exitMs);
      timers.current.add(timer);
    }
    const still = reducedMotion();
    for (const [id, element] of nodes.current) {
      const top = element.offsetTop;
      const was = tops.current.get(id);
      if (!still && was !== undefined && was !== top && typeof element.animate === "function") {
        element.animate([{ transform: `translateY(${was - top}px)` }, { transform: "none" }], { duration: moveMs, easing });
      }
      tops.current.set(id, top);
    }
  });
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const element = inner.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      data-agent-feed=""
      className={cn("relative transition-[height] motion-reduce:transition-none", className)}
      style={{ height, transitionDuration: `${moveMs}ms`, transitionTimingFunction: easing }}
    >
      <div ref={inner} className={cn("relative flex flex-col gap-[3px]", visible.length > 0 && "pt-[4px]")}>
        {leaving.map((item) => (
          <div key={`out-${item.id}`} aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 top-[4px]", exitClassName)}>
            {renderItem(item)}
          </div>
        ))}
        {visible.map((item) => (
          <div
            key={item.id}
            data-agent-feed-item=""
            ref={(element) => {
              if (element) nodes.current.set(item.id, element);
              else {
                nodes.current.delete(item.id);
                tops.current.delete(item.id);
              }
            }}
          >
            <div className={enterClassName}>{renderItem(item)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Whole seconds since `started` (at least 1), ticking while `running`. */
export function useElapsed(started: number, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);
  return Math.max(1, Math.floor((now - started) / 1000));
}

/** the reference app's duration: « 23s », « 1m 12s » past a minute. */
export const streamDuration = (seconds: number) => (seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`);
