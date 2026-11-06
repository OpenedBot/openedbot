import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Entry } from "./thread-timeline-model";
import { entryRunId } from "./thread-timeline-signature";
import {
  charsPerLineFor,
  estimateEntryHeight,
  holdRows,
  layoutRows,
  overscanFor,
  rowsAround,
  spacerHeights,
  tailRows,
  timelineTurns,
  type RowRange,
  type TurnSpan,
} from "./thread-virtual";

/**
 * The thread's virtual rows (D1d, `thread-virtual.ts` for the arithmetic).
 *
 * Owns three things the timeline used to get from the browser:
 *
 * - which turns are mounted: the tail for a reader pinned to the bottom,
 *   otherwise the turns around the viewport, plus the turns that hold the
 *   text selection or the keyboard focus, and every turn between them
 *   (copying a selection that spans several messages needs them all in the
 *   DOM);
 * - the height of every turn, measured while mounted, estimated before;
 * - the reading position of a reader who is NOT pinned: an element at the
 *   top of the view is the anchor, and whatever changes above it (a turn
 *   mounted in place of its estimate, an image that decodes, older history
 *   prepended) moves the scroll by the same amount, before the paint. The
 *   column keeps `overflow-anchor: none` (the pinned reader follows the
 *   bottom, `thread-anchor.ts`), and WKWebView, which the desktop moves to,
 *   has no scroll anchoring at all.
 */

export const THREAD_ROW_ATTRIBUTE = "data-thread-turn";

type StoredRange = { firstKey: string; lastKey: string; version: number };
type Reveal = { targetId: string; turnKey: string; block: ScrollLogicalPosition };

/** Does `entry` render the element `[data-thread-find-target=targetId]`? Same ids as the bubbles and `thread-find`. */
export function entryHoldsTarget(entry: Entry, targetId: string): boolean {
  if ("targetId" in entry && entry.targetId === targetId) return true;
  if (entry.kind === "assistant" && entry.messageId && `message:${entry.messageId}` === targetId) return true;
  return targetId.startsWith("run:") && entryRunId(entry) === targetId.slice(4);
}

function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    // An engine without the selector: keep the focused turn, the safe side.
    return true;
  }
}

/**
 * The turn opened by the entry `key`, or the one that holds it now: a turn
 * opened by a run without a message (a welcome) joins the turn before it
 * once older history arrives.
 */
function turnIndexOf(turns: readonly TurnSpan[], entries: readonly Entry[], key: string): number {
  const own = turns.findIndex((turn) => turn.key === key);
  if (own >= 0) return own;
  const entryIndex = entries.findIndex((entry) => entry.key === key);
  return entryIndex < 0 ? -1 : turns.findIndex((turn) => entryIndex >= turn.start && entryIndex < turn.end);
}

