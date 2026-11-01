import { asRecord } from "@openedbot/contracts-primitives";
import { readAgentToolCall } from "./agent-tool-call";

/**
 * Projection des recherches web d'un run, à partir du transcript Hermes.
 *
 * Le flux SSE ne porte ni les arguments d'un outil ni son résultat : le
 * gateway jette le contenu avant d'émettre sa trame. Le transcript de session,
 * lui, garde les deux, l'appel côté assistant et sa réponse côté outil. On y
 * relit donc les recherches réellement jouées, sans rien changer à Hermes et
 * sans inventer une source.
 *
 * Format amont, mesuré sur `tools/web_tools.py` de NousResearch/hermes-agent :
 * `web_search` renvoie une chaîne JSON
 * `{"success": true, "data": {"web": [{title, url, description, position}]}}`
 * ou `{"success": false, "error": "..."}`. `web_extract` renvoie
 * `{"results": [...]}`. Le contenu peut arriver tronqué par l'amont : le
 * parseur garde alors les sources complètes qui précèdent la coupure, jamais
 * une erreur.
 *
 * Depuis `agent/tool_dispatch_helpers.py` (`_maybe_wrap_untrusted`), Hermes
 * enveloppe le résultat d'un outil à risque dans
 * `<untrusted_tool_result source="web_search">`, une phrase d'avertissement,
 * une ligne vide, puis le JSON. Sans retirer cette enveloppe, toute recherche
 * se lisait sans source (lab, 2026-10-25).
 */

/** Les outils dont on sait lire le résultat. */
const SEARCH_TOOLS = new Set(["web_search", "search"]);

/** Vrai pour un outil de recherche web dont on sait lire la requête et le résultat. */
export function isWebSearchTool(name: string): boolean {
  return SEARCH_TOOLS.has(name);
}

export type WebSearchSource = {
  title: string;
  url: string;
  /** Le domaine, dérivé de l'URL, pour la marque de site et le regroupement. */
  domain: string;
  description: string | null;
};

export type WebSearchQuery = {
  id: string;
  /** Ce qui a été cherché. */
  query: string;
  sources: WebSearchSource[];
  /** Le compte annoncé par le fournisseur, quand il diffère des sources lues. */
  resultCount: number | null;
  /** Le message d'échec du fournisseur, quand il en a donné un. */
  error: string | null;
};

export type WebSearchTrail = {
  queries: WebSearchQuery[];
};

/** Plafonds : un transcript hostile ne doit pas gonfler une charge utile. */
const MAX_QUERIES = 32;
const MAX_SOURCES_PER_QUERY = 24;
const MAX_TEXT = 300;

type JsonRecord = Record<string, unknown>;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readCallId(call: JsonRecord): string | null {
  if (typeof call.id === "string" && call.id.trim()) return call.id.trim();
  return typeof call.tool_call_id === "string" && call.tool_call_id.trim()
    ? call.tool_call_id.trim()
    : null;
}

function trimText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Le domaine affichable d'une URL : l'hôte sans son `www.`. Une URL que le
 * navigateur refuse de lire n'est pas une source, elle est écartée.
 */
function readDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function normalizeSource(value: unknown): WebSearchSource | null {
  const item = asRecord(value);
  if (!item) return null;
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (!url) return null;
  // Seuls `http` et `https` sont rendus en lien : le reste ne s'ouvre pas
  // depuis un fil et n'a rien à faire dans un `href`.
  if (!/^https?:\/\//i.test(url)) return null;
  const domain = readDomain(url);
  if (!domain) return null;
  return {
    title: trimText(item.title, 200) ?? domain,
    url,
    domain,
    description: trimText(item.description),
  };
}

const ENVELOPE_OPEN = /^\s*<untrusted_tool_result\b[^>]*>\n[^\n]*\n\n/i;
const ENVELOPE_CLOSE = /\n<\/untrusted_tool_result>\s*$/i;

/**
 * Le contenu sous l'enveloppe `<untrusted_tool_result>` de Hermes. L'amont
 * ré-enveloppe sans vérifier (pas de raccourci « déjà enveloppé ») : on
 * retire donc jusqu'à trois couches. Une balise fermante absente veut dire un
 * contenu coupé, qui reste lu tel quel.
 */
function unwrapUntrusted(text: string): string {
  let body = text;
  for (let layer = 0; layer < 3 && ENVELOPE_OPEN.test(body); layer++) {
    body = body.replace(ENVELOPE_OPEN, "").replace(ENVELOPE_CLOSE, "");
  }
  return body;
}

/**
 * Les objets COMPLETS du tableau `"web"` d'un JSON coupé en route : le
 * résultat joint en fin de run est borné (8 Ko), et sa dernière source est
 * souvent tranchée au milieu d'une description. Lecture caractère par
 * caractère, chaînes et échappements compris ; un objet que `JSON.parse`
 * refuse est sauté.
 */
function salvageWebEntries(text: string): unknown[] {
  const start = text.search(/"web"\s*:\s*\[/);
  if (start === -1) return [];
  const entries: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let index = text.indexOf("[", start) + 1; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") {
      if (depth === 0) objectStart = index;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        try {
          entries.push(JSON.parse(text.slice(objectStart, index + 1)));
        } catch {
          // Un objet illisible n'arrête pas la lecture des suivants.
        }
        objectStart = -1;
        if (entries.length >= MAX_SOURCES_PER_QUERY) break;
      }
    } else if (char === "]" && depth === 0) break;
  }
  return entries;
}

