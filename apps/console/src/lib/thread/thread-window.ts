/**
 * Live DOM window over an already-built timeline.
 *
 * The snapshot can hold hundreds of turns; only the trailing window is
 * mounted. Older turns stay in the array and prepend when the operator
 * asks. A turn starts at a `kind: "user"` entry (or at index 0). Entries
 * without `kind` (tests, plain keyed lists) are one turn each.
 *
 * Not a virtualizer: no recycled markdown, no `column-reverse`.
 */

export const THREAD_LIVE_TURN_WINDOW = 40;
/**
 * Turns mounted for the first paint of a thread. The rest of the live window
 * follows once the browser is idle: mounting 40 turns at once cost the first
 * paint several hundred milliseconds of render and layout.
 */
export const THREAD_FIRST_PAINT_TURN_WINDOW = 8;
export const THREAD_WINDOW_PAGE = 30;

export type TimelineKeyed = {
  key: string;
  kind?: string;
};

export function isTimelineTurnStart(
  item: TimelineKeyed,
  index: number,
): boolean {
  if (item.kind === undefined) return true;
  return index === 0 || item.kind === "user";
}

export function countTimelineTurns(entries: readonly TimelineKeyed[]): number {
  let count = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (isTimelineTurnStart(entries[index]!, index)) count += 1;
  }
  return count;
}

export type TimelineWindow<T extends TimelineKeyed> = {
  visible: readonly T[];
  hasOlder: boolean;
  hiddenTurns: number;
  turnCount: number;
};

/**
 * Trailing `liveTurns` turns. Same `entries` reference when nothing is hidden.
 */
export function windowTimelineEntries<T extends TimelineKeyed>(
  entries: readonly T[],
  liveTurns: number,
): TimelineWindow<T> {
  const turnCount = countTimelineTurns(entries);
  if (liveTurns <= 0 || turnCount <= liveTurns) {
    return { visible: entries, hasOlder: false, hiddenTurns: 0, turnCount };
  }
  const keepFrom = turnCount - liveTurns;
  let seen = 0;
  let start = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (!isTimelineTurnStart(entries[index]!, index)) continue;
    if (seen === keepFrom) {
      start = index;
      break;
    }
    seen += 1;
  }
  return {
    visible: entries.slice(start),
    hasOlder: true,
    hiddenTurns: keepFrom,
    turnCount,
  };
}

export function growTimelineWindow(
  liveTurns: number,
  page: number,
  turnCount: number,
): number {
  if (turnCount <= 0) return liveTurns;
  if (liveTurns >= turnCount) return turnCount;
  return Math.min(turnCount, liveTurns + Math.max(0, page));
}

/**
 * Previous page of turns concatenated in front of the current window.
 * The last keys of `visible` stay in the result.
 */
export function prependTimelinePage<T extends TimelineKeyed>(
  entries: readonly T[],
  visible: readonly T[],
  pageTurns: number,
): TimelineWindow<T> {
  const grown = growTimelineWindow(
    countTimelineTurns(visible),
    pageTurns,
    countTimelineTurns(entries),
  );
  return windowTimelineEntries(entries, grown);
}
