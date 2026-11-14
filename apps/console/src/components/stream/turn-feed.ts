import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import { isWebSearchTool, type WebSearchQuery } from "@openedbot/execution/domain/agent-web-search";
import { toolKind, type ToolCall } from "@openedbot/conversation/domain/thread-tools";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import type { Entry } from "../../lib/thread/thread-timeline-model";
import { searchQuery, toolProgressLabel } from "../../lib/run/tool-progress-label";
import type { useT } from "../../lib/i18n";
import { streamSite, type StreamFeedItem, type StreamSpeaker } from "./stream-feed";

type Translate = ReturnType<typeof useT>["t"];

/** The turn's bot as the feed's speaker, or `null` for a turn without one. */
export function streamSpeaker(author: MessageAuthorBot | null | undefined): StreamSpeaker | null {
  if (!author) return null;
  return { id: author.id, name: author.name ?? author.slug ?? "", face: author.face };
}

/** How many site marks a search row stacks (the reference app shows three). */
const SITES_PER_SEARCH = 3;

function searchItem(id: string, query: WebSearchQuery, pending: boolean): StreamFeedItem {
  const domains = [...new Set(query.sources.map((source) => source.domain).filter(Boolean))];
  return {
    id,
    kind: "search",
    query: query.query,
    results: query.resultCount ?? query.sources.length,
    sites: domains.slice(0, SITES_PER_SEARCH).map(streamSite),
    sources: query.sources.map((source) => ({ title: source.title, url: source.url, domain: source.domain })),
    pending,
  };
}

/**
 * The page a web tool opened, as the reference app's « Consulté » row prints it: host
 * and path, never the query string or the fragment, where a token may sit.
 */
export function visitedPage(preview: string | undefined): string | null {
  const match = preview?.match(/https?:\/\/[^\s"'<>)\]]+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host.replace(/^www\./, "")}${path}`;
  } catch {
    return null;
  }
}

/** A JSON string field read from a (possibly cut) JSON text. */
function jsonField(raw: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(raw);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]!.replace(/\\$/, "")}"`) as string;
  } catch {
    return null;
  }
}

/**
 * A tool's error or output as a person reads it: runtimes hand back a JSON
 * envelope (`{"output": "Traceback…", "exit_code": 1, …}`), often cut by the
 * excerpt bound; its `output` and `error` text is the readable part. Anything
 * else stays as it came.
 */
export function readableDetail(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (!text.startsWith("{")) return text;
  const parts = [jsonField(text, "output"), jsonField(text, "error")].filter((part): part is string => Boolean(part?.trim()));
  return parts.length ? parts.join("\n").trim() : text;
}

/**
 * Why a call failed, as the panel unfolds it. A terminal call that exits
 * non-zero says only `exit 1` in its live result; its output (the
 * traceback, `command not found`…) arrives with the run's end, in the
 * attachment. Measured 2026-11-11: « Exécute des commandes · Échec »
 * could not unfold, the `ModuleNotFoundError` stayed hidden.
 */
function failureDetail(call: ToolCall): string | undefined {
  const attachment = call.attachment && !("ambiguous" in call.attachment) ? call.attachment : null;
  const bare = (text: string | undefined) => !text || /^exit(?: code)? -?\d+$/iu.test(text.trim());
  if (attachment?.result && bare(call.errorMessage)) return attachment.result;
  return call.errorMessage || attachment?.errorMessage || call.resultExcerpt || attachment?.result;
}

/** A finished step reads as done: the progress verb's trailing « … » goes. */
const settledLabel = (label: string, done: boolean) => (done ? label.replace(/\s*(?:…|\.\.\.)$/u, "") : label);

/** A sentence the bot wrote between two tools, as a plain status line. */
export function statusText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A turn's steps as the reference app's rolling feed: each web search a « Recherche
 * sur le web » row (query, results, site marks), each page a web tool read a
 * « Consulté » row, every other tool a one line row named by its progress
 * label (masked by `toolProgressLabel`, never the raw arguments; its error or
 * output excerpt only as `detail`, for the panel), and each sentence the bot
 * wrote between them grok's agent message, under the bot's face (`speaker`;
 * a status line without one). Ids are stable entry keys: the feed keys its
 * rows by id to slide them.
 */
export function turnFeed(members: readonly Entry[], t: Translate, speaker: StreamSpeaker | null = null): StreamFeedItem[] {
  const items: StreamFeedItem[] = [];
  // A query a tool call carries is drawn on that call's row: the turn's
  // search trail (placed before the tool log) must not draw it twice.
  const seenQueries = new Set<string>();
  for (const member of members) {
    if (member.kind !== "tools") continue;
    for (const query of member.searches ?? []) if (query) seenQueries.add(query.id);
  }
  for (const member of members) {
    if (member.kind === "assistant") {
      const text = statusText(member.text);
      if (text) items.push(speaker ? { id: member.key, kind: "msg", agent: speaker, text } : { id: member.key, kind: "status", text });
      continue;
    }
    if (member.kind === "search") {
      for (const query of member.trail.queries) {
        if (seenQueries.has(query.id)) continue;
        seenQueries.add(query.id);
        items.push(searchItem(`${member.key}:${query.id}`, query, false));
      }
      continue;
    }
    if (member.kind !== "tools") continue;
    member.calls.forEach((call, index) => {
      if (isTodoTool(call.tool)) return;
      const id = `${member.key}:${index}`;
      const query = member.searches?.[index] ?? null;
      if (query) {
        items.push(searchItem(id, query, !call.done));
        return;
      }
      if (isWebSearchTool(call.tool) && !call.failed) {
        // The masked terms (`searchQuery`), never the raw preview.
        const terms = call.preview ? searchQuery(call.preview) : null;
        items.push({ id, kind: "search", query: terms ?? toolProgressLabel(t, call.tool, call.preview), results: 0, sites: [], pending: !call.done });
        return;
      }
      const page = toolKind(call.tool) === "web" ? visitedPage(call.preview) : null;
      if (page && !call.failed) {
        items.push({ id, kind: "visit", url: page });
        return;
      }
      const detail = readableDetail(call.failed ? failureDetail(call) : call.resultExcerpt);
      items.push({ id, kind: "tool", label: settledLabel(toolProgressLabel(t, call.tool, call.preview), call.done), pending: !call.done, failed: call.failed === true, detail });
    });
  }
  return items;
}
