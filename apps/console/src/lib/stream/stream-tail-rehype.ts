/**
 * « Stream Text » (streaming-ui.pulseview.app, Chat collection) as a rehype
 * step: while an answer streams, its newest characters sit in a blurred,
 * masked tail followed by a solid caret, so the text resolves out of a blur
 * as it moves out of the tail. `ThreadMarkdown` applies it to the LAST block
 * of a streaming text only; settled blocks and finished answers never carry
 * it. Styles: `.openedbot-stream-tail`, `.openedbot-stream-caret` (thread-timeline.css).
 *
 * Code (`pre`, `code`) and math are never split: Shiki and KaTeX own them.
 * When the stream is writing one (it is the last thing in the tree), there
 * is no blurred tail and the caret follows the block: putting it on the
 * prose BEFORE the code would show the cursor where nothing is written.
 */

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
export type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };
export type HastRoot = { type: "root"; children: HastNode[] };

const OPAQUE_TAGS = new Set(["pre", "code", "math", "svg"]);

/** How many of the newest characters stream out of the blur. */
export const STREAM_TAIL_CHARS = 6;

export function isHastElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

/** A subtree effects must not split: code, math, an inline SVG. */
export function isOpaqueHastElement(node: HastElement): boolean {
  if (OPAQUE_TAGS.has(node.tagName)) return true;
  const className = node.properties?.className;
  return Array.isArray(className) && className.some((name) => typeof name === "string" && name.startsWith("katex"));
}

type LastText = { parent: { children: HastNode[] }; index: number } | "opaque" | null;

/**
 * The last non-blank text node, with its parent, walking from the end; or
 * `"opaque"` when code or math comes last: the stream is inside it.
 */
function lastText(parent: { children: HastNode[] }): LastText {
  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index]!;
    if (child.type === "text" && (child as HastText).value.trim()) return { parent, index };
    if (isHastElement(child)) {
      if (isOpaqueHastElement(child)) return "opaque";
      const found = lastText(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Only the LAST top-level block is being written: the tail never climbs back
 * into an earlier paragraph (a fresh empty bullet keeps the caret on itself).
 * Splitting the text into blocks therefore never moves the caret.
 */
function streamingText(tree: HastRoot): LastText {
  for (let index = tree.children.length - 1; index >= 0; index -= 1) {
    const child = tree.children[index]!;
    if (child.type === "text") {
      if ((child as HastText).value.trim()) return { parent: tree, index };
      continue;
    }
    if (!isHastElement(child)) continue;
    return isOpaqueHastElement(child) ? "opaque" : lastText(child);
  }
  return null;
}

/**
 * Flips on every parse of the streaming block, i.e. on every text update. The
 * caret carries it as `data-tick`, and the stylesheet names a different
 * blink animation for each value, so every update restarts the blink: the
 * caret stays solid while tokens arrive and only blinks once they stop.
 */
let caretTick = 0;

export function rehypeStreamTail() {
  return (tree: HastRoot) => {
    caretTick = 1 - caretTick;
    const caret: HastElement = {
      type: "element",
      tagName: "span",
      properties: { className: ["openedbot-stream-caret"], ariaHidden: "true", dataTick: String(caretTick) },
      children: [],
    };
    const found = streamingText(tree);
    if (found === null || found === "opaque") {
      tree.children.push(caret);
      return;
    }
    const node = found.parent.children[found.index] as HastText;
    const chars = Array.from(node.value.trimEnd());
    const split = Math.max(0, chars.length - STREAM_TAIL_CHARS);
    found.parent.children.splice(
      found.index,
      1,
      { type: "text", value: chars.slice(0, split).join("") },
      {
        type: "element",
        tagName: "span",
        properties: { className: ["openedbot-stream-tail"] },
        children: [{ type: "text", value: chars.slice(split).join("") }],
      },
      caret,
    );
  };
}

/**
 * Block-level reveal: every top-level element (every item of a list) of a block that was mounted
 * while the answer streams gets `openedbot-reveal` (blur-in, thread-timeline.css).
 * It adds a class and nothing else, so the DOM stays the one a single
 * Markdown render would give.
 */
export function rehypeReveal() {
  const mark = (element: HastElement) => {
    const existing = element.properties?.className;
    element.properties = {
      ...element.properties,
      className: [...(Array.isArray(existing) ? existing : []), "openedbot-reveal"],
    };
  };
  return (tree: HastRoot) => {
    for (const child of tree.children) {
      if (!isHastElement(child)) continue;
      // A list reveals item by item: an item is a DOM node born once, so a
      // re-parse of the growing list never replays the ones already there.
      if (child.tagName === "ul" || child.tagName === "ol") {
        for (const item of child.children) if (isHastElement(item) && item.tagName === "li") mark(item);
      } else {
        mark(child);
      }
    }
  };
}

/** Splits text into words that keep their trailing whitespace: `join("")` gives the text back. */
function streamWords(text: string): string[] {
  return text.match(/\s+|\S+\s*/g) ?? [];
}

function wrapWords(parent: { children: HastNode[] }): void {
  parent.children = parent.children.flatMap((child): HastNode[] => {
    if (child.type === "text") {
      return streamWords((child as HastText).value).map((word): HastNode =>
        word.trim()
          ? { type: "element", tagName: "span", properties: { className: ["stream-w"] }, children: [{ type: "text", value: word }] }
          : { type: "text", value: word },
      );
    }
    if (isHastElement(child) && !isOpaqueHastElement(child)) wrapWords(child);
    return [child];
  });
}

/**
 * the reference app's streamed answer (`Words`, `.stream-w`): every word is its own
 * span, so React keeps the spans already on screen and only a NEW word plays
 * its 200 ms blur-in (`.stream-w`, stream-motion.css). No tail, no caret. A
 * word still being written keeps its span as it grows: it never replays.
 *
 * Code and math are never split (Shiki and KaTeX own them): a top-level one
 * born in the stream blurs in as a whole (`openedbot-reveal`), once.
 */
export function rehypeStreamWords() {
  return (tree: HastRoot) => {
    for (const child of tree.children) {
      if (isHastElement(child) && isOpaqueHastElement(child)) {
        const existing = child.properties?.className;
        child.properties = {
          ...child.properties,
          className: [...(Array.isArray(existing) ? existing : []), "openedbot-reveal"],
        };
      }
    }
    wrapWords(tree);
  };
}
