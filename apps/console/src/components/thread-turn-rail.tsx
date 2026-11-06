import { useEffect, useRef, useState } from "react";
import { litRailTurns, RAIL_MEASURE_INTERVAL_MS, throttledFrame, type ThreadRailTurn } from "../lib/thread/thread-turn-rail";
import { requestThreadReveal } from "../lib/thread/thread-reveal";
import { useT } from "../lib/i18n";

const targetSelector = (targetId: string) =>
  `[data-thread-find-target="${CSS.escape(targetId)}"]`;

/**
 * Le rail des tours, posé à gauche du fil (bureau). Il ne lit le fil que par
 * le DOM : un trait est « visible » quand la section de son tour (de sa bulle
 * à la bulle suivante) croise la zone défilante. Un tour hors des rangées
 * montées n'a pas de nœud : plus ancien qu'elles, ou plus récent.
 *
 * Il se superpose au bord gauche du fil sans lui réserver de gouttière
 * (`thread-timeline.css`) : 2.5rem, la marge du fil (1rem) plus le débord du
 * composer (24 px) au plus serré, pour que ses traits ne couvrent pas le texte.
 */
export function ThreadTurnRail({ turns }: { turns: readonly ThreadRailTurn[] }) {
  const { t } = useT();
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set());
  const [hover, setHover] = useState<{ index: number; top: number } | null>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  useEffect(() => {
    const scroller = root.current?.parentElement?.querySelector<HTMLElement>("[role='log']");
    if (!scroller) return;
    const measure = () => {
      const view = scroller.getBoundingClientRect();
      const tops = turnsRef.current.map((turn) => {
        const node = scroller.querySelector(targetSelector(turn.targetId));
        return node ? node.getBoundingClientRect().top : null;
      });
      const next = litRailTurns(tops, view);
      setVisible((previous) =>
        previous.size === next.size && [...next].every((index) => previous.has(index))
          ? previous
          : next);
    };
    const { schedule, cancel } = throttledFrame(measure, RAIL_MEASURE_INTERVAL_MS);
    schedule();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancel();
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [turns]);

  if (turns.length < 2) return null;

  // Le fil seul pose le tour : il décolle d'abord son « collé en bas ». Un
  // `scrollIntoView` d'ici laissait le fil collé, et la vraie hauteur d'un
  // ancien tour (`content-visibility: auto`) le renvoyait en bas au 1er clic.
  const jump = (turn: ThreadRailTurn) => requestThreadReveal(turn.targetId);
  const show = (index: number, element: HTMLElement) => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const tick = element.getBoundingClientRect();
    setHover({ index, top: tick.top + tick.height / 2 - box.top });
  };
  const hovered = hover ? turns[hover.index] : undefined;

  return (
    <div
      ref={root}
      className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-10 items-center"
      onPointerLeave={() => setHover(null)}
    >
      <nav
        aria-label={t("threadTurnRail.label")}
        className="no-scrollbar pointer-events-auto flex max-h-[70%] w-full flex-col items-start overflow-y-auto py-1 pl-5"
      >
        {turns.map((turn, index) => {
          const lit = visible.has(index) || hover?.index === index;
          return (
            <button
              key={turn.targetId}
              type="button"
              aria-label={t("threadTurnRail.jump", { text: turn.question })}
              className="flex h-2 w-full shrink-0 items-center outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onPointerEnter={(event) => show(index, event.currentTarget)}
              onFocus={(event) => show(index, event.currentTarget)}
              onBlur={() => setHover(null)}
              onClick={() => jump(turn)}
            >
              <span
                aria-hidden
                className={`block h-0.5 rounded-full transition-[width,background-color] duration-150 ${lit ? "w-3.5 bg-foreground" : "w-2 bg-muted-foreground/40"}`}
              />
            </button>
          );
        })}
      </nav>
      {hover && hovered ? (
        <div
          aria-hidden
          className="pointer-events-none absolute left-11 w-max max-w-60 -translate-y-1/2 rounded-xl border bg-popover px-2.5 py-2 text-popover-foreground shadow-md"
          style={{ top: hover.top }}
        >
          <p className="truncate text-sm font-semibold">{hovered.question}</p>
          {hovered.answer ? (
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{hovered.answer}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
