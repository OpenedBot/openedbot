/*
  How a line of a bot reply is read before rendering (thread-markdown.tsx):
  an ASCII tree, a bare path listing, an intro line, a lead label, a title.
  Pure text helpers, no React.
*/

/**
 * An ASCII tree must stay a grid: otherwise Markdown treats plain line
 * breaks as spaces. The branch glyphs are specific enough
 * not to turn an ordinary sentence into a code block.
 */
export function looksLikeAsciiDiagram(text: string): boolean {
  const lines = text.split("\n");
  const treeLines = lines.filter((line) => /[├└┌┐┬┴│─]/u.test(line));
  const branchCount = text.match(/[├└┌┐]/gu)?.length ?? 0;
  return treeLines.length >= 2 || branchCount >= 2;
}

/**
 * Some models return a flattened tree by separating each branch
 * with a space (`├── a ├── b`) instead of a line break. Only
 * the branch separators are rewritten, so a real multi-line tree stays unchanged.
 */
export function normalizeAsciiDiagram(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const branchCount = line.match(/[├└]/gu)?.length ?? 0;
      return branchCount >= 2
        ? line.replace(/[ \t]+(?=(?:[│ ]*[├└]──))/gu, "\n").split("\n")
        : [line];
    })
    .join("\n");
}

/**
 * A line that is only a path: `src/`, `Domain/`, `src/Order/UI/Http/...`,
 * `tests/Unit/…`. No space, at least one slash, optionally a
 * trailing ellipsis.
 */
const PATH_LINE = /^[\w.@~-]+(?:\/[\w.@*~-]*)*\/?(?:\.{3}|…)?$/u;

/**
 * A tree written WITHOUT a fence: the model lists its folders line by
 * line (`src/`, `Shared/`, `Domain/`…). Rendered as prose, each line became
 * a paragraph, and the split into cards took `Application/` for a
 * title, measured on a real Symfony architecture reply. Two consecutive
 * paths are enough: an ordinary sentence never has this shape.
 */
export function looksLikePathListing(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  if (!lines.every((line) => PATH_LINE.test(line))) return false;
  return lines.filter((line) => line.includes("/")).length >= 2;
}

/**
 * « Principes techniques : », « Structure proposée : », « Pour la couche API,
 * je ferais ce choix : »: a short line that exists only to announce what
 * follows. The model does not mark it up; in running text it drowned in
 * the paragraphs (measured). It becomes an intertitle: semi-bold, a little
 * air above, without changing element.
 */
const INTRO_LINE = /^[^.!?\n]{3,90}[:：]$/u;

/**
 * « Domain : entités, value objects… »: a paragraph that starts with a
 * short label followed by a colon is a definition; the label carries the
 * bold, the rest is the prose. One to four words, letters and digits,
 * initial capital: « POST /orders/{id}/confirm : … » or « http://… » do not
 * match.
 */
const LEAD_LABEL = /^(\p{Lu}[\p{L}\p{N}'’-]*(?:[ \u00A0][\p{L}\p{N}'’-]+){0,3})([ \u00A0]?[:：][ \u00A0]+)(?=\S)/u;

/** A lone connector (« Mais : », « Donc : ») is not a label. */
const LABEL_CONNECTOR = /^(donc|ici|ainsi|ensuite|enfin|or|puis|mais|car|alors|soit|sauf|bref|so|then|but|also|however)$/iu;

export function isIntroLine(text: string): boolean {
  return INTRO_LINE.test(text.trim());
}

/** Cuts `Domain : suite` into `[label, separator, rest]`, or `null`. */
export function splitLeadLabel(text: string): [string, string, string] | null {
  const match = text.match(LEAD_LABEL);
  if (!match) return null;
  const label = match[1]!;
  if (label.length > 40 || LABEL_CONNECTOR.test(label)) return null;
  return [label, match[2]!, text.slice(match[0].length)];
}

/**
 * « 1. Ce qui tient\nLes reference.md… »: a short first line, with no
 * final punctuation, followed by a line break, is the title of what
 * follows. Without that, only a colon title went bold and the sections
 * of the same reply were read in two ways (measured).
 */
const TITLE_LINE_MAX = 80;

export function isTitleLine(text: string): boolean {
  const line = text.trim();
  return line.length > 0 && line.length <= TITLE_LINE_MAX && !/[.!?…;,]$/u.test(line);
}
