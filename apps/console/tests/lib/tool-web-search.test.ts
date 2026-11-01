import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import type { WebSearchQuery } from "@openedbot/execution/domain/agent-web-search";
import { pairWebSearchCalls } from "../../src/lib/tool-web-search";

const query = (id: string, text: string, sources: WebSearchQuery["sources"] = []): WebSearchQuery => ({
  id, query: text, sources, resultCount: sources.length || null, error: null,
});
const source = (url: string) => ({ title: url, url, domain: new URL(url).hostname, description: null });
const search = (preview?: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  tool: "web_search", done: true, ...(preview ? { preview } : {}), ...extra,
});

describe("pairWebSearchCalls", () => {
  test("each search call takes the query matching its preview, whatever the trail order", () => {
    const trail = { queries: [query("toolu_b", "météo Paris"), query("toolu_a", "météo Lille demain")] };
    const { searches, unpaired } = pairWebSearchCalls([[search("météo Lille demain"), { tool: "read_file", done: true }, search("météo Paris")]], trail);
    expect(searches[0]!.map((entry) => entry?.id ?? null)).toEqual(["toolu_a", null, "toolu_b"]);
    expect(unpaired).toEqual([]);
  });

  test("a preview cut by the runtime still names its query", () => {
    const { searches } = pairWebSearchCalls([[search("météo Lille demain dim...")]], { queries: [query("q", "météo Lille demain dimanche 25 octobre")] });
    expect(searches[0]![0]?.id).toBe("q");
  });

  test("calls without a preview pair in order, across the run's tool entries", () => {
    const trail = { queries: [query("1", "un"), query("2", "deux"), query("3", "trois")] };
    const { searches, unpaired } = pairWebSearchCalls([[search()], [search()]], trail);
    expect(searches.map((entry) => entry[0]?.id)).toEqual(["1", "2"]);
    expect(unpaired.map((entry) => entry.id)).toEqual(["3"]);
  });

  test("a call the trail does not know builds its query from its preview and its own result", () => {
    const result = `<untrusted_tool_result source="web_search">\nWarning.\n\n${JSON.stringify({ success: true, data: { web: [{ title: "Météo", url: "https://meteo.example.com/lille" }] } })}\n</untrusted_tool_result>`;
    const { searches } = pairWebSearchCalls([[search("météo Lille", { attachment: { result } })]], null);
    expect(searches[0]![0]).toMatchObject({ query: "météo Lille", sources: [{ domain: "meteo.example.com" }] });
  });

  test("a stored trail emptied by the old reader gets its sources back from the attached result", () => {
    const result = JSON.stringify({ success: true, data: { web: [{ title: "A", url: "https://a.example.com/" }] } });
    const { searches } = pairWebSearchCalls(
      [[search(undefined, { attachment: { input: "{\"query\": \"acme\"}", result } })]],
      { queries: [query("q", "acme")] },
    );
    expect(searches[0]![0]).toMatchObject({ id: "q", sources: [{ url: "https://a.example.com/" }], resultCount: 1 });
  });

  test("the query comes from the attached input when the call has no preview and no trail", () => {
    const { searches } = pairWebSearchCalls([[search(undefined, { attachment: { input: "{\"query\": \"acme pricing\"}" } })]], null);
    expect(searches[0]![0]?.query).toBe("acme pricing");
  });

  test("a trail query that matches no preview stays unpaired, and the call keeps its own", () => {
    const trail = { queries: [query("q", "autre chose", [source("https://x.example.com/")])] };
    const { searches, unpaired } = pairWebSearchCalls([[search("météo Lille")]], trail);
    expect(searches[0]![0]).toMatchObject({ query: "météo Lille", sources: [] });
    expect(unpaired.map((entry) => entry.id)).toEqual(["q"]);
  });
});
