import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import type { WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { I18nProvider } from "../../src/lib/i18n";
import { ActivityNarration, ActivityRow, ActivitySearch, TurnActivity } from "../../src/components/thread-turn-activity";
import { toolKindIcon } from "../../src/components/thread-tool-state-icon";
import { ToolActivity } from "../../src/components/thread-tool-activity";
import type { GrokFeedItem } from "../../src/components/grok/grok-feed";
import { AttachmentCanvas, AttachmentCanvasProvider } from "../../src/components/attachment-canvas";

/** A ResizeObserver stand-in: the components observe, nothing here measures. */
const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
const OriginalResizeObserver = globalThis.ResizeObserver;
class DrivenResizeObserver {
  private entry: { callback: ResizeObserverCallback; targets: Element[] };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: [] };
    observers.push(this.entry);
  }
  observe(target: Element) { this.entry.targets.push(target); }
  unobserve() {}
  disconnect() {
    const index = observers.indexOf(this.entry);
    if (index >= 0) observers.splice(index, 1);
  }
}

const calls: ToolCall[] = [
  { tool: "web_search", done: true, preview: "acme pricing" },
  { tool: "read_file", done: true, preview: "src/app.ts" },
  { tool: "terminal", done: true, preview: "bun test", durationMs: 1200 },
  { tool: "terminal", done: true, preview: "bun run build", durationMs: 800 },
];

function view({ live, forceOpen = false, feed = calls, rows = [] }: { live: boolean; forceOpen?: boolean; feed?: ToolCall[]; rows?: GrokFeedItem[] }) {
  return (
    <I18nProvider>
      <TurnActivity calls={feed} feed={rows} live={live} forceOpen={forceOpen} author={null} showAuthorLabel={false}>
        <ActivityRow kind="thinking">
          <ActivityNarration text="Je regarde le dépôt." streaming={false} />
        </ActivityRow>
        <ToolActivity entryKey="erun-1:4" calls={feed} approvals={[]} findTargetId="run-1:tools" />
      </TurnActivity>
    </I18nProvider>
  );
}

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
  globalThis.ResizeObserver = DrivenResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  observers.length = 0;
  globalThis.ResizeObserver = OriginalResizeObserver;
});

