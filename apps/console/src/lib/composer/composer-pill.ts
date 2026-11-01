/**
 * The composer as a pill (desktop), modelled on the Grok Bot desktop prompt
 * (0.75.5, `o_t` in its `index.eager-app` bundle): one row, `+` | field |
 * actions, that opens into a card (text across the whole width, the actions
 * on a row below) as soon as the text needs a second line.
 *
 * Open on a newline, or as soon as the field wraps at the COMPACT width (its
 * scroll height reaches a second line). Once open, stay open until the field
 * is empty: at full width the same text often fits one line again, and
 * closing there would make the pill flip on every keystroke.
 */
export function nextComposerExpanded(
  wasExpanded: boolean,
  field: { value: string; scrollHeight: number },
  lineHeightPx: number,
): boolean {
  if (field.value.includes("\n") || field.scrollHeight >= lineHeightPx * 1.6) return true;
  return wasExpanded && field.value.length > 0;
}