export function useThreadVirtualRows({
  scroller,
  entries,
  pinned,
  atBottom,
  resetKey,
  gap,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  entries: readonly Entry[];
  pinned: RefObject<boolean>;
  atBottom: boolean;
  resetKey: unknown;
  gap: number;
}) {
  const turns = useMemo(() => timelineTurns(entries), [entries]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const measured = useRef(new Map<string, number>());
  const estimates = useRef(new WeakMap<Entry, { chars: number; height: number }>());
  const viewport = useRef({
    height: typeof window === "undefined" ? 800 : window.innerHeight,
    width: typeof window === "undefined" ? 720 : Math.min(window.innerWidth, 720),
  });
  const rowNodes = useRef(new Map<string, HTMLElement>());
  /**
   * The anchor and, should it be re-rendered, what finds its place again: the
   * message it belongs to (`data-thread-find-target`, which survives a turn
   * row mounted anew) and its row. Tops are in the view, at `scrollTop`.
   */
  const anchor = useRef<{
    element: Element;
    top: number;
    target: { id: string; top: number } | null;
    row: Element;
    rowTop: number;
    scrollTop: number;
  } | null>(null);
  const reveal = useRef<Reveal | null>(null);
  const rendered = useRef<RowRange>({ first: 0, last: -1 });
  const [stored, setStored] = useState<StoredRange | null>(null);

  const heightsOf = useCallback((list: readonly TurnSpan[]): number[] => {
    const chars = charsPerLineFor(viewport.current.width);
    const all = entriesRef.current;
    return list.map((turn) => {
      const known = measured.current.get(turn.key);
      if (known !== undefined) return known;
      let height = 0;
      for (let index = turn.start; index < turn.end; index += 1) {
        const entry = all[index]!;
        let cached = estimates.current.get(entry);
        if (!cached || cached.chars !== chars) {
          cached = { chars, height: estimateEntryHeight(entry, chars) };
          estimates.current.set(entry, cached);
        }
        height += cached.height + (index > turn.start ? gap : 0);
      }
      return height;
    });
  }, [gap]);

  /** Rows held by the selection or the focus, by index. */
  const heldRows = useCallback((): number[] => {
    if (typeof document === "undefined") return [];
    const keys = new Set<string>();
    const rowOf = (node: Node | null | undefined) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const row = element?.closest(`[${THREAD_ROW_ATTRIBUTE}]`);
      const key = row && scroller.current?.contains(row) ? row.getAttribute(THREAD_ROW_ATTRIBUTE) : null;
      if (key) keys.add(key);
    };
    const selection = document.getSelection?.();
    if (selection && !selection.isCollapsed) {
      rowOf(selection.anchorNode);
      rowOf(selection.focusNode);
    }
    // Keyboard focus only: a click also focuses a message, and holding it
    // would keep every turn between it and a far scroll mounted. A reader on
    // the keyboard must not lose their place when the turn leaves the view.
    const focused = document.activeElement;
    if (focused && focused !== document.body && matchesFocusVisible(focused)) rowOf(focused);
    if (keys.size === 0) return [];
    const held: number[] = [];
    turnsRef.current.forEach((turn, index) => {
      if (keys.has(turn.key)) held.push(index);
    });
    return held;
  }, [scroller]);

  // The range of this render. Pinned: the tail, recomputed here so the commit
  // that pins (a send, a new approval) already mounts what the bottom shows.
  const heights = heightsOf(turns);
  const layout = layoutRows(heights, gap);
  const overscan = overscanFor(viewport.current.height);
  let range: RowRange | null = null;
  if (!atBottom && stored) {
    const first = turnIndexOf(turns, entries, stored.firstKey);
    const last = turnIndexOf(turns, entries, stored.lastKey);
    if (first >= 0 && last >= first) range = { first, last };
  }
  range ??= tailRows(layout, heights, viewport.current.height, overscan);
  range = holdRows(range, heldRows(), turns.length);
  const spacers = spacerHeights(layout, heights, range, gap);
  const visibleStart = range.last >= range.first ? turns[range.first]!.start : entries.length;
  const visibleEnd = range.last >= range.first ? turns[range.last]!.end : entries.length;
  const visible = useMemo(
    () => (visibleStart === 0 && visibleEnd === entries.length ? entries : entries.slice(visibleStart, visibleEnd)),
    [entries, visibleStart, visibleEnd],
  );
  const renderedRange = range;

  const viewTop = (node: HTMLElement) => node.getBoundingClientRect().top;

  const captureAnchor = useCallback(() => {
    const node = scroller.current;
    if (!node || pinned.current) {
      anchor.current = null;
      return;
    }
    const box = node.getBoundingClientRect();
    const { first, last } = rendered.current;
    for (let index = first; index <= last; index += 1) {
      const row = rowNodes.current.get(turnsRef.current[index]?.key ?? "");
      if (!row) continue;
      const rowBox = row.getBoundingClientRect();
      if (rowBox.bottom <= box.top) continue;
      // The first row in view, never one below it: a view that only shows a
      // spacer (a jump far up) has nothing to hold, the rows mounted there
      // simply replace their estimate.
      if (rowBox.top >= box.bottom) break;
      // The deepest element at the top of the view, inside this row: a
      // paragraph, a line of code, an image. Anchoring the row itself would
      // miss a change inside the row above the line being read. Not a day
      // chip: older history loaded above removes the chip of a turn whose
      // previous turn turns out to be of the same day.
      const probeX = rowBox.left + Math.min(rowBox.width / 2, 48);
      let element: Element = row;
      for (let step = 0; step < 4 && typeof document.elementFromPoint === "function"; step += 1) {
        const hit = document.elementFromPoint(probeX, Math.max(box.top, rowBox.top) + 2 + step * 24);
        if (hit && hit !== row && row.contains(hit) && !hit.closest("[data-thread-date]")) {
          element = hit;
          break;
        }
      }
      const target = element.closest("[data-thread-find-target]");
      const targetId = target && row.contains(target) ? target.getAttribute("data-thread-find-target") : null;
      anchor.current = {
        element,
        top: element.getBoundingClientRect().top - box.top,
        target: targetId ? { id: targetId, top: target!.getBoundingClientRect().top - box.top } : null,
        row,
        rowTop: rowBox.top - box.top,
        scrollTop: node.scrollTop,
      };
      return;
    }
    anchor.current = null;
  }, [pinned, scroller]);

  /** Puts the anchor back where the reader saw it. Returns whether the scroll moved. */
  const restoreAnchor = useCallback(() => {
    const node = scroller.current;
    const held = anchor.current;
    if (!node || pinned.current) return false;
    // Nothing held (the view showed only a spacer, or the reader just left
    // the bottom): what is in view now is what the next change must keep.
    // The element gone (re-rendered): its message, else its row, holds the place.
    // A turn opened by a run without a message (a welcome) joins the turn
    // before it once older history arrives: its row is mounted anew.
    const target = !held?.element.isConnected && held?.target
      ? scroller.current?.querySelector(`[data-thread-find-target="${CSS.escape(held.target.id)}"]`) ?? null
      : null;
    const place: [Element, number] | null = !held ? null
      : held.element.isConnected ? [held.element, held.top]
      : target ? [target, held.target!.top]
      : held.row.isConnected ? [held.row, held.rowTop]
      : null;
    if (!held || !place) {
      captureAnchor();
      return false;
    }
    const [element, top] = place;
    // A scroll since the capture (the reader's, before its `scroll` event
    // reached us) moves the anchor too: only the rest is a change of layout.
    const expected = top - (node.scrollTop - held.scrollTop);
    const drift = element.getBoundingClientRect().top - viewTop(node) - expected;
    if (Math.abs(drift) < 0.5) return false;
    node.scrollTop += drift;
    captureAnchor();
    return true;
  }, [captureAnchor, pinned, scroller]);

  /** Range wanted for the current scroll; a new render only when it differs from the rendered one. */
  const sync = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    if (node.clientHeight > 0) viewport.current = { height: node.clientHeight, width: node.clientWidth };
    const list = turnsRef.current;
    if (list.length === 0) return;
    const rowHeights = heightsOf(list);
    const rowLayout = layoutRows(rowHeights, gap);
    const span = overscanFor(viewport.current.height);
    let wanted: RowRange;
    if (pinned.current) {
      wanted = tailRows(rowLayout, rowHeights, viewport.current.height, span);
    } else {
      // Where the rows start in the scrolled content: read on the first mounted row.
      const firstIndex = rendered.current.first;
      const firstRow = rowNodes.current.get(list[firstIndex]?.key ?? "");
      const listTop = firstRow
        ? firstRow.getBoundingClientRect().top - viewTop(node) + node.scrollTop - (rowLayout.offsets[firstIndex] ?? 0)
        : 0;
      wanted = rowsAround(rowLayout, rowHeights, { top: node.scrollTop - listTop, height: viewport.current.height }, span);
    }
    wanted = holdRows(wanted, heldRows(), list.length);
    const current = rendered.current;
    if (wanted.first === current.first && wanted.last === current.last) return;
    setStored((previous) => ({
      firstKey: list[wanted.first]!.key,
      lastKey: list[wanted.last]!.key,
      version: (previous?.version ?? 0) + 1,
    }));
  }, [gap, heightsOf, heldRows, pinned, scroller]);

  const measureMounted = useCallback(() => {
    for (const [key, row] of rowNodes.current) {
      if (row.isConnected) measured.current.set(key, row.offsetHeight);
    }
  }, []);

  // Rows resize after their commit (an image, Shiki, a folding block, the
  // live answer): measured, then the anchor is put back before the paint.
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver((records) => {
      for (const record of records) {
        const key = (record.target as HTMLElement).getAttribute(THREAD_ROW_ATTRIBUTE);
        if (key) measured.current.set(key, (record.target as HTMLElement).offsetHeight);
      }
      restoreAnchor();
      sync();
    });
    observer.current = next;
    for (const row of rowNodes.current.values()) next.observe(row);
    if (scroller.current) next.observe(scroller.current);
    return () => {
      next.disconnect();
      observer.current = null;
    };
  }, [restoreAnchor, scroller, sync]);

  const refs = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const rowRef = useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (node: HTMLElement | null) => {
        const previous = rowNodes.current.get(key);
        if (previous && previous !== node) observer.current?.unobserve(previous);
        if (node) {
          rowNodes.current.set(key, node);
          observer.current?.observe(node);
        } else {
          rowNodes.current.delete(key);
          refs.current.delete(key);
        }
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);

  // Every commit: a pending jump lands first, else the anchor is put back
  // (rows mounted or prepended above it); then the mounted rows are measured
  // and the range follows. A range that changes renders again before the paint.
  useLayoutEffect(() => {
    rendered.current = renderedRange;
    const pending = reveal.current;
    if (pending) {
      // The target itself, or its turn when a folded block hides it.
      const target = scroller.current?.querySelector<HTMLElement>(`[data-thread-find-target="${CSS.escape(pending.targetId)}"]`)
        ?? rowNodes.current.get(pending.turnKey);
      if (target) {
        reveal.current = null;
        target.scrollIntoView({ block: pending.block });
        captureAnchor();
      }
    } else {
      restoreAnchor();
    }
    measureMounted();
    sync();
  });

  // Another thread in the same timeline: its turns start from estimates, at the bottom.
  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    measured.current.clear();
    anchor.current = null;
    reveal.current = null;
    setStored(null);
  }, [resetKey]);

  /** The reader scrolled: new anchor, new range. */
  const onScroll = useCallback(() => {
    captureAnchor();
    sync();
  }, [captureAnchor, sync]);

  /**
   * Mounts the turn that holds `targetId` and lands on it after the commit.
   * Returns false when no loaded turn holds it.
   */
  const revealTarget = useCallback((targetId: string, block: ScrollLogicalPosition = "start"): boolean => {
    const list = turnsRef.current;
    const all = entriesRef.current;
    const entryIndex = all.findIndex((entry) => entryHoldsTarget(entry, targetId));
    if (entryIndex < 0) return false;
    const turn = list.find((candidate) => entryIndex >= candidate.start && entryIndex < candidate.end);
    if (!turn) return false;
    reveal.current = { targetId, turnKey: turn.key, block };
    setStored((previous) => ({ firstKey: turn.key, lastKey: turn.key, version: (previous?.version ?? 0) + 1 }));
    return true;
  }, []);

  return {
    turns,
    range: renderedRange,
    visible,
    visibleStart,
    spacers,
    rowRef,
    onScroll,
    captureAnchor,
    revealTarget,
  };
}
