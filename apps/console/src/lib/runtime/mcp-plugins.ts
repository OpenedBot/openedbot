/**
 * Reconnaissance d'un serveur MCP connecté dans un texte en cours de saisie.
 *
 * Le composer colore le mot quand il désigne un plugin MCP que l'hôte sert
 * réellement : « Regarde dans notion… » se lit alors comme un appel possible,
 * pas comme une phrase quelconque. C'est une AIDE VISUELLE, jamais un contrat :
 * rien ici ne décide qu'un outil sera appelé, et le runtime reste seul juge.
 *
 * Aucun DOM : le composer fournit le texte, ce module rend des segments.
 * La normalisation est celle des mentions (`normalizeForMatch`), pour qu'un
 * accent ou une majuscule ne change jamais la reconnaissance.
 */
import { normalizeForMatch } from "@openedbot/roster/domain/bot-identity";

/** Un mot désigne un plugin exactement, ou à peu près (préfixe, coquille). */
export type McpPluginMatchKind = "exact" | "approximate";

export type McpPluginMatch = { name: string; kind: McpPluginMatchKind };

/** En deçà, « on » ou « no » colorerait la moitié d'une phrase. */
const MIN_APPROXIMATE_LENGTH = 3;
/** Une coquille ne se tolère que sur un mot déjà long. */
const MIN_TYPO_LENGTH = 4;

/**
 * Les alias reconnus pour un nom de serveur.
 *
 * Les hôtes nomment leurs serveurs de trois façons pour la même chose :
 * `notion`, `mcp-notion`, `notion-mcp`. L'opérateur, lui, tape « notion ».
 * On compare donc AUSSI le nom débarrassé de son affixe `mcp`.
 */
function aliasesOf(name: string): string[] {
  const normalized = normalizeForMatch(name);
  if (normalized === "") return [];
  const stripped = normalized
    .replace(/^mcp[-_ ]+/, "")
    .replace(/[-_ ]+mcp$/, "");
  return stripped === normalized || stripped === "" ? [normalized] : [normalized, stripped];
}

/**
 * Distance d'édition bornée, avec transposition (Damerau–Levenshtein OSA).
 *
 * La transposition compte pour UNE opération, pas deux : « notino » pour
 * « notion » est la coquille la plus courante au clavier, et la Levenshtein
 * nue la classait à distance 2, donc hors tolérance. Au-delà de `max`, la
 * fonction rend `max + 1` sans finir le calcul.
 */
function editDistance(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let twoBack: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (
        i > 1 && j > 1 &&
        left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, (twoBack[j - 2] ?? 0) + 1);
      }
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    twoBack = previous;
    previous = current;
  }
  return previous[right.length] ?? max + 1;
}

/**
 * Le plugin que ce mot désigne, ou `null`.
 *
 * Trois degrés, dans cet ordre : le mot EST le nom (`exact`) ; le mot est un
 * préfixe du nom ou le nom un préfixe du mot: « noti », « notions »
 * (`approximate`) ; le mot est à une coquille près du nom: « notino »
 * (`approximate`). À égalité, le nom le plus court gagne, puis l'ordre
 * d'entrée : deux serveurs `notion` et `notion-calendar` ne se départagent
 * pas autrement.
 */
