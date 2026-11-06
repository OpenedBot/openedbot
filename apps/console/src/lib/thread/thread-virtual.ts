/**
 * Virtual rows of the thread (D1d, ADR 0001 section 3.4): the arithmetic,
 * without React or the DOM.
 *
 * A row is a TURN: a user message and everything its run produced, or a run
 * without a message. Only the rows near the viewport are mounted; the others
 * are two spacers, one above and one below, whose height is the sum of what
 * the rows they stand for measured the last time they were mounted, or an
 * estimate drawn from their content when they never were.
 *
 * Measured on a 374-turn thread (`scripts/perf/long-thread.ts`): with every
 * loaded turn mounted, the DOM held 47 700 nodes and scrolling fell to 30 fps
 * at p5; the flat 120 px placeholder of `content-visibility` made a 194 000 px
 * thread read as 47 000 px, and scrolling up jumped by up to 4 585 px.
 */

import type { Entry } from "./thread-timeline-model";

export type TimelineKeyed = {
  key: string;
  kind?: string;
};

/** A turn opens at a `user` entry, or at index 0. Entries without `kind` (tests, plain keyed lists) are one turn each. */
export function isTimelineTurnStart(item: TimelineKeyed, index: number): boolean {
  if (item.kind === undefined) return true;
  return index === 0 || item.kind === "user";
}

/** One row: the entries `[start, end)` of `shown`, named by the key of their first entry. */
export type TurnSpan = { key: string; start: number; end: number };

export function timelineTurns(entries: readonly TimelineKeyed[]): TurnSpan[] {
  const turns: TurnSpan[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (!isTimelineTurnStart(entries[index]!, index)) continue;
    const previous = turns.at(-1);
    if (previous) previous.end = index;
    turns.push({ key: entries[index]!.key, start: index, end: entries.length });
  }
  return turns;
}

/** Rows mounted beyond each edge of the viewport: one viewport, never less than this. */
export const THREAD_OVERSCAN_MIN_PX = 600;

export function overscanFor(viewportHeight: number): number {
  return Math.max(THREAD_OVERSCAN_MIN_PX, viewportHeight);
}

/**
 * Where each row starts, from the top of the first one, rows `gap` apart.
 * `total` is the height of all rows with the gaps between them.
 */
export type RowLayout = { offsets: number[]; total: number };

export function layoutRows(heights: readonly number[], gap: number): RowLayout {
  const offsets = new Array<number>(heights.length);
  let at = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index] = at;
    at += heights[index]! + gap;
  }
  return { offsets, total: Math.max(0, at - gap) };
}

export type RowRange = { first: number; last: number };

/**
 * The rows that cross `[top - overscan, top + height + overscan]`, `top`
 * counted from the first row. Empty (`last < first`) when there is no row.
 */
export function rowsAround(layout: RowLayout, heights: readonly number[], view: { top: number; height: number }, overscan: number): RowRange {
  const count = heights.length;
  if (count === 0) return { first: 0, last: -1 };
  const from = view.top - overscan;
  const to = view.top + view.height + overscan;
  let first = 0;
  while (first < count - 1 && layout.offsets[first]! + heights[first]! < from) first += 1;
  let last = first;
  while (last < count - 1 && layout.offsets[last + 1]! <= to) last += 1;
  return { first, last };
}

/** The last rows, enough to fill `height + overscan` from the bottom: what a reader pinned to the bottom sees. */
export function tailRows(layout: RowLayout, heights: readonly number[], height: number, overscan: number): RowRange {
  const count = heights.length;
  if (count === 0) return { first: 0, last: -1 };
  return rowsAround(layout, heights, { top: layout.total - height, height }, overscan);
}

/** The smallest contiguous range holding `range` and every index of `held` (a selection, the focused row). */
export function holdRows(range: RowRange, held: readonly number[], count: number): RowRange {
  let { first, last } = range;
  for (const index of held) {
    if (index < 0 || index >= count) continue;
    first = Math.min(first, index);
    last = Math.max(last, index);
  }
  return { first, last };
}

