import { useRef } from "react";

type Fence = { marker: "`" | "~"; length: number };

/**
 * Renders a stable Markdown prefix during streaming.
 *
 * Otherwise `react-markdown` receives in succession `` ` ``, `` `` `` then
 * `` ```ts ``: a paragraph suddenly becomes a code block, then an unclosed
 * block rewalks the whole answer on every character. The opening
 * line is held until its line break and an already open
 * block is closed virtually. The virtual closing produces no visible text and
 * disappears as soon as the runtime delivers the real one.
 */
export function stabilizeStreamingThreadMarkdown(text: string): string {
  return closeOpenMath(stabilizeStreamingMarkdown(text));
}

export function stabilizeStreamingMarkdown(text: string): string {
  if (!text) return text;
  const trailingLineStart = text.lastIndexOf("\n") + 1;
  const trailingLine = text.slice(trailingLineStart);
  const scanEnd = text.endsWith("\n") ? text.length : trailingLineStart;
  let fence = scanFences(text.slice(0, scanEnd));

  if (!text.endsWith("\n")) {
    const marker = fenceMarker(trailingLine);
    if (marker && !fence) {
      // An opening without a line end does not yet have a language or a stable
      // body: the next fragment will render it in one go.
      return text.slice(0, trailingLineStart);
    }
    if (
      marker &&
      fence &&
      marker.marker === fence.marker &&
      marker.length >= fence.length &&
      marker.rest.trim() === ""
    ) {
      fence = null;
    }
  }

  if (!fence) return text;
  const withoutPartialClosing = stripPartialClosingFence(text, fence);
  const separator = withoutPartialClosing.endsWith("\n") ? "" : "\n";
  return `${withoutPartialClosing}${separator}${fence.marker.repeat(fence.length)}`;
}

const BLANK_LINE = /^[ \t]*$/;
const LIST_ITEM_LINE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const MATH_FENCE_OPEN = /^ {0,3}\$\$/;
const MATH_FENCE_CLOSE = /^ {0,3}\$\$[ \t]*$/;
/** Link and note definitions: read from any block. */
const DEFINITION_LINE = /^ {0,3}\[[^\]]+\]:/;
/** An HTML block can span a blank line (`<pre>`, comment). */
const HTML_LINE = /^ {0,3}</;

/**
 * Splits an answer into top-level Markdown blocks, so that one
 * `react-markdown` per block renders exactly what a single
 * `react-markdown` on the whole would: during the stream, only the last block changes
 * and reparses, finished blocks keep the same text (therefore their `memo`).
 *
 * It cuts only at a blank line outside a fence and outside `$$`, and never before
 * an indented line (continuation of a list item, indented code) nor before a
 * list item when the current block already contains one (loose list).
 * A link definition or an HTML block anywhere: no split.
 * When in doubt it merges: a block that is too big stays exact, a cut too
 * many does not.
 */
export function splitMarkdownBlocks(text: string): string[] {
  return splitBlocks(text).blocks;
}

/** The blocks, the start index of each in the text, and `whole`: one line forbids any split. */
function splitBlocks(text: string): { blocks: string[]; starts: number[]; whole: boolean } {
  const lines = text.split("\n");
  if (lines.some((line) => DEFINITION_LINE.test(line) || HTML_LINE.test(line))) {
    return BLANK_LINE.test(text) ? { blocks: [], starts: [], whole: true } : { blocks: [text], starts: [0], whole: true };
  }
  const blocks: string[] = [];
  const starts: number[] = [];
  let current: string[] = [];
  let blanks: string[] = [];
  let currentHasList = false;
  let fence: Fence | null = null;
  let math = false;
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (fence || math) {
      current.push(...blanks, line);
      blanks = [];
      if (fence) {
        const marker = fenceMarker(line);
        if (marker && marker.marker === fence.marker && marker.length >= fence.length && marker.rest.trim() === "") {
          fence = null;
        }
      } else if (MATH_FENCE_CLOSE.test(line)) {
        math = false;
      }
      continue;
    }
    if (BLANK_LINE.test(line)) {
      if (current.length > 0) blanks.push(line);
      continue;
    }
    const continues = /^[ \t]/.test(line) || (currentHasList && LIST_ITEM_LINE.test(line));
    if (current.length > 0 && blanks.length > 0 && !continues) {
      blocks.push(current.join("\n"));
      current = [];
      currentHasList = false;
    } else {
      current.push(...blanks);
    }
    blanks = [];
    if (current.length === 0) starts.push(lineStart);
    current.push(line);
    if (LIST_ITEM_LINE.test(line)) currentHasList = true;
    const marker = fenceMarker(line);
    if (marker) fence = { marker: marker.marker, length: marker.length };
    else if (MATH_FENCE_OPEN.test(line)) math = true;
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return { blocks, starts, whole: false };
}