export function matchMcpPlugin(
  word: string,
  names: readonly string[],
): McpPluginMatch | null {
  const w = normalizeForMatch(word);
  if (w.length < 2) return null;

  const RANK_EXACT = 0;
  const RANK_PREFIX = 1;
  const RANK_TYPO = 2;

  let best: { name: string; rank: number; length: number; index: number } | null = null;

  const rankOf = (alias: string): number | null => {
    if (alias === w) return RANK_EXACT;
    if (
      w.length >= MIN_APPROXIMATE_LENGTH &&
      (alias.startsWith(w) || w.startsWith(alias))
    ) return RANK_PREFIX;
    if (
      w.length >= MIN_TYPO_LENGTH &&
      alias.length >= MIN_TYPO_LENGTH &&
      editDistance(w, alias, 1) <= 1
    ) return RANK_TYPO;
    return null;
  };

  names.forEach((name, index) => {
    // TOUS les alias sont jugés, pas seulement le premier qui accroche :
    // `notion_mcp` accroche déjà en préfixe sur « notion », alors que son
    // alias débarrassé de l'affixe accroche en EXACT: c'est celui-là qui doit
    // classer le serveur.
    let rank: number | null = null;
    let length = 0;
    for (const alias of aliasesOf(name)) {
      const aliasRank = rankOf(alias);
      if (aliasRank === null) continue;
      if (rank === null || aliasRank < rank) {
        rank = aliasRank;
        length = alias.length;
      }
    }
    if (rank === null) return;

    const candidate = { name, rank, length, index };
    if (
      best === null ||
      candidate.rank < best.rank ||
      (candidate.rank === best.rank && candidate.length < best.length) ||
      (candidate.rank === best.rank && candidate.length === best.length && candidate.index < best.index)
    ) {
      best = candidate;
    }
  });

  if (best === null) return null;
  const found: { name: string; rank: number } = best;
  return { name: found.name, kind: found.rank === RANK_EXACT ? "exact" : "approximate" };
}

export type McpPluginSegment =
  | { kind: "text"; text: string }
  | { kind: "plugin"; text: string; name: string; match: McpPluginMatchKind };

/**
 * Un mot : lettres, chiffres, `_` et `-`. Le trait d'union est DANS le mot,
 * parce que les noms de serveurs en portent (`notion-calendar`).
 */
const WORD_RE = /[\p{L}\p{N}_-]+/gu;

/**
 * Découpe un texte en segments texte / plugin.
 *
 * Le texte rendu est celui d'origine, caractère pour caractère : le composer
 * superpose ces segments au champ de saisie, et le moindre écart décalerait la
 * surbrillance. Un mot précédé de `@` est laissé au texte: c'est une mention
 * de bot, elle a déjà son rendu. Segments texte adjacents fusionnés.
 */
export function segmentMcpPlugins(
  text: string,
  names: readonly string[],
): McpPluginSegment[] {
  if (text === "" || names.length === 0) return text === "" ? [] : [{ kind: "text", text }];

  const segments: McpPluginSegment[] = [];
  let textStart = 0;

  const pushText = (chunk: string) => {
    if (chunk === "") return;
    const last = segments[segments.length - 1];
    if (last?.kind === "text") last.text += chunk;
    else segments.push({ kind: "text", text: chunk });
  };

  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(text)) !== null) {
    const start = match.index;
    if (text[start - 1] === "@") continue;
    const found = matchMcpPlugin(match[0], names);
    if (!found) continue;
    pushText(text.slice(textStart, start));
    segments.push({ kind: "plugin", text: match[0], name: found.name, match: found.kind });
    textStart = start + match[0].length;
  }

  pushText(text.slice(textStart));
  return segments;
}

/**
 * Les serveurs MCP qu'un run peut réellement atteindre, par leur nom.
 *
 * Trois conditions, chacune pour un échec constaté : porté par la plateforme
 * que les runs openedbot utilisent, joignable à la dernière lecture de l'hôte, et :
 * pour un serveur `auth: oauth`: autorisé. Un serveur OAuth sans jeton est
 * inerte : le gateway ne listera jamais ses outils, le colorer promettrait
 * une capacité qui n'existe pas. `oauthTokenPresent` à `null` (hôte plus
 * ancien, qui ne le dit pas) ne se lit pas comme un refus.
 */
export function connectedMcpPluginNames(
  servers: ReadonlyArray<{
    name: string;
    auth: "none" | "header" | "oauth";
    platformEnabled: boolean;
    unreachable: boolean;
    oauthTokenPresent: boolean | null;
  }>,
): string[] {
  return servers
    .filter((server) =>
      server.platformEnabled &&
      !server.unreachable &&
      (server.auth !== "oauth" || server.oauthTokenPresent !== false))
    .map((server) => server.name);
}
