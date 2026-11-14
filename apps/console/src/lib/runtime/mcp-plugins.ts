/**
 * Recognition of a connected MCP server in text being typed.
 *
 * The composer colors the word when it names an MCP plugin the host actually
 * serves: « Regarde dans notion… » then reads as a possible call,
 * not as an ordinary sentence. It is a VISUAL AID, never a contract:
 * nothing here decides that a tool will be called, and the runtime remains the only judge.
 *
 * No DOM: the composer supplies the text, this module returns segments.
 * Normalization is that of mentions (`normalizeForMatch`), so that an
 * accent or a capital never changes recognition.
 */
import { normalizeForMatch } from "@openedbot/roster/domain/bot-identity";

/** A word names a plugin exactly, or approximately (prefix, typo). */
export type McpPluginMatchKind = "exact" | "approximate";

export type McpPluginMatch = { name: string; kind: McpPluginMatchKind };

/** Below this, « on » or « no » would color half of a sentence. */
const MIN_APPROXIMATE_LENGTH = 3;
/** A typo is tolerated only on a word that is already long. */
const MIN_TYPO_LENGTH = 4;

/**
 * The aliases recognized for a server name.
 *
 * Hosts name their servers in three ways for the same thing:
 * `notion`, `mcp-notion`, `notion-mcp`. The operator types « notion ».
 * The name stripped of its `mcp` affix is therefore ALSO compared.
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
 * Bounded edit distance, with transposition (Damerau–Levenshtein OSA).
 *
 * A transposition counts as ONE operation, not two: « notino » for
 * « notion » is the most common keyboard typo, and plain Levenshtein
 * ranked it at distance 2, therefore out of tolerance. Past `max`, the
 * function returns `max + 1` without finishing the calculation.
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
 * The plugin this word names, or `null`.
 *
 * Three degrees, in this order: the word IS the name (`exact`); the word is a
 * prefix of the name or the name a prefix of the word: « noti », « notions »
 * (`approximate`); the word is one typo away from the name: « notino »
 * (`approximate`). On a tie, the shortest name wins, then input
 * order: two servers `notion` and `notion-calendar` are not otherwise
 * told apart.
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
    // ALL aliases are judged, not only the first that matches:
    // `notion_mcp` already matches as a prefix on « notion », whereas its
    // alias stripped of the affix matches as EXACT: that is the one that must
    // rank the server.
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

/**
 * The plugins a list should offer for what follows an `@`.
 *
 * A plain prefix filter, with NO typo tolerance (unlike `matchMcpPlugin`):
 * the name or its affix-stripped alias must start with the query. Empty
 * query: every plugin. Exact names first, then prefixes, then input order.
 */
export function matchMcpPluginsByPrefix(
  query: string,
  names: readonly string[],
): string[] {
  const q = normalizeForMatch(query);
  const ranked: { name: string; exact: boolean; index: number }[] = [];
  names.forEach((name, index) => {
    const aliases = aliasesOf(name);
    if (q === "") {
      if (aliases.length) ranked.push({ name, exact: false, index });
      return;
    }
    if (!aliases.some((alias) => alias.startsWith(q))) return;
    ranked.push({ name, exact: aliases.includes(q), index });
  });
  ranked.sort((a, b) => Number(b.exact) - Number(a.exact) || a.index - b.index);
  return ranked.map((entry) => entry.name);
}

export type McpPluginSegment =
  | { kind: "text"; text: string }
  | { kind: "plugin"; text: string; name: string; match: McpPluginMatchKind };

/**
 * A word: letters, digits, `_` and `-`. The hyphen is INSIDE the word,
 * because server names carry one (`notion-calendar`).
 */
const WORD_RE = /[\p{L}\p{N}_-]+/gu;

/**
 * Splits a text into text / plugin segments.
 *
 * The rendered text is the original, character for character: the composer
 * overlays these segments on the input field, and the slightest gap would shift the
 * highlight. A word preceded by `@` is left as text: it is a bot
 * mention, it already has its own rendering. Adjacent text segments are merged.
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
 * The MCP servers a run can actually reach, by name.
 *
 * Three conditions, each for an observed failure: carried by the platform
 * that openedbot runs use, reachable at the host's last read, and:
 * for an `auth: oauth` server: authorized. An OAuth server without a token is
 * inert: the gateway will never list its tools, coloring it would promise
 * a capability that does not exist. `oauthTokenPresent` at `null` (an older
 * host, which does not say) is not read as a refusal.
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

/**
 * The MCP servers a bot's runs can reach, read from ITS profile: the token a
 * run uses lives in the profile's home, so a root server is not the bot's,
 * and a catalog connector connected to the bot is.
 *
 * Not the root rule word for word: a profile server is kept when enabled and,
 * for OAuth, when its token is not known absent. The profile reading carries
 * no `platformEnabled` (the operator's per-bot switch writes the profile's
 * `enabled` and its `api_server` entry together) nor `unreachable` (a probe
 * of the ROOT gateway with the root's token, which says nothing of the
 * profile's): neither is invented here.
 *
 * `null` when the profile reading does not say: not read, profile absent,
 * or a host that does not describe its entries (no `mcpFacts`); the caller
 * then keeps the runtime-wide reading, as before. With the marker, an empty
 * list is « no connector ».
 */
export function profileMcpPluginNames(
  profile: {
    mcpFacts?: true;
    mcpServers: ReadonlyArray<{
      name: string;
      enabled: boolean;
      auth?: "none" | "header" | "oauth";
      oauthTokenPresent?: boolean | null;
    }>;
  } | null | undefined,
): string[] | null {
  if (!profile || profile.mcpFacts !== true) return null;
  return profile.mcpServers
    .filter((server) => server.enabled && (server.auth !== "oauth" || server.oauthTokenPresent !== false))
    .map((server) => server.name);
}
