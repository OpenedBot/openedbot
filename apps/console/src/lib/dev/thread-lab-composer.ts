/**
 * Thread lab "Pill" composer geometry (dev only), modelled on the Grok Bot
 * desktop prompt (0.75.5, `index.eager-app` bundle: `o_t`, `s_t`, `u_t`):
 * one shell whose height is set explicitly, the text pad inside it, and the
 * action row laid OVER it in absolute position. Nothing moves in the DOM:
 * expanding only changes the shell height, the pad padding and where the row
 * sits (centred on a 44 px line, or pinned 8 px above the bottom edge).
 */
import { nextComposerExpanded } from "../composer/composer-pill";

/** The field's line height (`leading-6`). */
export const PILL_LINE_PX = 24;
/** One-line shell: a 36 px button with 6 px around it. */
export const PILL_COMPACT_PX = 48;
/** Expanded pad: text starts 12 px below the top, the action row takes 8 + 36 + 8 px at the bottom. */
export const PILL_PAD_TOP_PX = 12;
export const PILL_PAD_BOTTOM_PX = 52;
/** Inset of the action row and of the text from the leading `+` (8 + 36 + 8). */
export const PILL_ROW_INSET_PX = 8;
export const PILL_LEADING_PX = PILL_ROW_INSET_PX + 36 + PILL_ROW_INSET_PX;

/** The console's own rule (`lib/composer/composer-pill.ts`), at the lab field's line height. */
export function nextPillExpanded(
  wasExpanded: boolean,
  field: { value: string; scrollHeight: number },
  lineHeightPx = PILL_LINE_PX,
): boolean {
  return nextComposerExpanded(wasExpanded, field, lineHeightPx);
}

/** The shell height for the field's (already capped) content height. */
export function pillShellHeight(expanded: boolean, contentHeightPx: number): number {
  return expanded ? PILL_PAD_TOP_PX + Math.max(PILL_LINE_PX, contentHeightPx) + PILL_PAD_BOTTOM_PX : PILL_COMPACT_PX;
}
