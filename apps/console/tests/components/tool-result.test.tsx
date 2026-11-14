import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TOOL_LOG_MAX_LINES, groupToolCalls, type ToolCall } from "@openedbot/conversation/domain/thread-tools";
import { I18nProvider } from "../../src/lib/i18n";
import { TOOL_RESULT_FOLD_DELAY_MS, ToolResult } from "../../src/components/thread-tool-result";

const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalMatchMedia = window.matchMedia;
let scrolls: Array<{ top?: number; behavior?: ScrollBehavior }> = [];

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function view(calls: ToolCall[]) {
  const [group] = groupToolCalls(calls);
  return (
    <I18nProvider>
      <ToolResult group={group!} approvals={[]} />
    </I18nProvider>
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  scrolls = [];
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, options?: ScrollToOptions | number) {
    if (this.hasAttribute("data-tool-result-log") && typeof options === "object") scrolls.push(options);
  } as typeof HTMLElement.prototype.scrollTo;
  mockReducedMotion(false);
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  window.matchMedia = originalMatchMedia;
});

describe("ToolResult", () => {
  test("renders a running call: title, technical name, command meta, Running status, open log", () => {
    const { container } = render(view([{ tool: "terminal", done: false, preview: "bun test" }]));
    const root = container.querySelector<HTMLElement>("[data-tool-result]")!;
    expect(root.getAttribute("data-state")).toBe("running");
    expect(root.getAttribute("aria-busy")).toBe("true");
    const trigger = root.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.textContent).toContain("Exécute une commande");
    expect(root.querySelector("[data-tool-name]")?.textContent).toBe("terminal");
    expect(root.querySelector("[data-tool-meta]")?.textContent).toBe("bun test");
    expect(root.querySelector("[data-tool-status]")?.textContent).toBe("En cours");
    const log = root.querySelector<HTMLElement>("[data-tool-result-log]")!;
    expect(log.getAttribute("role")).toBe("region");
    expect(log.getAttribute("aria-label")).toBe("Sortie de Exécute une commande");
    expect([...log.querySelectorAll("[data-tool-log-line]")].map((line) => line.textContent)).toEqual(["$ bun test"]);
  });

  test("the log follows each new line while the call runs, smoothly", async () => {
    const first: ToolCall = { tool: "terminal", done: true, preview: "pwd", resultExcerpt: "/tmp" };
    const { rerender, container } = render(view([first, { tool: "terminal", done: false, preview: "ls" }]));
    await act(nextFrame);
    expect(scrolls.length).toBeGreaterThan(0);
    expect(scrolls.at(-1)?.behavior).toBe("smooth");
    const before = scrolls.length;

    rerender(view([first, { tool: "terminal", done: true, preview: "ls", resultExcerpt: "a.txt\nb.txt" }, { tool: "terminal", done: false, preview: "id" }]));
    await act(nextFrame);
    expect(scrolls.length).toBeGreaterThan(before);
    const lines = [...container.querySelectorAll("[data-tool-log-line]")].map((line) => line.textContent);
    expect(lines).toEqual(["$ pwd", "/tmp", "", "$ ls", "a.txt", "b.txt", "", "$ id"]);
  });

  test("stops following once the operator scrolls the log up", async () => {
    const first: ToolCall = { tool: "terminal", done: true, preview: "pwd", resultExcerpt: "/tmp" };
    const { rerender, container } = render(view([first, { tool: "terminal", done: false, preview: "ls" }]));
    await act(nextFrame);
    const log = container.querySelector<HTMLElement>("[data-tool-result-log]")!;
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 160 });
    log.scrollTop = 440;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    const before = scrolls.length;

    rerender(view([first, { tool: "terminal", done: true, preview: "ls", resultExcerpt: "a.txt" }]));
    await act(nextFrame);
    expect(scrolls.length).toBe(before);
  });

  test("under prefers-reduced-motion the log jumps to its end instead of gliding", async () => {
    mockReducedMotion(true);
    render(view([{ tool: "terminal", done: false, preview: "bun test" }]));
    await act(nextFrame);
    expect(scrolls.at(-1)?.behavior).toBe("auto");
  });

  test("rolls to Completed and folds its panel away once the call completes", async () => {
    const { rerender, container } = render(view([{ tool: "terminal", done: false, preview: "bun test" }]));
    const trigger = () => container.querySelector<HTMLButtonElement>("[data-tool-result] > button")!;
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    rerender(view([{ tool: "terminal", done: true, preview: "bun test", durationMs: 1840, resultExcerpt: "42 pass" }]));
    const root = container.querySelector<HTMLElement>("[data-tool-result]")!;
    expect(root.getAttribute("data-state")).toBe("done");
    expect(root.getAttribute("aria-busy")).toBe("false");
    // The status and the meta roll: the new value enters, the old one leaves.
    const status = root.querySelector<HTMLElement>("[data-tool-status]")!;
    expect(status.querySelector("[data-roll-in]")?.textContent).toBe("Terminé");
    expect(status.querySelector("[data-roll-out]")?.textContent).toBe("En cours");
    expect(root.querySelector("[data-tool-meta] [data-roll-in]")?.textContent).toBe("1,8 s");
    // Still open: the result is read before the fold.
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector("[data-tool-result-log]")?.textContent).toContain("42 pass");

    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"), {
      timeout: TOOL_RESULT_FOLD_DELAY_MS + 1000,
    });
    const panel = root.querySelector<HTMLElement>(".openedbot-disclosure")!;
    expect(panel.getAttribute("data-open")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(status.querySelector("[data-roll-out]")).toBeNull());
  });

  test("output that arrives only with the completion opens the panel, then folds", async () => {
    const { rerender, container } = render(view([{ tool: "skill_manage", done: false }]));
    const trigger = () => container.querySelector<HTMLButtonElement>("[data-tool-result] > button")!;
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    rerender(view([{ tool: "skill_manage", done: true, resultExcerpt: "skill saved" }]));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const lines = () => [...container.querySelectorAll("[data-tool-log-line]")].map((line) => line.textContent);
    expect(lines()).toEqual(["skill saved"]);

    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"), {
      timeout: TOOL_RESULT_FOLD_DELAY_MS + 1000,
    });
  });

  test("a folded panel holds no log lines; they mount on open and leave after the close", async () => {
    const { container } = render(view([{ tool: "terminal", done: true, preview: "ls", resultExcerpt: "a.txt\nb.txt" }]));
    const trigger = () => container.querySelector<HTMLButtonElement>("[data-tool-result] > button")!;
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll("[data-tool-log-line]")).toHaveLength(0);
    // The copy still has the whole log: it is computed, not read from the DOM.
    expect(container.querySelector<HTMLButtonElement>("[data-tool-copy]")!.disabled).toBe(false);

    fireEvent.click(trigger());
    expect(container.querySelectorAll("[data-tool-log-line]")).toHaveLength(3);
    fireEvent.click(trigger());
    // Still there for the close animation, then gone.
    expect(container.querySelectorAll("[data-tool-log-line]")).toHaveLength(3);
    await waitFor(() => expect(container.querySelectorAll("[data-tool-log-line]")).toHaveLength(0));
  });

  test("a call already completed when it mounts stays folded; a failure stays open on its error", () => {
    const { container, unmount } = render(view([{ tool: "terminal", done: true, preview: "ls", resultExcerpt: "a.txt" }]));
    expect(container.querySelector("[data-tool-result] > button")?.getAttribute("aria-expanded")).toBe("false");
    unmount();

    const failed = render(view([{ tool: "terminal", done: true, failed: true, preview: "foo", errorMessage: "command not found: foo" }]));
    const root = failed.container.querySelector<HTMLElement>("[data-tool-result]")!;
    expect(root.getAttribute("data-state")).toBe("failed");
    expect(root.querySelector("[data-tool-result] > button")?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector("[data-tool-status]")?.textContent).toBe("Échec");
    expect(root.querySelector("[data-tool-error-inline]")?.textContent).toBe("command not found: foo");
  });

  test("the operator's click wins over the automatic fold", async () => {
    const { rerender, container } = render(view([{ tool: "terminal", done: false, preview: "bun test" }]));
    const trigger = () => container.querySelector<HTMLButtonElement>("[data-tool-result] > button")!;
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    rerender(view([{ tool: "terminal", done: true, preview: "bun test", resultExcerpt: "ok" }]));
    await act(() => new Promise((resolve) => setTimeout(resolve, TOOL_RESULT_FOLD_DELAY_MS + 300)));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  test("copies the full log and says so", async () => {
    const written: string[] = [];
    const clipboard = { writeText: async (text: string) => { written.push(text); } };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    render(view([{ tool: "terminal", done: true, failed: true, preview: "ls", resultExcerpt: "a.txt", errorMessage: "exit 1" }]));
    fireEvent.click(screen.getByRole("button", { name: "Copier le résultat" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Résultat copié" })).toBeTruthy());
    expect(written).toEqual(["$ ls\na.txt\nexit 1"]);
  });

  test("a cut log shows its head, a hidden-lines marker and its tail; the copy says and takes the whole log", async () => {
    const written: string[] = [];
    const clipboard = { writeText: async (text: string) => { written.push(text); } };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    const result = Array.from({ length: TOOL_LOG_MAX_LINES + 100 }, (_, index) => `line ${index}`).join("\n");
    const { container } = render(view([{ tool: "terminal", done: true, failed: true, preview: "seq", attachment: { result }, errorMessage: "boom" }]));
    const lines = [...container.querySelectorAll<HTMLElement>("[data-tool-log-line]")];
    // The DOM stays within the budget.
    expect(lines).toHaveLength(TOOL_LOG_MAX_LINES);
    const marker = container.querySelector<HTMLElement>("[data-tool-log-hidden]")!;
    expect(marker.getAttribute("data-tool-log-hidden")).toBe("103");
    expect(marker.textContent).toBe("103 lignes masquées");
    expect(lines.at(-1)?.textContent).toBe("boom");

    fireEvent.click(screen.getByRole("button", { name: "Copier le résultat complet" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Résultat copié" })).toBeTruthy());
    expect(written).toEqual([`$ seq\n${result}\nboom`]);
  });

  test("a silent call says the runtime sent nothing, and opens its detail on demand", () => {
    render(view([{ tool: "skill_manage", done: true }]));
    expect(screen.getByText("Le runtime n’a transmis aucun détail.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copier le résultat" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Voir le détail : skill_manage" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
