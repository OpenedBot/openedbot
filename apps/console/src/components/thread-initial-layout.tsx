import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ThreadSkeleton } from "./thread-skeleton";

const MAX_WAIT_MS = 2_000;

/** Only the first reveal waits: streaming and later history remain interactive. */
export function waitForThreadLayout(root: HTMLElement, reveal: () => void, timeoutMs = MAX_WAIT_MS): () => void {
  let stopped = false;
  let frame = 0;
  const pending = () => root.querySelector("[data-thread-layout-pending]") !== null
    || Array.from(root.querySelectorAll("img")).some((image) => !image.complete);
  const finish = () => {
    if (stopped) return;
    cleanup();
    reveal();
  };
  // Two paints after the last media change let the transcript's ResizeObserver
  // restore its bottom anchor before it becomes visible.
  const check = () => {
    cancelAnimationFrame(frame);
    if (pending()) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { if (!pending()) finish(); });
    });
  };
  const observer = new MutationObserver(check);
  const cleanup = () => {
    stopped = true;
    clearTimeout(timeout);
    cancelAnimationFrame(frame);
    observer.disconnect();
    root.removeEventListener("load", check, true);
    root.removeEventListener("error", check, true);
  };
  const timeout = setTimeout(finish, timeoutMs);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-thread-layout-pending", "src"] });
  root.addEventListener("load", check, true);
  root.addEventListener("error", check, true);
  if (pending()) check();
  else finish();
  return cleanup;
}

/** Lay out real rows under the silhouette, without exposing Mermaid source first. */
export function ThreadInitialLayout({ threadKey, children }: { threadKey: string | null; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState<{ key: string | null } | null>(null);
  const ready = revealed?.key === threadKey;
  useLayoutEffect(() => {
    if (!content.current) return;
    return waitForThreadLayout(content.current, () => setRevealed({ key: threadKey }));
  }, [threadKey]);
  return (
    <div data-thread-initial-layout={ready ? "ready" : "pending"} className="relative flex min-h-0 flex-1 flex-col">
      <div ref={content} inert={!ready} aria-hidden={!ready || undefined} className="relative flex min-h-0 flex-1 flex-col" style={{ visibility: ready ? undefined : "hidden" }}>
        {children}
      </div>
      {ready ? null : <div className="absolute inset-0 flex min-h-0 flex-col"><ThreadSkeleton /></div>}
    </div>
  );
}