describe("ToolActivity identity", () => {
  test("a live event becoming persisted (new cursor, same entry) keeps the operator's open Tool Result", () => {
    const tools = (targetId: string) => (
      <I18nProvider>
        <ToolActivity entryKey="erun-1:4" calls={calls} approvals={[]} findTargetId={targetId} />
      </I18nProvider>
    );
    const { container, rerender } = render(tools("event:run-1:live-4"));
    const head = () => container.querySelectorAll<HTMLButtonElement>("[data-tool-result] > button[aria-expanded]")[0]!;
    expect(head().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(head());
    expect(head().getAttribute("aria-expanded")).toBe("true");

    rerender(tools("event:run-1:1042"));
    expect(head().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("TurnActivity (grok.com's agents header and rolling feed)", () => {
  const rows: GrokFeedItem[] = [
    { id: "s1", kind: "status", text: "Je regarde le dépôt." },
    { id: "q1", kind: "search", query: "acme pricing", results: 4, sites: [] },
    { id: "t1", kind: "tool", label: "Lecture : app.ts" },
    { id: "t2", kind: "tool", label: "Commande : bun test", pending: true },
  ];
  const fold = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-turn-activity] > [data-open]")!;

  test("a live turn rolls its last three steps under grok's solo « Réflexion • Ns »; the full log waits, folded", () => {
    const { container } = render(view({ live: true, rows }));
    const block = container.querySelector<HTMLElement>("[data-turn-activity]")!;
    expect(block.hasAttribute("data-live")).toBe(true);
    expect(block.getAttribute("aria-busy")).toBe("true");
    const head = block.querySelector<HTMLButtonElement>("[data-activity-head]")!;
    // Running, the header opens nothing: grok's is a plain status line.
    expect(head.hasAttribute("aria-expanded")).toBe(false);
    expect(head.querySelector("[data-activity-summary]")?.textContent).toBe("Réflexion");
    expect(head.querySelector("[data-thinking-elapsed]")?.textContent).toMatch(/^\d+s$/);
    const feed = [...block.querySelectorAll("[data-agent-feed-item] [data-feed-row]")].map((row) => row.getAttribute("data-feed-row"));
    expect(feed).toEqual(["search", "tool", "tool"]);
    expect(fold(container).getAttribute("data-open")).toBe("false");
    // The log keeps every row, in order, never capped.
    const list = block.querySelector<HTMLElement>("[data-activity-list]")!;
    expect(list.getAttribute("role")).toBe("list");
    expect([...list.querySelectorAll("[data-activity-row]")].map((row) => row.getAttribute("data-activity-row")))
      .toEqual(["thinking", "tool", "tool", "tool"]);
    // The two consecutive commands share one Tool Result: `terminal ×2`.
    expect(list.querySelectorAll("[data-tool-result]")).toHaveLength(3);
    expect(list.textContent).toContain("×2");
  });

  test("the turn concluding empties the feed and folds into « Réflexion : Ns », which opens the log", () => {
    const { container, rerender } = render(view({ live: true, rows }));
    rerender(view({ live: false, rows }));
    const block = container.querySelector<HTMLElement>("[data-turn-activity]")!;
    expect(block.hasAttribute("data-live")).toBe(false);
    const head = block.querySelector<HTMLButtonElement>("[data-activity-head]")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.getAttribute("aria-controls")).toBe(fold(container).id);
    // No run duration given: the tools' own durations (1.2 s + 0.8 s).
    expect(head.querySelector("[data-activity-summary]")?.textContent).toBe("Réflexion : 2s");
    expect(fold(container).getAttribute("data-open")).toBe("false");
    expect(fold(container).firstElementChild?.hasAttribute("inert")).toBe(true);

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(fold(container).getAttribute("data-open")).toBe("true");
  });

  test("the run's own duration wins over the sum of its tools", () => {
    const { container } = render(
      <I18nProvider>
        <TurnActivity calls={calls} live={false} workedMs={6000} forceOpen={false} author={null} showAuthorLabel={false}>
          <ToolActivity entryKey="erun-1:4" calls={calls} approvals={[]} findTargetId="run-1:tools" />
        </TurnActivity>
      </I18nProvider>,
    );
    expect(container.querySelector("[data-activity-summary]")?.textContent).toBe("Réflexion : 6s");
  });

  test("a pending decision opens the log and stops the feed, whatever the run does", () => {
    const { container } = render(view({ live: true, forceOpen: true, rows }));
    expect(fold(container).getAttribute("data-open")).toBe("true");
    expect(container.querySelectorAll("[data-agent-feed-item]")).toHaveLength(0);
  });

  test("a turn that ended on a failed tool stays open on it; the operator's click still folds it", () => {
    const failing: ToolCall[] = [
      { tool: "read_file", done: true, preview: "src/app.ts" },
      { tool: "terminal", done: true, failed: true, preview: "bun test", errorMessage: "exit status 1" },
    ];
    const { container, rerender } = render(view({ live: true, feed: failing }));
    rerender(view({ live: false, feed: failing }));
    const head = container.querySelector<HTMLButtonElement>("[data-activity-head]")!;
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(fold(container).getAttribute("data-open")).toBe("true");
    expect(fold(container).firstElementChild?.hasAttribute("inert")).toBe(false);
    const failed = fold(container).querySelector<HTMLElement>('[data-tool-result][data-state="failed"]')!;
    expect(failed.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    expect(failed.querySelector("[data-tool-error-inline]")?.textContent).toBe("exit status 1");

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(fold(container).getAttribute("data-open")).toBe("false");
  });

  test("a turn read back from history with a failed tool mounts open", () => {
    const { container } = render(view({ live: false, feed: [{ tool: "terminal", done: true, failed: true, preview: "foo", errorMessage: "command not found: foo" }] }));
    expect(container.querySelector("[data-activity-head]")?.getAttribute("aria-expanded")).toBe("true");
  });

  test("a turn without any duration says « Réflexions », never a made-up time; partial failures read in the header", () => {
    const { container } = render(view({
      live: false,
      feed: [
        { tool: "skill_manage", done: true, failed: true, errorMessage: "skill exists" },
        { tool: "skill_manage", done: true },
      ],
    }));
    const head = container.querySelector<HTMLElement>("[data-activity-head]")!;
    expect(head.querySelector("[data-activity-summary]")?.textContent).toBe("Réflexions");
    expect(head.textContent).toContain("1 échec sur 2");
  });
});

describe("ActivitySearch", () => {
  const sources = Array.from({ length: 5 }, (_, index) => ({
    title: `Result ${index}`,
    url: index === 4 ? "javascript:alert(1)" : `https://example.com/${index}`,
    domain: "example.com",
    description: null,
  }));
  const trail: WebSearchTrail = { queries: [{ id: "q1", query: "acme pricing", sources, resultCount: null, error: null }] };

  test("+N autres lists every other source, with safe links only, and folds back", () => {
    const { container } = render(<I18nProvider><ActivitySearch trail={trail} /></I18nProvider>);
    const titles = () => [...container.querySelectorAll("[data-activity-row='search'] .font-medium")].map((node) => node.textContent);
    expect(titles()).toEqual(["Result 0", "Result 1", "Result 2"]);
    const toggle = container.querySelector<HTMLButtonElement>("button[data-search-sources-toggle]")!;
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("+2 autres");
    expect(container.querySelector(`#${CSS.escape(toggle.getAttribute("aria-controls")!)}`)).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Voir moins");
    expect(titles()).toEqual(["Result 0", "Result 1", "Result 2", "Result 3", "Result 4"]);
    const links = [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["https://example.com/0", "https://example.com/1", "https://example.com/2", "https://example.com/3"]);

    fireEvent.click(toggle);
    expect(titles()).toHaveLength(3);
  });

  test("no toggle when every source already shows; 44 pt on the phone shell", () => {
    const short: WebSearchTrail = { queries: [{ ...trail.queries[0]!, sources: sources.slice(0, 3) }] };
    const { container } = render(<I18nProvider><ActivitySearch trail={short} /></I18nProvider>);
    expect(container.querySelector("[data-search-sources-toggle]")).toBeNull();
    const css = readFileSync(new URL("../../src/styles/components/agent-activity.css", import.meta.url), "utf8");
    expect(css).toMatch(/\[data-mobile-shell\] \[data-search-sources-toggle\] \{\s*min-height: 2\.75rem;/);
  });
});

describe("toolKindIcon", () => {
  test("a tool named after an Object.prototype member gets its family glyph", () => {
    const mcp = toolKindIcon("mcp__x__unknown_tool");
    expect(toolKindIcon("mcp__x__constructor")).toBe(mcp);
    expect(toolKindIcon("mcp__x__valueOf")).toBe(mcp);
    expect(toolKindIcon("toString")).toBe(toolKindIcon("some_unknown_tool"));
    expect(toolKindIcon("constructor")).not.toBe(Object as unknown);
  });
});

describe("prefers-reduced-motion", () => {
  const css = readFileSync(new URL("../../src/styles/components/agent-activity.css", import.meta.url), "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

  test("every motion of the fold, the rows and the live shimmer stops", () => {
    expect(reduced).toContain(".ohb-disclosure");
    expect(reduced).toMatch(/\.ohb-thinking-shimmer \{\s*animation: none;/);
    expect(reduced).toMatch(/\[data-turn-activity\]\[data-live\] \[data-activity-row\] \{\s*animation: none;/);
    expect(reduced).toMatch(/\.ohb-activity-chevron \{\s*transition: none;/);
  });

  test("the rolling labels swap instantly", () => {
    const appCss = readFileSync(new URL("../../../../browser/ui-kit/src/styles/app.css", import.meta.url), "utf8");
    const roll = appCss.slice(appCss.indexOf(".ohb-roll {"));
    expect(roll).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ohb-roll-in \{\s*animation: none;\s*\}\s*\.ohb-roll-out \{\s*display: none;/);
  });
});

describe("grok's « Réflexions » panel in the canvas", () => {
  const author = { id: "bot-1", name: "Atlas", slug: "atlas", face: null };
  const speaker = { id: "bot-1", name: "Atlas", face: null };
  const log: GrokFeedItem[] = [
    { id: "m1", kind: "msg", agent: speaker, text: "Je lance le calcul." },
    { id: "s1", kind: "search", query: "nombres premiers", results: 2, sites: [], sources: [{ title: "Premiers", url: "https://example.org/p", domain: "example.org" }] },
    { id: "t1", kind: "tool", label: "Exécute une commande", failed: true, detail: "Traceback (most recent call last)" },
  ];
  function canvasView() {
    return render(
      <I18nProvider>
        <AttachmentCanvasProvider>
          <TurnActivity calls={[{ tool: "terminal", done: true, failed: true }]} feed={log} live={false} forceOpen={false} author={author} showAuthorLabel={false} workedMs={20_000}>
            <ActivityRow kind="thinking"><span>detail row</span></ActivityRow>
          </TurnActivity>
          <AttachmentCanvas />
        </AttachmentCanvasProvider>
      </I18nProvider>,
    );
  }

  test("the header stays one line and counts the failure; a click opens the panel, not the inline fold", () => {
    const { container } = canvasView();
    const head = container.querySelector<HTMLElement>("[data-activity-head]")!;
    expect(head.className).toContain("whitespace-nowrap");
    expect(head.textContent).toContain("Réflexion : 20s");
    expect(head.textContent).toContain("1 échec sur 1");
    expect(head.textContent).not.toContain("Traceback");
    fireEvent.click(head);
    const panel = container.querySelector<HTMLElement>("[data-thoughts-panel]");
    expect(panel).not.toBeNull();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    // The thread's own fold stays shut: the log reads in the canvas.
    expect(container.querySelector("[data-turn-activity] [data-open]")?.getAttribute("data-open")).toBe("false");
    expect(panel!.querySelector("[data-thoughts-group]")?.textContent).toContain("Atlas");
    expect(panel!.querySelector('[data-thoughts-row="msg"]')?.textContent).toBe("Je lance le calcul.");
  });

  test("a failed tool unfolds its error; a search its real sources; close folds the panel", () => {
    const { container } = canvasView();
    fireEvent.click(container.querySelector<HTMLElement>("[data-activity-head]")!);
    const panel = container.querySelector<HTMLElement>("[data-thoughts-panel]")!;
    const tool = panel.querySelector<HTMLElement>('[data-thoughts-row="tool"]')!;
    expect(tool.hasAttribute("data-failed")).toBe(true);
    expect(tool.textContent).not.toContain("Traceback");
    fireEvent.click(tool.querySelector("button")!);
    expect(tool.querySelector("pre")?.textContent).toContain("Traceback");
    const search = panel.querySelector<HTMLElement>('[data-thoughts-row="search"]')!;
    fireEvent.click(search.querySelector("button")!);
    expect(search.querySelector("a")?.getAttribute("href")).toBe("https://example.org/p");
    fireEvent.click(panel.querySelector<HTMLElement>('button[aria-label="Fermer"]')!);
    expect(container.querySelector("[data-activity-head]")?.getAttribute("aria-expanded")).toBe("false");
  });
});
