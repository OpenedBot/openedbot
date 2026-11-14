/**
 * Diagrams already drawn, kept for the session. The thread unmounts the rows
 * scrolled away (virtual rows, `use-thread-virtual-rows.ts`): without this, a
 * row mounted back showed the Mermaid source, then its drawing a moment later,
 * and changed height under the reader (measured 2026-11-11). With it, a known
 * diagram is drawn from its first render.
 *
 * One entry per source and theme: the SVG carries the theme's colours.
 */
const LIMIT = 64;

const drawings = new Map<string, string>();

const keyOf = (source: string, dark: boolean) => `${dark ? "dark" : "light"}\n${source}`;

/** The drawing of this source in this theme, if it was already drawn. */
export function drawnMermaid(source: string, dark: boolean): string | null {
  return drawings.get(keyOf(source, dark)) ?? null;
}

/** Keeps a drawing; beyond the limit, the one kept longest ago leaves. */
export function keepMermaid(source: string, dark: boolean, svg: string): void {
  const key = keyOf(source, dark);
  // A `Map` iterates in insertion order: re-inserting makes this entry the newest.
  drawings.delete(key);
  drawings.set(key, svg);
  if (drawings.size > LIMIT) {
    const oldest = drawings.keys().next();
    if (!oldest.done) drawings.delete(oldest.value);
  }
}

/** Tests only. */
export function forgetMermaidDrawings(): void {
  drawings.clear();
}