/**
 * Heights of the spacers that stand for the unmounted rows. Each spacer is a
 * flex item of the same column: the gap that follows it stands for the gap of
 * its last row, so it is one gap shorter than its rows.
 */
export function spacerHeights(layout: RowLayout, heights: readonly number[], range: RowRange, gap: number): { top: number; bottom: number } {
  const count = heights.length;
  if (count === 0 || range.last < range.first) return { top: 0, bottom: 0 };
  const top = range.first > 0 ? layout.offsets[range.first]! - gap : 0;
  const lastEnd = layout.offsets[range.last]! + heights[range.last]!;
  const bottom = range.last < count - 1 ? layout.total - lastEnd - gap : 0;
  return { top: Math.max(0, top), bottom: Math.max(0, bottom) };
}

// --- Estimates ---------------------------------------------------------------
// A row that was never mounted takes the height its content suggests. The
// figures follow the thread's type (15 px text on 22.5 px lines, 12 px code
// on 20 px lines, `max-h-64` images): an estimate only has to be close,
// a row is measured as soon as it is mounted, and the anchor keeps what the
// reader looks at in place while the estimate is corrected.

const LINE_PX = 23;
const CODE_LINE_PX = 20;
const IMAGE_PX = 290;

function wrapped(line: string, charsPerLine: number): number {
  return Math.max(1, Math.ceil(line.length / charsPerLine));
}

/** Rendered height of an answer's markdown, line by line. */
export function estimateMarkdownHeight(text: string, charsPerLine: number): number {
  let height = 0;
  let inFence = false;
  let paragraphOpen = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      // The block's margin and padding, at its top and at its bottom.
      height += 24;
      inFence = !inFence;
      paragraphOpen = false;
      continue;
    }
    if (inFence) {
      height += CODE_LINE_PX;
      continue;
    }
    if (trimmed === "") {
      paragraphOpen = false;
      continue;
    }
    if (!paragraphOpen) height += 12;
    paragraphOpen = true;
    if (/^#{1,6}\s/u.test(trimmed)) height += 34;
    else if (trimmed.startsWith("|")) height += /^\|[\s:|-]+\|$/u.test(trimmed) ? 0 : 37;
    else if (trimmed === "$$") height += 20;
    else height += LINE_PX * wrapped(trimmed, charsPerLine);
  }
  return height;
}

function attachmentsHeight(attachments: readonly { kind?: string }[] | undefined): number {
  if (!attachments?.length) return 0;
  const images = attachments.filter((attachment) => attachment.kind === "image").length;
  return images * IMAGE_PX + (attachments.length > images ? 36 : 0);
}

/** One entry, without the gap that follows it. */
export function estimateEntryHeight(entry: Entry, charsPerLine: number): number {
  switch (entry.kind) {
    case "user":
      return 40 + LINE_PX * entry.text.split("\n").reduce((sum, line) => sum + wrapped(line, Math.floor(charsPerLine * 0.7)), 0) + attachmentsHeight(entry.attachments);
    case "assistant":
      return 44 + estimateMarkdownHeight(entry.text, charsPerLine) + attachmentsHeight(entry.attachments);
    case "gate":
      return 120;
    case "event":
      return 36;
    default:
      // tools, plan, search: a settled turn folds its work in one line.
      return 40;
  }
}

/** Characters on one line of an answer `width` px wide (15 px text, ~7.4 px a character). */
export function charsPerLineFor(width: number): number {
  return Math.max(24, Math.min(120, Math.floor(width / 7.4)));
}

/** Turns in one page of `GET /api/threads/:id/history` (`parseThreadHistoryLimit`'s default): what "load earlier" brings. */
export const THREAD_HISTORY_PAGE_TURNS = 40;
