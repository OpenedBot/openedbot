/**
 * Reading a paragraph's leading text through the stream's word spans
 * (`rehypeStreamWords`): the lead-title and lead-label heuristics of
 * `ThreadMarkdown` must see « Ce qui tient » whether it arrives as one text
 * node or as words the stream is still blurring in.
 */
import { isValidElement, type ReactNode } from "react";

/** A word the stream wrote (`rehypeStreamWords`): a bare `span.grok-w` around its text. */
function streamWordText(node: ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return null;
  if (node.type !== "span" || node.props.className !== "grok-w") return null;
  return typeof node.props.children === "string" ? node.props.children : null;
}

/** The bare text a paragraph opens with: its leading strings and stream words, and how many items that is. */
export function leadingText(items: ReactNode[]): { text: string; count: number } {
  let text = "";
  let count = 0;
  for (const item of items) {
    const word = typeof item === "string" ? item : streamWordText(item);
    if (word === null) break;
    text += word;
    count += 1;
  }
  return { text, count };
}

/**
 * The items left once the first `length` characters of the leading text are
 * taken: whole stream words keep their span (no replay); a word cut in the
 * middle leaves its remainder as plain text.
 */
export function itemsAfter(items: ReactNode[], length: number): ReactNode[] {
  let consumed = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const text = typeof item === "string" ? item : streamWordText(item) ?? "";
    if (consumed + text.length <= length) {
      consumed += text.length;
      continue;
    }
    const remainder = text.slice(length - consumed);
    return [remainder, ...items.slice(index + 1)];
  }
  return [];
}
