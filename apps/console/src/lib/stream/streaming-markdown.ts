import { useRef } from "react";

type Fence = { marker: "`" | "~"; length: number };

/**
 * Rend un préfixe Markdown stable pendant le streaming.
 *
 * `react-markdown` reçoit sinon successivement `` ` ``, `` `` `` puis
 * `` ```ts `` : un paragraphe devient soudain un bloc de code, puis un bloc
 * non fermé reparcourt toute la réponse à chaque caractère. On retient la
 * ligne d'ouverture jusqu'à son saut de ligne et on ferme virtuellement un
 * bloc déjà ouvert. La fermeture virtuelle ne produit aucun texte visible et
 * disparaît dès que le runtime livre la vraie.
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
      // Une ouverture sans fin de ligne n'a pas encore de langage ni de corps
      // stable : le prochain fragment la rendra en une seule fois.
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
/** Définitions de liens et de notes : lues depuis n'importe quel bloc. */
const DEFINITION_LINE = /^ {0,3}\[[^\]]+\]:/;
/** Un bloc HTML peut enjamber une ligne vide (`<pre>`, commentaire). */
const HTML_LINE = /^ {0,3}</;

/**
 * Découpe une réponse en blocs Markdown de premier niveau, pour qu'un
 * `react-markdown` par bloc rende exactement ce que rendrait un seul
 * `react-markdown` sur le tout : pendant le flux, seul le dernier bloc change
 * et se reparse, les blocs terminés gardent le même texte (donc leur `memo`).
 *
 * On ne coupe qu'à une ligne vide hors fence et hors `$$`, et jamais devant
 * une ligne indentée (suite d'un élément de liste, code indenté) ni devant un
 * élément de liste quand le bloc courant en contient déjà un (liste lâche).
 * Une définition de lien ou un bloc HTML n'importe où : pas de découpe.
 * Dans le doute on fusionne : un bloc trop gros reste exact, une coupe de
 * trop ne l'est pas.
 */
export function splitMarkdownBlocks(text: string): string[] {
  return splitBlocks(text).blocks;
}

/** Les blocs, l'indice de début de chacun dans le texte, et `whole` : une ligne interdit toute découpe. */
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

/** Une découpe et ce qu'il faut pour la prolonger (`splitMarkdownBlocksFrom`). */
export type MarkdownBlockSplit = { text: string; blocks: string[]; starts: number[] };

/**
 * `splitMarkdownBlocks(text)`, en ne redécoupant que la fin quand `text`
 * prolonge le texte de `previous` : pendant le flux, chaque frame coûtait une
 * découpe de toute la réponse. Une coupe ne dépend que des lignes qui la
 * précèdent et de la PREMIÈRE ligne du bloc qu'elle ouvre (indentée, élément
 * de liste, fence) : les coupes dont cette ligne est complète sont
 * définitives, la découpe reprend au début du premier bloc qui n'en a pas,
 * dans l'état d'un début de texte. Seule exception, une définition de lien ou
 * un bloc HTML arrivés dans la fin : tout se redécoupe (un seul bloc).
 */
export function splitMarkdownBlocksFrom(previous: MarkdownBlockSplit | undefined, text: string): MarkdownBlockSplit {
  if (previous?.text === text) return previous;
  let resume = 0;
  if (previous && text.startsWith(previous.text)) {
    const last = previous.blocks.length - 1;
    // Un dernier bloc dont la première ligne s'écrit encore peut ne pas en
    // être un (« 1 » deviendra « 1. », qui prolonge une liste) : on reprend
    // alors au bloc d'avant, ouvert par une ligne complète.
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

/** Les blocs de `markdown`, redécoupés seulement à la fin quand il ne fait que s'allonger. */
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
 * Ferme un `$` / `$$` encore ouvert. Sans ça, remark-math avale tout le
 * suffixe du stream dès le premier dollar.
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
