/**
 * Thread lab text effect (dev only), a rehype step on the thread's own
 * markdown (`threadMarkdownSetup`), from streaming-ui.pulseview.app/responses:
 * `rehypeLabWords` ("Streaming Text", Transitions) wraps every word in a span.
 * React keeps the spans already in the DOM, so only a NEW word plays its
 * 350 ms blur-in (`thread-lab.css`). The tail + caret effect the console
 * shipped lives in `lib/stream/stream-tail-rehype.ts`.
 */
import { isHastElement, isOpaqueHastElement, type HastNode, type HastRoot } from "../stream/stream-tail-rehype";

/** Splits text into words that keep their trailing whitespace: `join("")` gives the text back. */
export function labWords(text: string): string[] {
  return text.match(/\s+|\S+\s*/g) ?? [];
}

function wrapWords(parent: { children: HastNode[] }): void {
  parent.children = parent.children.flatMap((child): HastNode[] => {
    if (child.type === "text") {
      return labWords((child as { value: string }).value).map((word) =>
        word.trim()
          ? { type: "element", tagName: "span", properties: { className: ["lab-word"] }, children: [{ type: "text", value: word }] }
          : { type: "text", value: word },
      );
    }
    if (isHastElement(child) && !isOpaqueHastElement(child)) wrapWords(child);
    return [child];
  });
}

export function rehypeLabWords() {
  return (tree: HastRoot) => {
    wrapWords(tree);
  };
}
