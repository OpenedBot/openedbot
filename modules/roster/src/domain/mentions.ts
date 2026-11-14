/**
 * Mentions `@bot` dans le composer et dans le rendu d'un message.
 *
 * Trois usages distincts partagent ce fichier : détecter le token `@…` en
 * cours de saisie sous le caret, faire correspondre une requête à des bots,
 * et reconnaître après coup les mentions dans un texte déjà écrit (rendu).
 * Aucun DOM ici: le composer (React Native / web) fournit texte + caret,
 * ce module ne fait que du texte pur.
 */
export {
  normalizeForMatch,
  type MentionableBot,
} from "./bot-identity";
import {
  normalizeForMatch,
  type MentionableBot,
} from "./bot-identity";

export type TextRange = { start: number; end: number };

const WHITESPACE_RE = /\s/;

/**
 * Le token `@…` en cours de saisie sous le caret.
 *
 * Commence par `@`, précédé du début de texte ou d'un espace/retour ligne, ne
 * contient pas d'espace jusqu'au caret. `end` vaut toujours `caret` : seul ce
 * qui précède le caret compte, pas la suite du mot déjà tapé.
 */
export function findMentionTrigger(
  text: string,
  caret: number,
): (TextRange & { query: string }) | null {
  let at = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i] ?? "";
    if (ch === "@") {
      at = i;
      break;
    }
    if (WHITESPACE_RE.test(ch)) return null;
  }
  if (at === -1) return null;

  const before = at > 0 ? text[at - 1] : undefined;
  if (before !== undefined && !WHITESPACE_RE.test(before)) return null;

  return { start: at, end: caret, query: text.slice(at + 1, caret) };
}

/**
 * Le mot qui se termine AU caret (suite de non-espaces, caret en fin de mot :
 * le caractère au caret est absent ou un espace), d'au moins 2 caractères, et
 * qui ne commence pas par `@` (déjà couvert par `findMentionTrigger`).
 */
export function findWordAtCaret(
  text: string,
  caret: number,
): (TextRange & { word: string }) | null {
  const atCaret = text[caret];
  if (atCaret !== undefined && !WHITESPACE_RE.test(atCaret)) return null;

  let start = caret;
  while (start > 0 && !WHITESPACE_RE.test(text[start - 1] ?? "")) start--;

  const word = text.slice(start, caret);
  if (word.length < 2) return null;
  if (word.startsWith("@")) return null;

  return { start, end: caret, word };
}

/**
 * Bots dont le slug OU le nom normalisé commence par la query normalisée.
 * Query vide → tous les bots (hors `excludeId`).
 *
 * Ordre stable : correspondance exacte (slug ou nom) d'abord, puis préfixe de
 * slug, puis préfixe de nom ; à égalité, le nom le plus court, puis l'ordre
 * d'entrée.
 */
export function matchBots(
  query: string,
  bots: readonly MentionableBot[],
  opts?: { excludeId?: string },
): MentionableBot[] {
  const q = normalizeForMatch(query);
  const excludeId = opts?.excludeId;

  const RANK_EXACT = 0;
  const RANK_SLUG_PREFIX = 1;
  const RANK_NAME_PREFIX = 2;

  const ranked: Array<{ bot: MentionableBot; rank: number; index: number }> = [];

  bots.forEach((bot, index) => {
    if (excludeId !== undefined && bot.id === excludeId) return;

    const slug = normalizeForMatch(bot.slug);
    const name = normalizeForMatch(bot.name);

    if (q === "") {
      ranked.push({ bot, rank: RANK_NAME_PREFIX, index });
      return;
    }

    if (slug === q || name === q) {
      ranked.push({ bot, rank: RANK_EXACT, index });
      return;
    }
    if (slug.startsWith(q)) {
      ranked.push({ bot, rank: RANK_SLUG_PREFIX, index });
      return;
    }
    if (name.startsWith(q)) {
      ranked.push({ bot, rank: RANK_NAME_PREFIX, index });
      return;
    }
  });

  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.bot.name.length !== b.bot.name.length) {
      return a.bot.name.length - b.bot.name.length;
    }
    return a.index - b.index;
  });

  return ranked.map((r) => r.bot);
}

/** `matchBots(word)[0]` si `word.length >= 2`, sinon `null`. */
export function bestPlainMatch(
  word: string,
  bots: readonly MentionableBot[],
  opts?: { excludeId?: string },
): MentionableBot | null {
  if (word.length < 2) return null;
  return matchBots(word, bots, opts)[0] ?? null;
}

/** Remplace `[start, end)` par `@slug ` ; le caret se place après l'espace. */
export function applyMention(
  text: string,
  range: TextRange,
  slug: string,
): { text: string; caret: number } {
  const replacement = `@${slug} `;
  const nextText = text.slice(0, range.start) + replacement + text.slice(range.end);
  return { text: nextText, caret: range.start + slug.length + 2 };
}

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; slug: string; raw: string };

/** `@` suivi d'au moins un caractère `[a-z0-9-]` (insensible à la casse). */
const MENTION_TOKEN_RE = /@[A-Za-z0-9-]+/g;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Découpe un texte en segments texte / mention.
 *
 * Une mention reconnue nécessite : précédée de BOL ou d'un caractère qui
 * n'est ni lettre, ni chiffre, ni `_` (donc pas d'email) ; le slug (insensible
 * à la casse) doit exister dans `slugs`: le plus long candidat gagne (ex.
 * `@neo-2` avant `@neo`). L'espace/retour-ligne qui précède `@` reste dans le
 * segment texte précédent, pour préserver `whitespace-pre-wrap`. Segments
 * texte adjacents fusionnés, aucun segment vide.
 */
export function segmentMentions(
  text: string,
  slugs: ReadonlySet<string> | readonly string[],
): MentionSegment[] {
  if (text === "") return [];

  const bySlugLower = new Map<string, string>();
  for (const slug of slugs) {
    bySlugLower.set(slug.toLowerCase(), slug);
  }

  const segments: MentionSegment[] = [];
  let textStart = 0;

  const pushText = (chunk: string) => {
    if (chunk === "") return;
    const last = segments[segments.length - 1];
    if (last?.kind === "text") {
      last.text += chunk;
    } else {
      segments.push({ kind: "text", text: chunk });
    }
  };

  MENTION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_TOKEN_RE.exec(text)) !== null) {
    const matchStart = match.index;
    const before = matchStart > 0 ? text[matchStart - 1] : undefined;
    if (isWordChar(before)) continue;

    const token = match[0]; // inclut le "@"
    const body = token.slice(1);
    // Le token entier (jusqu'à la prochaine frontière) doit être un slug
    // connu : pas de correspondance partielle, sinon "@neo-2" avec seul
    // "neo" dans `slugs` créerait une mention suivie d'un "-2" collé, ce que
    // la frontière interdit ("-" fait partie de la classe autorisée).
    const matchedSlug = bySlugLower.get(body.toLowerCase()) ?? null;
    if (matchedSlug === null) continue;

    const mentionEnd = matchStart + token.length;
    pushText(text.slice(textStart, matchStart));
    segments.push({
      kind: "mention",
      slug: matchedSlug,
      raw: text.slice(matchStart, mentionEnd),
    });
    textStart = mentionEnd;
    MENTION_TOKEN_RE.lastIndex = mentionEnd;
  }

  pushText(text.slice(textStart));

  return segments;
}
