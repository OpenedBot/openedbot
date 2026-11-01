import { segmentMentions, type TextRange } from "@openedbot/roster/domain/mentions";

/**
 * Mention chips of the composer.
 *
 * The field stays a plain `textarea` (PWA contract: iOS keyboard, IME, paste,
 * grow). A chip is only a painted layer over the typed `@slug`: the value the
 * API receives never changes. These helpers are pure text so the atomic
 * behaviour (Backspace removes the whole token) can be tested without a DOM.
 */

/** The ranges of `value` that are a known `@slug` mention, in order. */
export function mentionRanges(value: string, slugs: readonly string[]): TextRange[] {
  if (!slugs.length || !value.includes("@")) return [];
  const ranges: TextRange[] = [];
  let offset = 0;
  for (const segment of segmentMentions(value, slugs)) {
    const length = segment.kind === "mention" ? segment.raw.length : segment.text.length;
    if (segment.kind === "mention") ranges.push({ start: offset, end: offset + length });
    offset += length;
  }
  return ranges;
}

/** The mention that ENDS at `caret`, so a Backspace there removes it as one unit. */
export function mentionEndingAt(
  value: string,
  caret: number,
  slugs: readonly string[],
): TextRange | null {
  return mentionRanges(value, slugs).find((range) => range.end === caret) ?? null;
}

/** Removes `range` from `value`; the caret lands where the token began. */
export function removeRange(value: string, range: TextRange): { text: string; caret: number } {
  return { text: value.slice(0, range.start) + value.slice(range.end), caret: range.start };
}

const MIRRORED_PROPERTIES = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderLeftWidth",
  "borderRightWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "tabSize",
  "overflowWrap",
  "wordBreak",
] as const;

/**
 * Horizontal position of the character at `index` inside `field`, in px from
 * the field's left edge. Measured on a throwaway off-screen copy of the field
 * (a textarea gives no caret geometry), so the mention menu can open at the
 * caret as in the reference instead of at the card's corner.
 */
export function caretOffsetLeft(field: HTMLTextAreaElement, index: number): number {
  const style = getComputedStyle(field);
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  for (const property of MIRRORED_PROPERTIES) probe.style[property] = style[property];
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.top = "0";
  probe.style.left = "-9999px";
  probe.style.whiteSpace = "pre-wrap";
  probe.textContent = field.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  probe.appendChild(marker);
  document.body.appendChild(probe);
  try {
    return marker.offsetLeft;
  } finally {
    probe.remove();
  }
}

/**
 * Splits the `text` segments of a mirror at the mention `ranges` of the whole
 * value, so the chip layer paints exactly the typed characters (same text,
 * same advance widths: a chip never adds a glyph).
 */
export function markMentions<T extends { kind: string; text: string }>(
  segments: readonly T[],
  ranges: readonly TextRange[],
): Array<T | { kind: "mention"; text: string }> {
  if (!ranges.length) return [...segments];
  const out: Array<T | { kind: "mention"; text: string }> = [];
  let offset = 0;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    if (segment.kind !== "text") {
      out.push(segment);
      offset = end;
      continue;
    }
    let cursor = offset;
    for (const range of ranges) {
      if (range.end <= cursor || range.start >= end) continue;
      if (range.start > cursor) {
        out.push({ ...segment, text: segment.text.slice(cursor - offset, range.start - offset) });
      }
      const from = Math.max(range.start, cursor);
      const to = Math.min(range.end, end);
      out.push({ kind: "mention", text: segment.text.slice(from - offset, to - offset) });
      cursor = to;
    }
    if (cursor < end) out.push({ ...segment, text: segment.text.slice(cursor - offset) });
    offset = end;
  }
  return out;
}
