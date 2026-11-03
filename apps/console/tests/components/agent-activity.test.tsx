import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import type { WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { I18nProvider } from "../../src/lib/i18n";
import { ActivityNarration, ActivityRow, ActivitySearch, TurnActivity } from "../../src/components/thread-turn-activity";
import { toolKindIcon } from "../../src/components/thread-tool-state-icon";
import { ToolActivity } from "../../src/components/thread-tool-activity";

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

function view({ live, forceOpen = false, feed = calls }: { live: boolean; forceOpen?: boolean; feed?: ToolCall[] }) {
  return (
    <I18nProvider>
      <TurnActivity calls={feed} live={live} forceOpen={forceOpen} author={null} showAuthorLabel={false}>
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

describe("TurnActivity (« A travaillé » fold)", () => {
  test("a live turn shows a working header and its whole chronological list, never capped", () => {
    const { container } = render(view({ live: true }));
    const block = container.querySelector<HTMLElement>("[data-turn-activity]")!;
    expect(block.hasAttribute("data-live")).toBe(true);
    expect(block.getAttribute("aria-busy")).toBe("true");
    const head = block.querySelector<HTMLButtonElement>("[data-activity-head]")!;
    expect(head.getAttribute("aria-expanded")).toBe("true");
    // The live header is the thinking status: dots, shimmering label, timer.
    expect(head.querySelector("[data-thinking-dots]")).not.toBeNull();
    expect(head.querySelector("[data-thinking-label]")?.textContent).toBe("Réfléchit…");
    expect(head.querySelector("[data-thinking-elapsed]")?.textContent).toMatch(/^\d+,\d s$/);
    expect(block.querySelector("[data-activity-window]")).toBeNull();
    expect(block.querySelector("[data-activity-show-all]")).toBeNull();
    const list = block.querySelector<HTMLElement>("[data-activity-list]")!;
    expect(list.getAttribute("role")).toBe("list");
    expect(list.style.transform).toBe("");
    expect([...list.querySelectorAll("[data-activity-row]")].map((row) => row.getAttribute("data-activity-row")))
      .toEqual(["thinking", "tool", "tool", "tool"]);
    // The two consecutive commands share one Tool Result: `terminal ×2`.
    expect(list.querySelectorAll("[data-tool-result]")).toHaveLength(3);
    expect(list.textContent).toContain("×2");
  });

  test("the turn concluding folds into « A travaillé », then the tool families", () => {
    const { container, rerender } = render(view({ live: true }));
    rerender(view({ live: false }));
    const block = container.querySelector<HTMLElement>("[data-turn-activity]")!;
    expect(block.hasAttribute("data-live")).toBe(false);
    const head = block.querySelector<HTMLButtonElement>("[data-activity-head]")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    // No run duration given: the tools' own durations (1.2 s + 0.8 s).
    expect(head.querySelector("[data-activity-summary]")?.textContent).toMatch(/^A travaillé 2\s?s$/);
    expect(head.querySelector("[data-activity-kinds]")?.textContent).toBe("· 1 recherche web, 1 lecture et 2 commandes");
    const fold = block.querySelector<HTMLElement>(".ohb-disclosure")!;
    expect(fold.getAttribute("data-open")).toBe("false");
    expect(fold.hasAttribute("inert")).toBe(true);

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(fold.getAttribute("data-open")).toBe("true");
  });

  test("the run's own duration wins over the sum of its tools", () => {
    const { container } = render(
      <I18nProvider>
        <TurnActivity calls={calls} live={false} workedMs={6000} forceOpen={false} author={null} showAuthorLabel={false}>
          <ToolActivity entryKey="erun-1:4" calls={calls} approvals={[]} findTargetId="run-1:tools" />
        </TurnActivity>
      </I18nProvider>,
    );
    expect(container.querySelector("[data-activity-summary]")?.textContent).toMatch(/^A travaillé 6\s?s$/);
  });

  test("a pending decision keeps the list open, whatever the run does", () => {
    const { container } = render(view({ live: true, forceOpen: true }));
    const head = container.querySelector<HTMLButtonElement>("[data-activity-head]")!;
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });

  test("the operator can fold a live turn, and reopen it", () => {
    const { container } = render(view({ live: true }));
    const head = container.querySelector<HTMLButtonElement>("[data-activity-head]")!;
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
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
    const fold = container.querySelector<HTMLElement>("[data-turn-activity] > .ohb-disclosure")!;
    expect(fold.getAttribute("data-open")).toBe("true");
    expect(fold.hasAttribute("inert")).toBe(false);
    const failed = fold.querySelector<HTMLElement>('[data-tool-result][data-state="failed"]')!;
    expect(failed.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    expect(failed.querySelector("[data-tool-error-inline]")?.textContent).toBe("exit status 1");

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(fold.getAttribute("data-open")).toBe("false");
  });

  test("a turn read back from history with a failed tool mounts open", () => {
    const { container } = render(view({ live: false, feed: [{ tool: "terminal", done: true, failed: true, preview: "foo", errorMessage: "command not found: foo" }] }));
    expect(container.querySelector("[data-activity-head]")?.getAttribute("aria-expanded")).toBe("true");
  });

  test("a turn of unknown tools without any duration only counts them; partial failures read in the header", () => {
    const { container } = render(view({
      live: false,
      feed: [
        { tool: "skill_manage", done: true, failed: true, errorMessage: "skill exists" },
        { tool: "skill_manage", done: true },
      ],
    }));
    const head = container.querySelector<HTMLElement>("[data-activity-head]")!;
    expect(head.querySelector("[data-activity-summary]")?.textContent).toBe("2 outils");
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
