import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import type { SpeechSynthesisAdapter } from "../../src/lib/voice/web-speech-synthesis";
import { ThreadTimeline } from "../../src/components/thread-timeline";
import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { requestThreadReveal } from "../../src/lib/thread/thread-reveal";

/**
 * The virtual rows of the thread (D1d), on a layout happy-dom does not
 * compute: each turn row is `rowHeight` px tall, spacers take their inline
 * height, everything else in the column is 0 px, items 12 px apart. The
 * viewport is 200 px; positions follow `scrollTop`.
 */

const VIEW = 200;
const GAP = 12;
const speechAdapter: SpeechSynthesisAdapter = {
  supported: false,
  voices: () => [],
  subscribeVoicesChanged: () => () => {},
  speak: () => {},
  cancel: () => {},
};

let rowHeight: (key: string) => number = () => 100;
const observers: ResizeObserverCallback[] = [];
const restore: Array<() => void> = [];

function scrollerOf(node: Element): HTMLElement | null {
  return node.closest<HTMLElement>("[role='log']");
}

function childHeight(child: Element): number {
  const element = child as HTMLElement;
  if (element.dataset.threadSpacer) return Number.parseFloat(element.style.height) || 0;
  const key = element.getAttribute("data-thread-turn");
  return key ? rowHeight(key) : 0;
}

/** Top of each child of the messages column, in content coordinates, and the content height. */
function columnLayout(column: Element): { tops: Map<Element, number>; total: number } {
  const tops = new Map<Element, number>();
  let at = 0;
  [...column.children].forEach((child, index) => {
    if (index > 0) at += GAP;
    tops.set(child, at);
    at += childHeight(child);
  });
  return { tops, total: at };
}

function mockLayout() {
  const prototype = HTMLElement.prototype;
  const saved = ["scrollHeight", "clientHeight", "clientWidth", "scrollTop", "offsetHeight"].map((key) => {
    let owner: object | null = prototype;
    while (owner && !Object.getOwnPropertyDescriptor(owner, key)) owner = Object.getPrototypeOf(owner) as object | null;
    return [key, owner ? Object.getOwnPropertyDescriptor(owner, key) : undefined] as const;
  });
  const scrollTops = new WeakMap<HTMLElement, number>();
  const contentHeight = (scroller: HTMLElement) => {
    const column = scroller.querySelector("[data-thread-messages]");
    return column ? columnLayout(column).total : 0;
  };
  Object.defineProperties(prototype, {
    scrollHeight: { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "log" ? contentHeight(this) : 0; } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "log" ? VIEW : 0; } },
    clientWidth: { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "log" ? 600 : 0; } },
    offsetHeight: { configurable: true, get(this: HTMLElement) { return childHeight(this); } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
      set(this: HTMLElement, value: number) {
        if (this.getAttribute("role") !== "log") return;
        scrollTops.set(this, Math.min(Math.max(0, value), Math.max(0, contentHeight(this) - VIEW)));
      },
    },
  });
  const originalRect = prototype.getBoundingClientRect;
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.getAttribute("role") === "log") return { top: 0, bottom: VIEW, left: 0, right: 600, width: 600, height: VIEW, x: 0, y: 0 } as DOMRect;
    const scroller = scrollerOf(this);
    const column = scroller?.querySelector("[data-thread-messages]");
    let child: Element | null = this;
    while (child && child.parentElement !== column) child = child.parentElement;
    if (!scroller || !column || !child) return originalRect.call(this);
    const top = columnLayout(column).tops.get(child)! - scroller.scrollTop;
    const height = childHeight(child);
    return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top } as DOMRect;
  };
  const originalIntoView = prototype.scrollIntoView;
  prototype.scrollIntoView = function (this: HTMLElement) {
    const scroller = scrollerOf(this);
    if (scroller) scroller.scrollTop += this.getBoundingClientRect().top;
  };
  const originalFromPoint = document.elementFromPoint;
  // The row under the point; in it, its children stacked 24 px apart, and in
  // the child the deepest first element (a text's box, as a browser would hit).
  document.elementFromPoint = (_x: number, y: number) => {
    for (const row of document.querySelectorAll<HTMLElement>("[data-thread-turn]")) {
      const box = row.getBoundingClientRect();
      if (y < box.top || y >= box.bottom) continue;
      const children = [...row.children];
      let hit: Element = children[Math.min(children.length - 1, Math.floor((y - box.top) / 24))] ?? row;
      while (hit.firstElementChild) hit = hit.firstElementChild;
      return hit;
    }
    return null;
  };
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observers.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  restore.push(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else delete (prototype as unknown as Record<string, unknown>)[key];
    }
    prototype.getBoundingClientRect = originalRect;
    prototype.scrollIntoView = originalIntoView;
    document.elementFromPoint = originalFromPoint;
    globalThis.ResizeObserver = originalObserver;
  });
}

