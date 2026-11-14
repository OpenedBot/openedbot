import { asRecord } from "@openedbot/contracts-primitives";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import {
  isWebSearchTool,
  readWebSearchResult,
  type WebSearchQuery,
  type WebSearchTrail,
} from "@openedbot/execution/domain/agent-web-search";

/**
 * Gives each `web_search` call of a run the query it ran and its sources, so
 * the call's Tool Result tells the whole search (lab, 2026-10-25: the query
 * sat on a row of its own above a card that no longer said what it searched).
 *
 * The trail (`agent-web-search.ts`, read from the transcript) and the live
 * calls do not share an id: the stream numbers calls `tc_0`, the transcript
 * keeps the provider's `toolu_…`. A call pairs with the first unused query
 * whose text matches its `preview`; a call without a preview takes the next
 * query in order. A call left unpaired builds its query from what it carries
 * (preview, attached input) and reads its sources from its own result.
 *
 * `searches[k][i]` belongs to `runs[k][i]`; `unpaired` are the trail queries
 * no call claimed, still worth a row of their own.
 */
export function pairWebSearchCalls(
  runs: readonly (readonly ToolCall[])[],
  trail: WebSearchTrail | null,
): { searches: (WebSearchQuery | null)[][]; unpaired: WebSearchQuery[] } {
  const queries = trail?.queries ?? [];
  const used = new Set<number>();
  let ordinal = 0;
  const searches = runs.map((calls) => calls.map((call) => {
    if (!isWebSearchTool(call.tool)) return null;
    ordinal++;
    const preview = call.preview?.trim() ?? "";
    const index = queries.findIndex((query, at) => !used.has(at) && (preview === "" || sameQuery(query.query, preview)));
    if (index !== -1) used.add(index);
    const paired = index === -1 ? null : queries[index]!;
    const text = paired?.query ?? (preview || attachedQuery(call));
    if (!text) return null;
    const base: WebSearchQuery = paired ?? { id: `call-${ordinal}`, query: text, sources: [], resultCount: null, error: null };
    if (base.sources.length > 0 || base.error) return base;
    // Searches stored before the envelope fix carry an empty trail: the
    // call's own result still holds its sources.
    const own = readOwnResult(call);
    return own ? { ...base, sources: own.sources, resultCount: own.sources.length || base.resultCount, error: own.error } : base;
  }));
  return { searches, unpaired: queries.filter((_, at) => !used.has(at)) };
}

/** The runtime's preview may be cut (`…`, `...`): a prefix still names the same query. */
function sameQuery(query: string, preview: string): boolean {
  const normalize = (text: string) => text.replace(/(\.\.\.|…)\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const a = normalize(query);
  const b = normalize(preview);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function attachedQuery(call: ToolCall): string {
  const input = call.attachment && !("ambiguous" in call.attachment) ? call.attachment.input : undefined;
  if (!input) return "";
  try {
    const query = asRecord(JSON.parse(input))?.query;
    return typeof query === "string" ? query.trim() : "";
  } catch {
    return "";
  }
}

function readOwnResult(call: ToolCall): ReturnType<typeof readWebSearchResult> | null {
  const attached = call.attachment && !("ambiguous" in call.attachment) ? call.attachment.result : undefined;
  for (const content of [attached, call.resultExcerpt]) {
    if (!content) continue;
    const read = readWebSearchResult(content);
    if (read.sources.length > 0 || read.error) return read;
  }
  return null;
}
