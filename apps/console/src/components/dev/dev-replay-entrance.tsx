import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Dev-only bench for a screen's entrance motion. « Rejouer l'entrée » runs
 * `onReplay` (put a boot element back, say), takes `children` off for
 * `holdMs` (the load being simulated), then remounts them: their mount
 * animations play again, form state reset. « Recharger » reloads the page for
 * the real launch.
 *
 * In production this renders `children` only (`import.meta.env.DEV === true`,
 * as `DevRenderProfiler`): the build drops the buttons.
 */
export function DevReplayEntrance({ children, onReplay, holdMs = 0 }: { children: ReactNode; onReplay?: () => void; holdMs?: number }): ReactNode {
  const [run, setRun] = useState(0);
  const [held, setHeld] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (import.meta.env.DEV !== true) return children;

  const replay = () => {
    window.clearTimeout(timer.current);
    onReplay?.();
    setHeld(true);
    timer.current = window.setTimeout(() => {
      setHeld(false);
      setRun((count) => count + 1);
    }, holdMs);
  };
  const button = "rounded-md px-2.5 py-1 hover:bg-[var(--muted)] hover:text-[var(--foreground)]";
  return (
    <>
      {held ? null : <div key={run} className="contents">{children}</div>}
      <div
        data-dev-replay=""
        className="fixed bottom-4 left-4 z-50 flex items-center gap-1 rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)] p-1 text-[12px] text-[var(--muted-foreground)] [-webkit-app-region:no-drag]"
      >
        <span className="px-1.5 font-mono uppercase tracking-wide">dev</span>
        <button type="button" className={button} onClick={replay}>
          Rejouer l’entrée
        </button>
        <button type="button" className={button} onClick={() => window.location.reload()}>
          Recharger
        </button>
      </div>
    </>
  );
}