/**
 * Lit la réponse d'un `web_search`. Renvoie les sources et, séparément,
 * l'erreur du fournisseur : une recherche qui a échoué reste une recherche
 * jouée, et se lit comme telle dans le fil.
 */
export function readWebSearchResult(content: unknown): { sources: WebSearchSource[]; error: string | null } {
  const text = typeof content === "string" ? unwrapUntrusted(content) : null;
  const parsed = asRecord(text === null ? content : parseJson(text));
  if (parsed?.success === false) {
    return { sources: [], error: trimText(parsed.error) };
  }
  const listed = asRecord(parsed?.data)?.web;
  const web = Array.isArray(listed) ? listed : parsed || text === null ? [] : salvageWebEntries(text);
  const sources: WebSearchSource[] = [];
  for (const entry of web) {
    const source = normalizeSource(entry);
    if (source) sources.push(source);
    if (sources.length >= MAX_SOURCES_PER_QUERY) break;
  }
  return { sources, error: null };
}

/**
 * Rejoue les recherches web du transcript, dans l'ordre.
 *
 * Un appel sans réponse rattachée reste listé : c'est une recherche en cours,
 * et la taire ferait disparaître du fil un travail réellement engagé.
 */
export function projectWebSearches(messages: unknown): WebSearchTrail | null {
  if (!Array.isArray(messages)) return null;

  // Les réponses sont indexées d'abord : un transcript peut livrer la
  // réponse avant l'appel si l'amont réordonne, et l'appariement se fait
  // par identifiant, jamais par position.
  const results = new Map<string, unknown>();
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.role !== "tool") continue;
    const id = typeof record.tool_call_id === "string" ? record.tool_call_id.trim() : "";
    if (id) results.set(id, record.content);
  }

  const queries: WebSearchQuery[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.role !== "assistant") continue;
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    for (const raw of calls) {
      const call = asRecord(raw);
      if (!call) continue;
      const normalized = readAgentToolCall(call);
      if (!normalized || !SEARCH_TOOLS.has(normalized.name)) continue;

      const args = asRecord(parseJson(normalized.arguments));
      const query = trimText(args?.query, 200);
      if (!query) continue;

      const id = readCallId(call) ?? `search-${queries.length + 1}`;
      const { sources, error } = readWebSearchResult(results.get(id));
      const limit = typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.trunc(args.limit)
        : null;

      queries.push({
        id,
        query,
        sources,
        // Le compte n'a d'intérêt que s'il dit autre chose que la liste elle
        // même : sinon la pastille répète ce qui est déjà sous les yeux.
        resultCount: sources.length > 0 ? sources.length : limit,
        error,
      });
      if (queries.length >= MAX_QUERIES) break;
    }
    if (queries.length >= MAX_QUERIES) break;
  }

  return queries.length > 0 ? { queries } : null;
}

/** Garde de type côté client, jumelle de `isAgentPlan`. */
export function isWebSearchTrail(value: unknown): value is WebSearchTrail {
  const trail = asRecord(value);
  return Boolean(
    trail
    && Array.isArray(trail.queries)
    && trail.queries.every((entry) => {
      const item = asRecord(entry);
      return Boolean(
        item
        && typeof item.id === "string"
        && typeof item.query === "string"
        && Array.isArray(item.sources)
        && item.sources.every((source) => {
          const s = asRecord(source);
          return Boolean(
            s
            && typeof s.title === "string"
            && typeof s.url === "string"
            && typeof s.domain === "string",
          );
        }),
      );
    }),
  );
}
