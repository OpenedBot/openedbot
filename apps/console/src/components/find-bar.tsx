import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { stepThreadFindIndex } from "@openedbot/roster/domain/thread-find";

export type FindBarLabels = {
  search: string;
  placeholder: string;
  previous: string;
  next: string;
  close: string;
  noResults: string;
  resultPosition: (current: number, total: number) => string;
};

export type FindBarProps = {
  open: boolean;
  query: string;
  matchCount: number;
  currentIndex: number;
  labels: FindBarLabels;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onCurrentIndexChange: (index: number) => void;
};

/**
 * Controlled integration surface for thread search.
 *
 * Mount it once beside the transcript. Feed `query`, `matchCount` and
 * `currentIndex` from `searchThreadFindIndex`; when the index changes, scroll
 * the matching `targetId` into view. The component owns Cmd/Ctrl+F, Enter,
 * Shift+Enter and Escape, but never owns transcript data or scrolling.
 */
export function FindBar({
  open,
  query,
  matchCount,
  currentIndex,
  labels,
  onOpenChange,
  onQueryChange,
  onCurrentIndexChange,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const openFind = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", openFind);
    return () => window.removeEventListener("keydown", openFind);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  if (!open) return null;
  const displayedIndex = currentIndex >= 0 && currentIndex < matchCount ? currentIndex : 0;
  const move = (delta: -1 | 1) => {
    const next = stepThreadFindIndex(currentIndex, matchCount, delta);
    if (next >= 0) onCurrentIndexChange(next);
  };

  return (
    <section
      role="search"
      aria-label={labels.search}
      className="flex items-center gap-1 rounded-lg border border-border bg-background p-1 shadow-sm"
    >
      <Search aria-hidden className="ml-1 size-4 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onOpenChange(false);
          } else if (event.key === "Enter") {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          }
        }}
        aria-label={labels.search}
        aria-keyshortcuts="Meta+F Control+F"
        placeholder={labels.placeholder}
        className="h-8 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <span role="status" aria-live="polite" className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">
        {matchCount > 0
          ? labels.resultPosition(displayedIndex + 1, matchCount)
          : labels.noResults}
      </span>
      <button
        type="button"
        disabled={matchCount === 0}
        onClick={() => move(-1)}
        aria-label={labels.previous}
        className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      >
        <ChevronUp aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        disabled={matchCount === 0}
        onClick={() => move(1)}
        aria-label={labels.next}
        className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      >
        <ChevronDown aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        aria-label={labels.close}
        className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden className="size-4" />
      </button>
    </section>
  );
}