/** Every ResizeObserver callback, as the browser runs them after a layout change. */
function resized() {
  act(() => {
    for (const callback of observers) callback([], {} as ResizeObserver);
  });
}

const inputs = (count: number, prefix = "q", day = 5) => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`,
  runId: null,
  text: `Question ${prefix} ${index}`,
  createdAt: new Date(Date.UTC(2026, 9, day, 0, 0, index)).toISOString(),
}));

function view(userInputs: ReturnType<typeof inputs>, extra: { hasOlderHistory?: boolean; onLoadOlder?: () => Promise<boolean>; events?: StoredProductEvent[]; runs?: Array<Pick<RunDto, "id" | "status" | "createdAt">> } = {}) {
  return (
    <I18nProvider>
      <ThreadTimeline events={[]} userInputs={userInputs} approvals={[]} running={false}
        speechAdapter={speechAdapter} scrollToBottomOnThreadKey="virtual" {...extra} />
    </I18nProvider>
  );
}

const mountedQuestions = () =>
  [...document.querySelectorAll<HTMLElement>("[data-thread-turn]")].map((row) => row.getAttribute("data-thread-turn"));
const scroller = () => document.querySelector<HTMLElement>("[role='log']")!;
/** A scroll as the browser reports it: the position, then its `scroll` event. */
function scrollTo(top: number) {
  act(() => {
    scroller().scrollTop = top;
    fireEvent.scroll(scroller());
  });
}
/** Opens the thread: the browser reports the pin's own scroll too. */
function open(node: React.ReactElement) {
  const rendered = render(node);
  act(() => {
    fireEvent.scroll(scroller());
  });
  return rendered;
}
const rowTop = (key: string) => document.querySelector<HTMLElement>(`[data-thread-turn="${key}"]`)!.getBoundingClientRect().top;

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  rowHeight = () => 100;
  observers.length = 0;
  mockLayout();
});

afterEach(() => {
  cleanup();
  while (restore.length) restore.pop()!();
});

describe("ThreadTimeline, virtual rows", () => {
  test("a long thread mounts the turns at the bottom; the others are one spacer above", () => {
    open(view(inputs(50)));
    const mounted = mountedQuestions();
    // 200 px of view and 600 px of overscan: 8 rows of 112 px, not 50.
    expect(mounted.length).toBeGreaterThan(3);
    expect(mounted.length).toBeLessThan(12);
    expect(mounted.at(-1)).toBe("q-49");
    expect(document.querySelector("[data-thread-spacer='top']")).not.toBeNull();
    expect(scroller().scrollTop).toBe(scroller().scrollHeight - VIEW);
  });

  test("a turn measured once keeps its height after it is unmounted", () => {
    open(view(inputs(50)));
    // Never mounted, the first turns count at their estimate (a one-line question: less than 100 px).
    const estimated = scroller().scrollHeight;
    expect(estimated).toBeLessThan(50 * 100 + 49 * GAP);
    scrollTo(0);
    const firstMounted = mountedQuestions().length;
    scrollTo(scroller().scrollHeight);
    expect(screen.queryByText("Question q 0")).toBeNull();
    // Measured at the top, the first turns now stand in the spacer at 100 px each.
    expect(scroller().scrollHeight).toBeGreaterThanOrEqual(estimated + firstMounted * 20);
  });

  test("scrolling to the top mounts the first turns and unmounts the last", () => {
    open(view(inputs(50)));
    scrollTo(0);
    expect(screen.getByText("Question q 0")).toBeTruthy();
    expect(screen.queryByText("Question q 49")).toBeNull();
    // The view stays at the top: no row was in view to hold, none pulls it down.
    expect(scroller().scrollTop).toBe(0);
    expect(document.querySelector("[data-thread-spacer='bottom']")).not.toBeNull();
  });

  test("a turn above the reader that grows does not move what the reader reads", () => {
    open(view(inputs(50)));
    scrollTo(20 * 112);
    const read = mountedQuestions().find((key) => rowTop(key!) >= 0)!;
    const before = rowTop(read);
    const above = mountedQuestions()[0]!;
    expect(rowTop(above)).toBeLessThan(before);
    // An image decodes in a turn above: +250 px, then the observers run.
    rowHeight = (key) => (key === above ? 350 : 100);
    resized();
    expect(rowTop(read)).toBe(before);
  });

  test("older history prepended above keeps the turns read under the eyes", () => {
    const older = inputs(10, "old", 4);
    const rendered = open(view(inputs(20), { hasOlderHistory: true, onLoadOlder: async () => true }));
    scrollTo(0);
    fireEvent.click(screen.getByRole("button", { name: "Charger 40 tours plus anciens" }));
    const before = rowTop("q-0");
    rendered.rerender(view([...older, ...inputs(20)]));
    expect(rowTop("q-0")).toBe(before);
    expect(scroller().scrollTop).toBeGreaterThan(0);
  });

  test("older history of the same day holds too, though the first turn loses its day chip", () => {
    // Same day: the chip that opened the oldest loaded turn moves to the older page.
    // At noon, a few seconds apart: the same day in any time zone, no gap chip either.
    const noon = (input: ReturnType<typeof inputs>[number], seconds: number) => ({ ...input, createdAt: new Date(Date.UTC(2026, 9, 5, 12, 0, seconds)).toISOString() });
    const current = inputs(20).map((input, index) => noon(input, 20 + index));
    const older = inputs(10, "old").map((input, index) => noon(input, index));
    const rendered = open(view(current, { hasOlderHistory: true, onLoadOlder: async () => true }));
    scrollTo(0);
    expect(document.querySelector("[data-thread-turn='q-0'] [data-thread-date]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Charger 40 tours plus anciens" }));
    const before = rowTop("q-0");
    rendered.rerender(view([...older, ...current]));
    expect(document.querySelector("[data-thread-turn='q-0'] [data-thread-date]")).toBeNull();
    expect(rowTop("q-0")).toBe(before);
  });

  test("a thread opened by a welcome (a run without a question) holds when older history arrives", () => {
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 5, 12, 0, seconds)).toISOString();
    const welcome = {
      events: [
        { cursor: 1, runId: "welcome", sequence: 1, type: "agent.message", payload: { text: "Bonjour, je suis Atlas." }, occurredAt: new Date(at(10)) },
        { cursor: 2, runId: "welcome", sequence: 2, type: "run.completed", payload: {}, occurredAt: new Date(at(11)) },
      ] as StoredProductEvent[],
      runs: [{ id: "welcome", status: "completed" as const, createdAt: at(10) }],
    };
    const current = inputs(20).map((input, index) => ({ ...input, createdAt: at(20 + index) }));
    const older = inputs(5, "old").map((input, index) => ({ ...input, createdAt: at(index) }));
    const rendered = open(view(current, { hasOlderHistory: true, onLoadOlder: async () => true, ...welcome }));
    scrollTo(0);
    const firstRow = mountedQuestions()[0]!;
    expect(firstRow.startsWith("q-")).toBe(false);
    const target = () => document.querySelector(`[data-thread-turn] [data-thread-find-target^="event:welcome"]`)!;
    const before = target().getBoundingClientRect().top;
    fireEvent.click(screen.getByRole("button", { name: "Charger 40 tours plus anciens" }));
    rendered.rerender(view([...older, ...current], welcome));
    // The welcome now closes the last older turn: its row is a new one, its message holds the place.
    expect(mountedQuestions()).not.toContain(firstRow);
    expect(target().getBoundingClientRect().top).toBe(before);
  });

  test("a target out of the mounted turns is mounted, then the thread lands on it", () => {
    open(view(inputs(50)));
    expect(screen.queryByText("Question q 3")).toBeNull();
    act(() => requestThreadReveal("message:q-3"));
    expect(screen.getByText("Question q 3")).toBeTruthy();
    // Landed at the top of the view, and kept there once the neighbours mount.
    expect(rowTop("q-3")).toBe(0);
    expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).not.toBeNull();
  });

  test("the keyboard focus keeps its turn mounted while the view moves away", () => {
    open(view(inputs(50)));
    const focusable = document.querySelector<HTMLElement>("[data-thread-turn='q-47'] [tabindex]")!;
    act(() => focusable.focus());
    scrollTo(0);
    expect(document.activeElement).toBe(focusable);
    expect(screen.getByText("Question q 47")).toBeTruthy();
  });

  test("a selection keeps its turns mounted while the reader scrolls away", () => {
    open(view(inputs(50)));
    const row = document.querySelector<HTMLElement>("[data-thread-turn='q-48']")!;
    act(() => {
      document.getSelection()!.selectAllChildren(row);
    });
    scrollTo(0);
    expect(screen.getByText("Question q 0")).toBeTruthy();
    expect(screen.getByText("Question q 48")).toBeTruthy();
    // Contiguous: every turn between the view and the selection is there to copy.
    expect(screen.getByText("Question q 30")).toBeTruthy();
    act(() => document.getSelection()!.removeAllRanges());
  });
});
