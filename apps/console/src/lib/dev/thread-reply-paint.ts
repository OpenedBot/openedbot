type PaintBounds = { top: number; right: number; bottom: number; left: number };

/** An overflow scrollport can hide text that is still inside the window. */
export function intersectPaintBounds(bounds: PaintBounds, clip: Partial<PaintBounds>): PaintBounds | null {
  const result = {
    top: Math.max(bounds.top, clip.top ?? bounds.top),
    right: Math.min(bounds.right, clip.right ?? bounds.right),
    bottom: Math.min(bounds.bottom, clip.bottom ?? bounds.bottom),
    left: Math.max(bounds.left, clip.left ?? bounds.left),
  };
  return result.bottom > result.top && result.right > result.left ? result : null;
}

/** A particular text prefix, retained across the two-frame paint approximation. */
export type ReplyText = { node: Text; content: string };

export function replyTextVisible(text: ReplyText): boolean {
  const { node, content } = text;
  if (!node.isConnected || !node.data.startsWith(content) || !content.trim()) return false;
  const parent = node.parentElement;
  if (!parent || parent.closest('button, svg, script, style, [aria-hidden="true"], [inert], .sr-only')) return false;
  const range = document.createRange();
  range.setStart(node, content.search(/\S/u));
  range.setEnd(node, content.trimEnd().length);
  // Range rects cover text lines, not the bubble's padding or empty block area.
  let visible = Array.from(range.getClientRects())
    .map((rect) => intersectPaintBounds(rect, { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }))
    .filter((bounds): bounds is PaintBounds => bounds !== null);
  for (let element: HTMLElement | null = parent; visible.length && element; element = element.parentElement) {
    const style = getComputedStyle(element);
    // Visibility is inherited but children may explicitly override it.
    if ((element === parent && /^(hidden|collapse)$/.test(style.visibility)) || style.display === "none" || style.opacity === "0") return false;
    const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
    const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
    if (clipsX || clipsY) {
      const rect = element.getBoundingClientRect();
      const clip = {
        ...(clipsY ? { top: rect.top + element.clientTop, bottom: rect.top + element.clientTop + element.clientHeight } : {}),
        ...(clipsX ? { left: rect.left + element.clientLeft, right: rect.left + element.clientLeft + element.clientWidth } : {}),
      };
      visible = visible.map((bounds) => intersectPaintBounds(bounds, clip)).filter((bounds): bounds is PaintBounds => bounds !== null);
    }
  }
  return visible.length > 0;
}

export function visibleReplyText(container: HTMLElement): ReplyText | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = { node: node as Text, content: node.textContent ?? "" };
    if (replyTextVisible(text)) return text;
  }
  return null;
}