/** A split and what is needed to extend it (`splitMarkdownBlocksFrom`). */
export type MarkdownBlockSplit = { text: string; blocks: string[]; starts: number[] };

/**
 * `splitMarkdownBlocks(text)`, resplitting only the end when `text`
 * extends `previous`'s text: during the stream, every frame cost a
 * split of the whole answer. A cut depends only on the lines that
 * precede it and on the FIRST line of the block it opens (indented, list
 * item, fence): cuts whose that line is complete are
 * final, the split resumes at the start of the first block that does not have one,
 * in the state of a start of text. The only exception, a link definition or
 * an HTML block arrived in the end: everything is resplit (a single block).
 */
export function splitMarkdownBlocksFrom(previous: MarkdownBlockSplit | undefined, text: string): MarkdownBlockSplit {
  if (previous?.text === text) return previous;
  let resume = 0;
  if (previous && text.startsWith(previous.text)) {
    const last = previous.blocks.length - 1;
    // A last block whose first line is still being written may not be
    // one (« 1 » will become « 1. », which continues a list): it then resumes
    // at the block before, opened by a complete line.
    resume = last > 0 && previous.text.indexOf("\n", previous.starts[last]) === -1 ? last - 1 : Math.max(0, last);
  }
  if (resume > 0) {
    const from = previous!.starts[resume]!;
    const tail = splitBlocks(text.slice(from));
    if (!tail.whole) {
      return {
        text,
        blocks: [...previous!.blocks.slice(0, resume), ...tail.blocks],
        starts: [...previous!.starts.slice(0, resume), ...tail.starts.map((start) => start + from)],
      };
    }
  }
  const { blocks, starts } = splitBlocks(text);
  return { text, blocks, starts };
}

/** The blocks of `markdown`, resplit only at the end when it is only growing. */
export function useMarkdownBlocks(markdown: string): string[] {
  const split = useRef<MarkdownBlockSplit | undefined>(undefined);
  split.current = splitMarkdownBlocksFrom(split.current, markdown);
  return split.current.blocks;
}

function scanFences(text: string): Fence | null {
  let open: Fence | null = null;
  for (const line of text.split("\n")) {
    const marker = fenceMarker(line);
    if (!marker) continue;
    if (!open) {
      open = marker;
      continue;
    }
    if (marker.marker === open.marker && marker.length >= open.length && marker.rest.trim() === "") {
      open = null;
    }
  }
  return open;
}

function fenceMarker(line: string): (Fence & { rest: string }) | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const run = match[1]!;
  return { marker: run[0] as Fence["marker"], length: run.length, rest: match[2] ?? "" };
}

function stripPartialClosingFence(text: string, fence: Fence): string {
  const start = text.lastIndexOf("\n") + 1;
  const trailing = text.slice(start);
  const match = /^ {0,3}([`~]{1,2})$/.exec(trailing);
  if (!match || match[1]![0] !== fence.marker) return text;
  return text.slice(0, start);
}

/**
 * Closes a `$` / `$$` still open. Without that, remark-math swallows the whole
 * stream suffix from the first dollar.
 */
export function closeOpenMath(text: string): string {
  if (!text) return text;
  let displayOpen = false;
  let inlineOpen = false;
  let fence: Fence | null = null;
  for (const line of text.split("\n")) {
    const marker = fenceMarker(line);
    if (marker) {
      if (!fence) fence = { marker: marker.marker, length: marker.length };
      else if (
        marker.marker === fence.marker &&
        marker.length >= fence.length &&
        marker.rest.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    let i = 0;
    while (i < line.length) {
      if (line.startsWith("$$", i)) {
        displayOpen = !displayOpen;
        inlineOpen = false;
        i += 2;
        continue;
      }
      if (line[i] === "$" && line[i - 1] !== "\\") {
        if (!displayOpen) inlineOpen = !inlineOpen;
        i += 1;
        continue;
      }
      i += 1;
    }
  }
  if (displayOpen) return `${text}${text.endsWith("\n") ? "" : "\n"}$$`;
  if (inlineOpen) return `${text}$`;
  return text;
}
