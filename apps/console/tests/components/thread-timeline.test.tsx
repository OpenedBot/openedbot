import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalRequestDto, RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { I18nProvider } from "../../src/lib/i18n";
import type { SpeechSynthesisAdapter } from "../../src/lib/voice/web-speech-synthesis";
import { ThreadTimeline } from "../../src/components/thread-timeline";
import { AttachmentCanvas, AttachmentCanvasProvider } from "../../src/components/attachment-canvas";
import { createLiveRunText, type ThreadLiveText } from "../../src/lib/stream/live-run-text";
import { weatherCard } from "../lib/cards/weather-fixture";

const LONG_TEXT_FIXTURE_SIZE = 280;

const speechAdapter: SpeechSynthesisAdapter = {
  supported: false,
  voices: () => [],
  subscribeVoicesChanged: () => () => {},
  speak: () => {},
  cancel: () => {},
};

function run(
  id: string,
  status: RunDto["status"],
  completionKind: string | null = null,
  stepKind: RunDto["stepKind"] = null,
): Pick<RunDto, "id" | "status" | "completionKind" | "stepKind"> {
  return { id, status, completionKind, stepKind };
}

function renderTimeline({
  events = [],
  userInputs = [],
  runs = [],
  running = false,
  defaultAuthor = null,
  scrollToBottomOnThreadKey = null,
  approvals = [],
  onOpenBotErrors,
  outgoing = null,
  liveText = null,
}: {
  events?: StoredProductEvent[];
  userInputs?: Array<{
    id: string;
    text: string;
    runId: string | null;
    authorBot?: null;
    createdAt?: string;
  }>;
  runs?: ReadonlyArray<Pick<RunDto, "id" | "status" | "completionKind" | "stepKind" | "routineId"> & Partial<Pick<RunDto, "createdAt">>>;
  running?: boolean;
  defaultAuthor?: { id: string; name: string; slug: string; face: null } | null;
  scrollToBottomOnThreadKey?: string | null;
  approvals?: ApprovalRequestDto[];
  onOpenBotErrors?: () => void;
  outgoing?: { id: string; text: string; failed?: boolean } | null;
  liveText?: ThreadLiveText | null;
}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <ThreadTimeline
          events={events}
          userInputs={userInputs}
          runs={runs}
          approvals={approvals}
          running={running}
          speechAdapter={speechAdapter}
          defaultAuthor={defaultAuthor}
          scrollToBottomOnThreadKey={scrollToBottomOnThreadKey}
          onOpenBotErrors={onOpenBotErrors}
          outgoing={outgoing}
          liveText={liveText}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function mockThreadScrollMetrics(
  getScrollHeight: () => number,
  clientHeight: number,
  clampScrollTop = false,
): () => void {
  const prototype = HTMLElement.prototype;
  const ownDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const inheritedDescriptor = (key: PropertyKey): PropertyDescriptor | undefined => {
    let current: object | null = prototype;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return descriptor;
      current = Object.getPrototypeOf(current) as object | null;
    }
    return undefined;
  };
  const scrollHeightDescriptor = inheritedDescriptor("scrollHeight");
  const clientHeightDescriptor = inheritedDescriptor("clientHeight");
  const scrollTopDescriptor = inheritedDescriptor("scrollTop");
  const scrollTops = new WeakMap<HTMLElement, number>();

  for (const key of ["scrollHeight", "clientHeight", "scrollTop"]) {
    ownDescriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
  }
  Object.defineProperties(prototype, {
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") === "log") return getScrollHeight();
        // The messages column measures the same content: the first window
        // compares it with the viewport to decide whether it fills the screen.
        if (this.hasAttribute("data-thread-messages")) return getScrollHeight();
        return scrollHeightDescriptor?.get?.call(this) ?? 0;
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") === "log") return clientHeight;
        return clientHeightDescriptor?.get?.call(this) ?? 0;
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") === "log") return scrollTops.get(this) ?? 0;
        return scrollTopDescriptor?.get?.call(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        if (this.getAttribute("role") === "log") {
          const maximum = Math.max(0, getScrollHeight() - clientHeight);
          scrollTops.set(this, clampScrollTop ? Math.min(Math.max(0, value), maximum) : value);
          return;
        }
        scrollTopDescriptor?.set?.call(this, value);
      },
    },
  });

  return () => {
    for (const [key, descriptor] of ownDescriptors) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else delete (prototype as unknown as Record<PropertyKey, unknown>)[key];
    }
  };
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(cleanup);

describe("ThreadTimeline", () => {
  test("a history error remains visible with a retry control", () => {
    render(<I18nProvider><ThreadTimeline events={[]} userInputs={[]} approvals={[]} running={false}
      speechAdapter={speechAdapter} hasOlderHistory olderError onLoadOlder={async () => false} /></I18nProvider>);
    expect(screen.getByRole("alert").textContent).toContain("Impossible de charger les tours plus anciens");
    expect(screen.getByRole("button", { name: "Charger 40 tours plus anciens" }).hasAttribute("disabled")).toBe(false);
  });

  test("épingle le fil au montage avant la première frame", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    const restoreScrollMetrics = mockThreadScrollMetrics(() => 1_000, 200);
    globalThis.requestAnimationFrame = ((next: FrameRequestCallback) => {
      frames.push(next);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

    try {
      const { container } = renderTimeline({ scrollToBottomOnThreadKey: "thread-b" });
      const scroller = container.querySelector<HTMLElement>('[role="log"]');
      expect(scroller).not.toBeNull();
      if (!scroller) throw new Error("ThreadTimeline test scroller is missing");
      expect(frames.length).toBeGreaterThan(0);
      expect(scroller.scrollTop).toBe(1_000);
      expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).toBeNull();
    } finally {
      restoreScrollMetrics();
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  test("dans le fil d'un bot, la bulle envoyée amène sa ligne « Réflexion » dans la même peinture", () => {
    const author = { id: "bot-1", name: "Atlas", slug: "atlas", face: null };
    const sent = renderTimeline({ defaultAuthor: author, outgoing: { id: "out-1", text: "salut" } });
    // Under the bubble, in its box: the pending « Réflexion » is the run's
    // host block (author line included), no longer a separate status line
    // that the run's block replaced on acknowledgement.
    const box = sent.container.querySelector("[data-thread-outgoing]");
    expect(box?.querySelector("[data-user-bubble]")).not.toBeNull();
    expect(box?.querySelector("[data-turn-activity][data-thread-thinking]")).not.toBeNull();
    expect(sent.container.querySelectorAll("[data-thread-thinking]")).toHaveLength(1);
    sent.unmount();
    // A failed send thinks nothing; neither does a room, where no bot may answer.
    const failed = renderTimeline({ defaultAuthor: author, outgoing: { id: "out-2", text: "salut", failed: true } });
    expect(failed.container.querySelector("[data-thread-thinking]")).toBeNull();
    failed.unmount();
    const room = renderTimeline({ outgoing: { id: "out-3", text: "salut" } });
    expect(room.container.querySelector("[data-thread-thinking]")).toBeNull();
  });

  test("le ResizeObserver repingle le contenu qui grandit dans son rappel, avant la peinture", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    // Two observers: the pin's (the messages column) and the virtual rows' (each turn, the viewport).
    const observers: Array<{ callback: ResizeObserverCallback; observed: Element[] }> = [];
    const frames: FrameRequestCallback[] = [];
    class FakeResizeObserver {
      private readonly record: { callback: ResizeObserverCallback; observed: Element[] };
      constructor(next: ResizeObserverCallback) {
        this.record = { callback: next, observed: [] };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((next: FrameRequestCallback) => {
      frames.push(next);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

    try {
      const { container } = renderTimeline({ scrollToBottomOnThreadKey: "thread-a" });
      const scroller = container.querySelector<HTMLElement>('[role="log"]');
      const content = container.querySelector<HTMLElement>("[data-thread-messages]");
      expect(scroller).not.toBeNull();
      expect(content).not.toBeNull();
      if (!scroller || !content) throw new Error("ThreadTimeline test nodes are missing");
      const pin = observers.find((observer) => observer.observed.includes(content));
      // Compared by identity: a failed `toEqual` on DOM nodes would print the whole tree.
      expect(pin?.observed.length).toBe(1);
      const callback = pin?.callback;
      frames.splice(0).forEach((frame) => frame(0));
      expect(callback).toBeDefined();

      act(() => {
        callback?.([{ target: scroller } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      });
      expect(frames).toHaveLength(0);

      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1_000 });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
      // No frame of delay: a pin handed to the next frame painted the grown
      // thread one frame too high, then jumped (the « bump » on every send).
      act(() => callback?.([{ target: content } as unknown as ResizeObserverEntry], {} as ResizeObserver));
      expect(frames).toHaveLength(0);
      expect(scroller.scrollTop).toBe(1_000);

      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1_400 });
      act(() => {
        callback?.([
          { target: content } as unknown as ResizeObserverEntry,
          { target: content } as unknown as ResizeObserverEntry,
        ], {} as ResizeObserver);
      });
      expect(frames).toHaveLength(0);
      expect(scroller.scrollTop).toBe(1_400);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  describe("épinglage à l'envoi", () => {
    const author = { id: "bot-1", name: "Atlas", slug: "atlas", face: null };
    const VIEWPORT = 500;
    // Content above the sent turn, and what follows a turn (gap, scroll anchor).
    const ABOVE = 1_000;
    const TAIL = 13;
    const earlier = [
      { id: "m1", text: "Premier", runId: "run-1" },
      { id: "m2", text: "Deuxième", runId: "run-2" },
    ];
    const settled = [
      { id: "run-1", status: "completed" as const, completionKind: null, stepKind: null },
      { id: "run-2", status: "completed" as const, completionKind: null, stepKind: null },
    ];
    type Input = { id: string; text: string; runId: string | null; clientSubmissionId?: string | null };
    type Outgoing = { id: string; text: string; clientSubmissionId?: string };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (props: {
      userInputs: Input[];
      runs?: Array<Pick<RunDto, "id" | "status" | "completionKind" | "stepKind"> & Partial<Pick<RunDto, "createdAt">>>;
      running?: boolean;
      outgoing?: Outgoing | null;
    }) => (
      <QueryClientProvider client={client}><I18nProvider>
        <ThreadTimeline
          events={[]}
          userInputs={props.userInputs}
          runs={props.runs ?? settled}
          approvals={[]}
          running={props.running ?? false}
          speechAdapter={speechAdapter}
          defaultAuthor={author}
          scrollToBottomOnThreadKey="thread-anchor"
          outgoing={props.outgoing ?? null}
        />
      </I18nProvider></QueryClientProvider>
    );

    // The layout jsdom lacks: the sent turn sits after ABOVE px of thread, at
    // its natural height (`natural`); a min-height would be a top reserve.
    let natural = 60;
    let turnSelector = "[data-thread-outgoing]";
    const turn = () => document.querySelector<HTMLElement>(turnSelector);
    const reserveOf = (node: HTMLElement | null) => Number.parseFloat(node?.style.minHeight ?? "") || 0;
    const scrollHeight = () => ABOVE + (turn() ? Math.max(natural, reserveOf(turn())) : 0) + TAIL;
    const observers: Array<{ callback: ResizeObserverCallback; observed: Element[] }> = [];
    const frames: FrameRequestCallback[] = [];
    let restore: () => void = () => {};

    beforeEach(() => {
      natural = 60;
      turnSelector = "[data-thread-outgoing]";
      observers.length = 0;
      frames.length = 0;
      const originalResizeObserver = globalThis.ResizeObserver;
      const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
      const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      class FakeResizeObserver {
        private readonly record: { callback: ResizeObserverCallback; observed: Element[] };
        constructor(next: ResizeObserverCallback) {
          this.record = { callback: next, observed: [] };
          observers.push(this.record);
        }
        observe(target: Element) { this.record.observed.push(target); }
        unobserve() {}
        disconnect() {}
      }
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
      globalThis.requestAnimationFrame = ((next: FrameRequestCallback) => frames.push(next)) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const scroller = this.closest('[role="log"]') as HTMLElement | null;
        const offset = scroller ? -scroller.scrollTop : 0;
        const at = (top: number, height: number) => ({ top: top + offset, bottom: top + height + offset, height, left: 0, right: 0, width: 0, x: 0, y: top + offset, toJSON() {} }) as DOMRect;
        if (this === turn()) return at(ABOVE, Math.max(natural, reserveOf(this)));
        if (this.hasAttribute("data-thread-scroll-anchor")) return at(scrollHeight() - 1, 1);
        return originalRect.call(this);
      };
      const restoreMetrics = mockThreadScrollMetrics(scrollHeight, VIEWPORT, true);
      restore = () => {
        restoreMetrics();
        HTMLElement.prototype.getBoundingClientRect = originalRect;
        globalThis.ResizeObserver = originalResizeObserver;
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      };
    });
    afterEach(() => restore());

    const scroller = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="log"]')!;
    const contentResized = (container: HTMLElement) => {
      const content = container.querySelector("[data-thread-messages]")!;
      const pin = observers.find((observer) => observer.observed.includes(content));
      act(() => pin?.callback([{ target: content } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    };
    const flushFrames = () => act(() => frames.splice(0).forEach((frame) => frame(0)));

    const bottom = () => ABOVE + natural + TAIL - VIEWPORT;

    test("la bulle envoyée arrive avec sa ligne d'état ; le fil descend une fois, en bas, sans réserve en haut", () => {
      const rendered = render(view({ userInputs: earlier }));
      const log = scroller(rendered.container);
      flushFrames();
      expect(log.scrollTop).toBe(ABOVE + TAIL - VIEWPORT);

      const sent = { id: "pending:s3", text: "Troisième", clientSubmissionId: "s3" };
      rendered.rerender(view({ userInputs: earlier, outgoing: sent }));
      const box = turn()!;
      // Bubble and status row in the same commit, then the thread at the bottom before paint.
      expect(box.querySelector("[data-user-bubble]")).not.toBeNull();
      const row = box.querySelector<HTMLElement>("[data-run-status='pending']");
      expect(row).not.toBeNull();
      expect(rendered.container.querySelector("[style*='min-height']")).toBeNull();
      expect(log.scrollTop).toBe(bottom());
      expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).toBeNull();
      // No deferred motion on top of it.
      flushFrames();
      expect(log.scrollTop).toBe(bottom());

      // Acknowledged: the saved row takes over the box, the pending row stays the same node.
      turnSelector = '[data-thread-turn="m3"]';
      rendered.rerender(view({
        userInputs: [...earlier, { id: "m3", text: "Troisième", runId: "run-3", clientSubmissionId: "s3" }],
        runs: [...settled, { id: "run-3", status: "queued", completionKind: null, stepKind: null, createdAt: new Date().toISOString() }],
        running: true,
      }));
      // Compared by identity: a failed `toBe` on DOM nodes would print the whole tree.
      expect(turn() === box).toBe(true);
      expect(box.querySelector("[data-run-status]") === row).toBe(true);

      // The reply grows at the bottom: the pinned thread follows it.
      natural = 300;
      contentResized(rendered.container);
      expect(log.scrollTop).toBe(bottom());
    });

    test("un message de l'opérateur arrivé sans bulle optimiste (labo, autre appareil) descend aussi en bas", () => {
      const rendered = render(view({ userInputs: earlier }));
      const log = scroller(rendered.container);
      flushFrames();
      turnSelector = '[data-thread-turn="m3"]';
      rendered.rerender(view({
        userInputs: [...earlier, { id: "m3", text: "Troisième", runId: "run-3" }],
        runs: [...settled, { id: "run-3", status: "running", completionKind: null, stepKind: null }],
        running: true,
      }));
      expect(rendered.container.querySelector("[style*='min-height']")).toBeNull();
      expect(log.scrollTop).toBe(bottom());
    });

    test("un lecteur remonté redescend à l'envoi, dans le commit de la bulle", () => {
      const rendered = render(view({ userInputs: earlier }));
      const log = scroller(rendered.container);
      flushFrames();
      // The reader scrolls up: a gesture (scrollTop down, stable box) releases the pin.
      log.scrollTop = 100;
      fireEvent.scroll(log);
      expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).not.toBeNull();
      rendered.rerender(view({ userInputs: earlier, outgoing: { id: "pending:s6", text: "Encore", clientSubmissionId: "s6" } }));
      expect(log.scrollTop).toBe(bottom());
      expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).toBeNull();
    });
  });

  // `memory` stays in the `stepKind` union for runs FROM BEFORE 07-09,
  // which still live in the database: their output still must not become a bubble.
  test("un run de service (ancienne extraction mémoire) ne laisse aucune bulle vide dans le fil", () => {
    const { container } = renderTimeline({
      events: [
        {
          cursor: 1,
          sequence: 1,
          runId: "run-answer",
          type: "agent.message",
          payload: { text: "La compétence est enregistrée." },
          occurredAt: new Date("2026-09-04T00:00:00.000Z"),
        },
        {
          cursor: 2,
          sequence: 0,
          runId: "run-memory",
          type: "agent.message",
          payload: { text: "remember: Symfony est le framework de référence." },
          occurredAt: new Date("2026-09-04T00:00:10.000Z"),
        },
      ],
      runs: [run("run-answer", "completed"), run("run-memory", "completed", "normal", "memory")],
      defaultAuthor: { id: "bot-1", name: "Atlas", slug: "atlas", face: null },
    });

    const responses = container.querySelectorAll<HTMLElement>("[data-assistant-response]");
    expect(responses.length).toBe(1);
    expect(responses[0]?.textContent).toContain("La compétence est enregistrée.");
    expect(container.textContent).not.toContain("remember:");
  });

  test("la réponse dans la bulle de l'app de référence : sans signature ni durée affichée", () => {
    const answerRun = {
      ...run("run-answer", "completed"),
      createdAt: "2026-09-03T00:00:00.000Z",
      endedAt: "2026-09-03T00:00:01.250Z",
      usage: { totalTokens: 40, outputTokens: 9 },
    };
    const { container } = renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-answer",
        type: "agent.message",
        payload: { text: "Réponse alignée" },
        occurredAt: new Date("2026-09-03T00:00:00.800Z"),
      }],
      runs: [answerRun],
      defaultAuthor: { id: "bot-1", name: "Cahier2", slug: "cahier2", face: null },
    });

    const turn = container.querySelector<HTMLElement>('[data-turn-of="bot-1"]');
    const response = turn?.querySelector<HTMLElement>("[data-assistant-response]");
    expect(turn?.className).toContain("flex-col");
    expect(response).not.toBeNull();
    expect(response?.parentElement).toBe(turn);
    expect(response?.className).toContain("w-full");
    // No more signature under the bubble: a DM thread has only one speaker.
    expect(turn?.querySelector("[data-assistant-author]")).toBeNull();
    expect(response?.querySelector('[data-assistant-layout="stream"] .prose')).not.toBeNull();
    expect([...(response?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "1.25s")).toBe(false);
    // No native time or duration tooltip on hovering the turn: only
    // the action-row buttons name their gesture.
    expect(turn?.hasAttribute("title")).toBe(false);
    expect(container.querySelector("[data-turn-of] [title]:not(button)")).toBeNull();
  });

  test("une réponse longue tient dans une seule surface, jamais en pile de cartes", () => {
    const { container } = renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-answer",
        type: "agent.message",
        payload: {
          text: `Demain, je partirais sur un monolithe modulaire Symfony.

Structure proposée :

src/
Shared/
Domain/
Application/
Infrastructure/

Chaque module métier contient :

- DTO stricts ;
- validation Symfony ;
- erreurs RFC 9457 ;
- Doctrine ORM.

En résumé : monolithe modulaire, domaines isolés.`,
        },
        occurredAt: new Date("2026-09-04T00:00:00.000Z"),
      }],
      runs: [run("run-answer", "completed")],
      defaultAuthor: { id: "bot-1", name: "Atlas", slug: "atlas", face: null },
    });

    const surface = container.querySelector<HTMLElement>("[data-assistant-layout]");
    // the reference app's bubble: a single surface, at most 560 px, whose veil
    // comes from the stylesheet (no `bg-` class).
    expect(surface?.getAttribute("data-assistant-layout")).toBe("stream");
    expect(surface?.className).toContain("w-full");
    expect(surface?.className).not.toContain("bg-");
    expect(surface?.closest("article")?.className).toContain("w-full");
    expect(container.querySelectorAll("[data-assistant-layout]").length).toBe(1);
    expect(container.querySelector("[data-assistant-card]")).toBeNull();
    // The tree is one block, not five paragraphs or three cards.
    expect(container.querySelector("[data-path-listing]")?.textContent).toBe("src/\nShared/\nDomain/\nApplication/\nInfrastructure/");
    expect(container.querySelector("aside")?.textContent).toContain("En résumé");
    // As in the reference app, the action row lives under the finished reply; the
    // surface keeps focus for the Menu key.
    expect(container.querySelector("[data-message-hover-actions]")).not.toBeNull();
    expect(surface?.closest("[tabindex='0']")).not.toBeNull();
  });

  test("une réplique courte prend la même surface qu’une longue", () => {
    const { container } = renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-answer",
        type: "agent.message",
        payload: { text: "Oui, c'est possible." },
        occurredAt: new Date("2026-09-04T00:00:00.000Z"),
      }],
      runs: [run("run-answer", "completed")],
      defaultAuthor: { id: "bot-1", name: "Atlas", slug: "atlas", face: null },
    });

    const surface = container.querySelector<HTMLElement>("[data-assistant-layout]");
    expect(surface?.getAttribute("data-assistant-layout")).toBe("stream");
    expect(surface?.className).not.toContain("bg-");
  });

  test("aligne aussi la carte outil sous l'avatar du bot", () => {
    const { container } = renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-tool",
        type: "tool.call",
        payload: { tool: "terminal", preview: "id" },
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
      }],
      runs: [run("run-tool", "completed")],
      defaultAuthor: { id: "bot-1", name: "Cahier2", slug: "cahier2", face: null },
    });

    // The run's head line (the bot, then its summary) opens the turn; the log folds under it.
    const turn = container.querySelector<HTMLElement>('[data-turn-of="bot-1"]');
    const head = turn?.querySelector<HTMLElement>("[data-run-head]");
    const author = head?.querySelector<HTMLElement>("[data-tool-author]");
    const activity = turn?.querySelector<HTMLElement>("[data-tool-activity]");
    expect(turn?.className).toContain("flex-col");
    expect(head?.parentElement).toBe(turn);
    expect(author?.textContent).toContain("Cahier2");
    expect(head?.querySelector("[data-run-status='done']")).not.toBeNull();
    expect(activity?.className).toContain("max-w-full");
    // The tool log is no longer a bubble: it reads as a tree,
    // flat on the reply's axis. What still matters is that it starts at
    // the same vertical as the face, with no indent.
    expect(activity?.className).toContain("self-start");
    expect(activity?.className).not.toContain("ml-8");
  });

  test("un tour entrecoupé de narration : les phrases sont des bulles, son résumé au-dessus d'elles", () => {
    const at = new Date("2026-09-03T00:00:00.000Z");
    const { container } = renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-activity", type: "tool.call", payload: { toolCallId: "tc-1", tool: "terminal" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-activity", type: "agent.message", payload: { text: "Je vérifie." }, occurredAt: at },
        { cursor: 3, sequence: 3, runId: "run-activity", type: "tool.call", payload: { toolCallId: "tc-2", tool: "terminal" }, occurredAt: at },
      ],
      runs: [run("run-activity", "completed")],
    });

    const heads = container.querySelectorAll("[data-turn-activity] [data-activity-head]");
    expect(heads).toHaveLength(1);
    expect(heads[0]!.getAttribute("data-run-status")).toBe("done");
    expect(heads[0]!.textContent).toContain("Réflexion");
    // The sentence is an assistant bubble, under the done summary; the log holds the tools only.
    const bubble = container.querySelector("[data-assistant-response]");
    expect(bubble?.textContent).toContain("Je vérifie.");
    expect(heads[0]!.compareDocumentPosition(bubble!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rows = [...container.querySelectorAll("[data-turn-activity] [data-activity-row]")]
      .map((row) => row.getAttribute("data-activity-row"));
    expect(rows).toEqual(["tool", "tool"]);
  });

  describe("la ligne d'état d'un run en direct", () => {
    const at = new Date();
    const author = { id: "bot-1", name: "Atlas", slug: "atlas", face: null };
    const event = (sequence: number, type: StoredProductEvent["type"], payload: StoredProductEvent["payload"]): StoredProductEvent =>
      ({ cursor: sequence, sequence, runId: "run-live", type, payload, occurredAt: at });
    const tool = (sequence: number, name = "terminal", preview?: string, done = false) => [
      event(sequence, "tool.call", { toolCallId: `tc-${sequence}`, tool: name, ...(preview ? { preview } : {}) }),
      ...(done ? [event(sequence + 0.5, "tool.result", { toolCallId: `tc-${sequence}`, tool: name, error: false })] : []),
    ];
    const say = (sequence: number, text: string) => event(sequence, "agent.message", { text });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (events: StoredProductEvent[], status: RunDto["status"] = "running", extra: { outgoing?: { id: string; text: string } | null; approvals?: ApprovalRequestDto[]; salon?: boolean } = {}) => (
      <QueryClientProvider client={client}><I18nProvider>
        <ThreadTimeline
          events={events}
          runs={[{
            ...run("run-live", status),
            createdAt: new Date(at.getTime() - 2000).toISOString(),
            ...(status === "completed" ? { endedAt: at.toISOString() } : {}),
          }]}
          userInputs={[{ id: "m1", text: "Fais-le", runId: "run-live" }]}
          approvals={extra.approvals ?? []}
          running={status === "running" || status === "queued"}
          speechAdapter={speechAdapter}
          defaultAuthor={extra.salon ? null : author}
          outgoing={extra.outgoing ?? null}
        />
      </I18nProvider></QueryClientProvider>
    );
    const rows = (container: HTMLElement) => container.querySelectorAll<HTMLElement>("[data-run-status]");
    const label = (container: HTMLElement) => container.querySelector("[data-run-status] [data-activity-summary]")?.textContent;
    const after = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    const lastOfTurn = (container: HTMLElement, node: Element) => {
      const turnRow = container.querySelector('[data-thread-turn="m1"]')!;
      return turnRow.lastElementChild!.contains(node);
    };
    // The bottom row's collapse lasts 200 ms (`RUN_LINE_MOTION_MS`).
    const collapse = () => act(async () => { await Bun.sleep(260); });

    test("une ligne en bas, un seul nœud de l'attente à la fin ; le résumé passe sur la ligne du nom, au-dessus des bulles", async () => {
      const rendered = render(view([], "queued"));
      const row = rows(rendered.container)[0]!;
      expect(row.dataset.runStatus).toBe("pending");
      expect(lastOfTurn(rendered.container, row)).toBe(true);

      rendered.rerender(view([...tool(1, "web_search", "météo Rennes")]));
      expect(rows(rendered.container)).toHaveLength(1);
      expect(rows(rendered.container)[0]).toBe(row);
      expect(row.dataset.runStatus).toBe("working");
      // The first step shows at once (masked label, never the raw arguments).
      expect(label(rendered.container)).toBe("Recherche : météo Rennes");

      // Live, the head line names the bot above everything of the run.
      const headLine = rendered.container.querySelector<HTMLElement>('[data-thread-turn="m1"] [data-run-head]')!;
      expect(headLine.textContent).toContain("Atlas");
      expect(after(headLine, row)).toBe(true);

      rendered.rerender(view([...tool(1, "web_search", "météo Rennes", true), say(2, "Je regarde la météo de Rennes.")]));
      expect(rows(rendered.container)[0]).toBe(row);
      // The live text smooths in from empty (`useSmoothText`): its PLACE is what counts here.
      const narration = rendered.container.querySelector("[data-assistant-response]")!;
      expect(after(headLine, narration)).toBe(true);
      expect(after(narration, row)).toBe(true);
      expect(lastOfTurn(rendered.container, row)).toBe(true);

      rendered.rerender(view([...tool(1, "web_search", "météo Rennes", true), say(2, "Je regarde la météo de Rennes."), ...tool(3, "web_extract", "https://meteo.example.com/rennes?token=x", true), say(4, "Il fait beau.")], "completed"));
      // Done: the bottom row collapses in place, the summary takes the head line.
      expect(rows(rendered.container)).toHaveLength(2);
      expect(row.isConnected).toBe(true);
      expect(row.dataset.runStatus).toBe("gone");
      const closing = row.closest<HTMLElement>("[data-turn-activity]")!;
      expect(closing.hasAttribute("data-run-collapsing")).toBe(true);
      expect(closing.className).toContain("openedbot-run-status-collapse");
      expect(lastOfTurn(rendered.container, row)).toBe(true);
      const summary = rendered.container.querySelector<HTMLElement>("[data-run-head] [data-run-status='done']")!;
      expect(summary.querySelector("[data-activity-summary]")?.textContent).toBe("Réflexion : 2s");
      expect(summary.closest("[data-run-head]")!.textContent).toContain("Atlas");
      // The name was already on screen: the summary replaces it in place, it does not open.
      expect(summary.closest("[data-run-reveal]")).toBeNull();
      const bubbles = [...rendered.container.querySelectorAll("[data-assistant-response]")];
      // Narration and answer: two bubbles, in order, under the summary (the narration still smoothing in here).
      expect(bubbles).toHaveLength(2);
      expect(bubbles[1]!.textContent).toContain("Il fait beau.");
      expect(after(summary, bubbles[0]!)).toBe(true);
      expect(after(bubbles.at(-1)!, row)).toBe(true);
      // Collapsed: no row left under the reply, the summary stays.
      await collapse();
      expect(row.isConnected).toBe(false);
      expect(rows(rendered.container)).toHaveLength(1);
      expect(rendered.container.querySelector("[data-run-collapsing]")).toBeNull();
      expect(rendered.container.querySelector("[data-run-head] [data-run-status='done']")).not.toBeNull();
    });

    test("le libellé suit l'outil en cours, tenu au moins 800 ms ; « En train d'écrire… » quand le texte arrive", async () => {
      const rendered = render(view([...tool(1, "web_search", "météo Rennes")]));
      expect(label(rendered.container)).toBe("Recherche : météo Rennes");
      rendered.rerender(view([...tool(1, "web_search", "météo Rennes", true), ...tool(2, "web_extract", "https://meteo.example.com/rennes?token=secret")]));
      // Held: the previous step stays readable.
      expect(label(rendered.container)).toBe("Recherche : météo Rennes");
      await act(async () => { await Bun.sleep(850); });
      expect(label(rendered.container)).toBe("Lecture : meteo.example.com");
      expect(rows(rendered.container)[0]!.textContent).not.toContain("secret");
      rendered.rerender(view([...tool(1, "web_search", "météo Rennes", true), ...tool(2, "web_extract", "https://meteo.example.com/rennes", true), say(3, "Il fait")]));
      await act(async () => { await Bun.sleep(850); });
      expect(label(rendered.container)).toBe("En train d’écrire…");
    });

    test("une réponse sans outil : ni nom ni résumé, la ligne se replie puis disparaît ; seule la gouttière sépare la bulle de la réponse", async () => {
      const rendered = render(view([say(1, "Quel test veux-tu effectuer ?")]));
      const row = rows(rendered.container)[0]!;
      expect(row.dataset.runStatus).toBe("working");
      // A 1:1 reply without work carries no name line, live or done.
      expect(rendered.container.querySelector("[data-run-head]")).toBeNull();
      rendered.rerender(view([say(1, "Quel test veux-tu effectuer ?")], "completed"));
      // The same node collapses (height and opacity), out of reach meanwhile.
      expect(rows(rendered.container)[0]).toBe(row);
      expect(row.dataset.runStatus).toBe("gone");
      expect(row.querySelector("[data-activity-summary]")).toBeNull();
      const closing = row.closest<HTMLElement>("[data-turn-activity]")!;
      expect(closing.hasAttribute("data-run-collapsing")).toBe(true);
      expect(closing.className).toContain("openedbot-run-status-collapse");
      expect(closing.getAttribute("aria-hidden")).toBe("true");
      await collapse();
      // Exactly the bubbles: the user's, then the reply, 12 px apart (the turn's `gap-3`).
      expect(row.isConnected).toBe(false);
      expect(rendered.container.querySelector("[data-run-status], [data-run-head], [data-run-author], [data-turn-activity]")).toBeNull();
      const turnRow = rendered.container.querySelector<HTMLElement>('[data-thread-turn="m1"]')!;
      expect(turnRow.className.split(" ")).toContain("gap-3");
      // (The fixture's undated message opens the reply's day with a chip; a real same-day turn has none.)
      const children = [...turnRow.children].filter((child) => !child.hasAttribute("data-thread-date"));
      expect(children).toHaveLength(2);
      expect(children[0]!.querySelector("[data-user-bubble]")).not.toBeNull();
      expect(children[1]!.querySelector("[data-assistant-response]")?.textContent).toContain("Quel test veux-tu effectuer ?");
      // The next bubble brings its own pending row.
      rendered.rerender(view([say(1, "Quel test veux-tu effectuer ?")], "completed", { outgoing: { id: "out-2", text: "Et toi ?" } }));
      const fresh = rows(rendered.container);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.dataset.runStatus).toBe("pending");
      expect(rendered.container.querySelector("[data-thread-outgoing]")!.contains(fresh[0]!)).toBe(true);
      expect(rendered.container.querySelector("[data-thread-outgoing] [data-run-head]")).toBeNull();
    });

    test("sous mouvement réduit, la ligne d'un run fini disparaît aussitôt, sans repli", () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      try {
        const rendered = render(view([say(1, "Ça va bien, merci.")]));
        expect(rows(rendered.container)[0]!.dataset.runStatus).toBe("working");
        rendered.rerender(view([say(1, "Ça va bien, merci.")], "completed"));
        expect(rendered.container.querySelector("[data-run-status], [data-run-collapsing]")).toBeNull();
        expect(rendered.container.querySelector(".openedbot-run-status-collapse")).toBeNull();
      } finally {
        window.matchMedia = original;
      }
    });

    test("sans nom (salon), le résumé d'un run avec outils s'ouvre au-dessus de la réponse à la fin, la ligne du bas se replie", async () => {
      const rendered = render(view([...tool(1, "terminal", undefined, true), say(2, "Fait.")], "running", { salon: true }));
      const row = rows(rendered.container)[0]!;
      expect(row.dataset.runStatus).toBe("working");
      expect(rendered.container.querySelector("[data-run-status='done']")).toBeNull();
      rendered.rerender(view([...tool(1, "terminal", undefined, true), say(2, "Fait.")], "completed", { salon: true }));
      const summary = rendered.container.querySelector<HTMLElement>("[data-run-status='done']")!;
      const head = summary.closest<HTMLElement>("[data-turn-activity]")!;
      expect(head.hasAttribute("data-run-reveal")).toBe(true);
      expect(after(head, rendered.container.querySelector("[data-assistant-response]")!)).toBe(true);
      expect(row.dataset.runStatus).toBe("gone");
      await collapse();
      expect(row.isConnected).toBe(false);
      expect([...rows(rendered.container)].map((node) => node.dataset.runStatus)).toEqual(["done"]);
    });

    test("un ancien tour sans outil n'a pas de ligne ; avec outils, « Nom  Réflexion : Ns » au-dessus de sa réponse", () => {
      const history = render(
        <QueryClientProvider client={client}><I18nProvider>
          <ThreadTimeline
            events={[
              { cursor: 1, sequence: 1, runId: "run-a", type: "agent.message", payload: { text: "Bonjour." }, occurredAt: at },
              { cursor: 2, sequence: 2, runId: "run-b", type: "tool.call", payload: { toolCallId: "tc-b", tool: "terminal" }, occurredAt: at },
              { cursor: 3, sequence: 3, runId: "run-b", type: "agent.message", payload: { text: "Fait." }, occurredAt: at },
            ]}
            runs={[run("run-a", "completed"), run("run-b", "completed")]}
            userInputs={[{ id: "m1", text: "Salut", runId: "run-a" }, { id: "m2", text: "Fais-le", runId: "run-b" }]}
            approvals={[]}
            running={false}
            speechAdapter={speechAdapter}
            defaultAuthor={author}
          />
        </I18nProvider></QueryClientProvider>,
      );
      // Never seen live here: no bottom row at all, nothing collapses.
      const all = [...rows(history.container)];
      expect(all).toHaveLength(1);
      expect(all[0]!.dataset.runStatus).toBe("done");
      expect(history.container.querySelector('[data-thread-turn="m1"] [data-run-status]')).toBeNull();
      // The summary is on the head line, after the bot's name, above the reply.
      const turnB = history.container.querySelector('[data-thread-turn="m2"]')!;
      const head = turnB.querySelector<HTMLElement>("[data-run-head]")!;
      expect(head.contains(all[0]!)).toBe(true);
      expect(head.querySelector("[data-tool-author]")?.textContent).toContain("Atlas");
      expect(after(head.querySelector("[data-tool-author]")!, all[0]!)).toBe(true);
      expect(after(all[0]!, turnB.querySelector("[data-assistant-response]")!)).toBe(true);
      expect(history.container.querySelector("[data-agent-feed]")).toBeNull();
      expect(history.container.querySelector("[data-run-reveal]")).toBeNull();
    });

    test("sans ligne d'auteur (salon), le résumé prend sa propre ligne au-dessus de la première bulle", () => {
      const { container } = renderTimeline({
        events: [
          { cursor: 1, sequence: 1, runId: "run-room", type: "tool.call", payload: { toolCallId: "tc-r", tool: "terminal" }, occurredAt: at },
          { cursor: 2, sequence: 2, runId: "run-room", type: "agent.message", payload: { text: "Fait." }, occurredAt: at },
        ],
        runs: [run("run-room", "completed")],
        userInputs: [{ id: "m1", text: "Fais-le", runId: "run-room" }],
      });
      const summary = container.querySelector<HTMLElement>("[data-run-status='done']")!;
      expect(summary).not.toBeNull();
      expect(summary.closest("[data-run-head]")).toBeNull();
      expect(container.querySelector("[data-tool-author]")).toBeNull();
      expect(after(summary, container.querySelector("[data-assistant-response]")!)).toBe(true);
    });

    test("une carte d'outil reste dans le fil, à la place de l'appel, sans déplacer la ligne d'état ni le résumé", async () => {
      const card = weatherCard();
      const weather = (sequence: number, cards: unknown) => [
        event(sequence, "tool.call", { toolCallId: `tc-${sequence}`, tool: "weather_forecast", preview: "Rennes" }),
        event(sequence + 0.5, "tool.result", { toolCallId: `tc-${sequence}`, tool: "weather_forecast", error: false, cards }),
      ];
      const live = [say(1, "Je regarde la météo de Rennes."), ...weather(2, [card])];
      const rendered = render(view(live));
      const block = rendered.container.querySelector<HTMLElement>("[data-run-cards]")!;
      expect(block).not.toBeNull();
      expect(block.className).toContain("not-prose");
      const narration = rendered.container.querySelector("[data-assistant-response]")!;
      const headLine = rendered.container.querySelector('[data-thread-turn="m1"] [data-run-head]')!;
      expect(after(headLine, block)).toBe(true);
      expect(after(narration, block)).toBe(true);
      // Live: still one status row, after the run's last entry.
      expect(rows(rendered.container)).toHaveLength(1);
      expect(after(block, rows(rendered.container)[0]!)).toBe(true);
      expect(lastOfTurn(rendered.container, rows(rendered.container)[0]!)).toBe(true);
      expect(await screen.findByRole("article", { name: "Météo à Rennes" })).toBeTruthy();

      rendered.rerender(view([...live, say(3, "Une semaine humide.")], "completed"));
      const answer = [...rendered.container.querySelectorAll("[data-assistant-response]")].at(-1)!;
      const summary = rendered.container.querySelector<HTMLElement>("[data-run-head] [data-run-status='done']")!;
      expect(summary).not.toBeNull();
      expect(after(summary, narration)).toBe(true);
      expect(after(rendered.container.querySelector("[data-run-cards]")!, answer)).toBe(true);
      expect(rendered.container.querySelectorAll("[data-run-cards]")).toHaveLength(1);
    });

    test("un résultat dont la carte est invalide, ou d'un genre inconnu, n'affiche aucune carte", () => {
      const invalid = { kind: "weather", weather: { ...weatherCard().weather, days: [] } };
      const { container } = render(view([
        event(1, "tool.call", { toolCallId: "tc-1", tool: "weather_forecast" }),
        event(1.5, "tool.result", { toolCallId: "tc-1", tool: "weather_forecast", error: false, cards: [invalid, { kind: "stocks" }] }),
        say(2, "Je n'ai pas pu lire la météo."),
      ], "completed"));
      expect(container.querySelector("[data-run-cards]")).toBeNull();
      expect(container.querySelector("[data-run-status='done']")).not.toBeNull();
    });

    test("les délégués rejoignent la ligne un à un, sans remonter ceux déjà là, puis « +N »", () => {
      const avatars = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-run-status] [data-stream-agent]")];
      const delegate = (sequence: number, preview: string) => tool(sequence, "delegate_task", preview);
      const rendered = render(view([...tool(1), ...delegate(2, "Cherch")]));
      const [lead, first] = avatars(rendered.container);
      expect(avatars(rendered.container).map((node) => node.dataset.streamAgent)).toEqual(["bot-1", "bot-1:delegate:1"]);
      rendered.rerender(view([...tool(1), ...delegate(2, "Chercheur web")]));
      expect(avatars(rendered.container)[0]).toBe(lead!);
      expect(avatars(rendered.container)[1]).toBe(first!);
      rendered.rerender(view([...tool(1), ...delegate(2, "Chercheur web"), ...delegate(3, "Rédacteur"), ...delegate(4, "Relecteur"), ...delegate(5, "Traducteur")]));
      const joined = avatars(rendered.container);
      expect(joined.map((node) => node.dataset.streamAgent)).toEqual(["bot-1", "bot-1:delegate:1", "bot-1:delegate:2", "bot-1:delegate:3", "overflow"]);
      expect(joined[0]).toBe(lead!);
      expect(joined[1]).toBe(first!);
      expect(joined.every((node) => node.classList.contains("stream-spring"))).toBe(true);
      expect(joined.at(-1)!.textContent).toBe("+1");
    });

    test("une décision en attente s'ouvre dans la ligne, jamais cachée", () => {
      const approval: ApprovalRequestDto = {
        id: "approval-1", runId: "run-live", threadId: "thread-1", botId: "bot-1", kind: "code", action: "execute_code",
        detail: null, choices: ["once"], status: "pending", requestedAt: at.toISOString(), respondedAt: null,
      };
      const { container } = render(view([
        ...tool(1, "execute_code", "print(1)"),
        event(2, "approval.requested", { approvalRequestId: "approval-1", action: "execute_code" }),
      ], "running", { approvals: [approval] }));
      expect(container.querySelector("[data-run-status]")?.getAttribute("data-run-status")).toBe("waiting");
      expect(label(container)).toBe("Attend votre décision…");
      expect(container.querySelector("[data-turn-activity] [data-open]")?.getAttribute("data-open")).toBe("true");
    });

    test("la ligne terminée ouvre le panneau « Réflexions », phrases comprises", () => {
      const { container } = render(
        <QueryClientProvider client={client}><I18nProvider><AttachmentCanvasProvider>
          <ThreadTimeline
            events={[...tool(1, "terminal", undefined, true), say(2, "Je vérifie."), ...tool(3, "terminal", undefined, true), say(4, "Voilà.")]}
            runs={[{ ...run("run-live", "completed"), createdAt: at.toISOString() }]}
            userInputs={[{ id: "m1", text: "Fais-le", runId: "run-live" }]}
            approvals={[]}
            running={false}
            speechAdapter={speechAdapter}
            defaultAuthor={author}
          />
          <AttachmentCanvas />
        </AttachmentCanvasProvider></I18nProvider></QueryClientProvider>,
      );
      fireEvent.click(container.querySelector<HTMLElement>("[data-run-status='done']")!);
      const panel = container.querySelector<HTMLElement>("[data-thoughts-panel]")!;
      expect(panel.dataset.runId).toBe("run-live");
      expect([...panel.querySelectorAll("[data-thoughts-row]")].map((node) => node.getAttribute("data-thoughts-row"))).toEqual(["tool", "msg", "tool"]);
      expect(panel.textContent).not.toContain("Voilà.");
    });
  });

  test("la réponse en direct lit le texte retenu hors du snapshot, et lui seul, sans doublon une fois patché", () => {
    const matchMedia = window.matchMedia;
    // Reduced motion: the text shows as-is, with no smoothing to wait for.
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const at = new Date("2026-10-24T10:00:00.000Z");
      const fragment = (sequence: number, text: string, runId = "run-live") =>
        ({ sequence, runId, type: "agent.message", payload: { text }, occurredAt: at }) as unknown as StoredProductEvent;
      const old = [fragment(1, "Ancienne réponse.", "run-old")];
      const committed = [...old, fragment(1, "a".repeat(LONG_TEXT_FIXTURE_SIZE + 1))];
      const store = createLiveRunText();
      for (const event of committed) store.record(event);
      store.record(fragment(2, " SUITE"));
      const runs = [run("run-old", "completed"), run("run-live", "running")];
      const view = renderTimeline({ events: committed, runs, running: true, liveText: { store, events: committed } });
      const answers = () => [...view.container.querySelectorAll("[data-assistant-response]")].map((node) => node.textContent ?? "");
      expect(answers().at(-1)).toContain(" SUITE");
      // A published fragment only goes through the live bubble.
      store.record(fragment(3, " ENCORE"));
      act(() => store.publish());
      expect(answers().at(-1)).toContain(" SUITE ENCORE");
      expect(answers()[0]).toContain("Ancienne réponse.");
      // The snapshot receives the fragments: the suffix releases them in the same render.
      const patched = [...committed, fragment(2, " SUITE"), fragment(3, " ENCORE")];
      view.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <I18nProvider>
            <ThreadTimeline events={patched} userInputs={[]} runs={runs} approvals={[]} running speechAdapter={speechAdapter} liveText={{ store, events: patched }} />
          </I18nProvider>
        </QueryClientProvider>,
      );
      expect(answers().at(-1)!.split("SUITE")).toHaveLength(2);
      expect(answers().at(-1)).toContain(" SUITE ENCORE");
      view.unmount();
      // A MEDIA: tag split across the snapshot and the suffix is never shown raw.
      const tagged = [fragment(1, `${"b".repeat(LONG_TEXT_FIXTURE_SIZE + 1)}\nMED`, "run-media")];
      // Thread opened mid-reply: the store did not see the start of the tag.
      const mediaStore = createLiveRunText();
      mediaStore.record(fragment(2, "IA:/workspace/x.png", "run-media"));
      const media = renderTimeline({ events: tagged, runs: [run("run-media", "running")], running: true, liveText: { store: mediaStore, events: tagged } });
      expect(media.container.querySelector("[data-assistant-response]")?.textContent).not.toContain("workspace");
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  test("place une question interactive historique au-dessus de sa réponse opérateur", () => {
    const { container } = renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-question",
        type: "agent.message",
        payload: {
          text: "@user Quelle priorité dois-je privilégier ?\n- Rapidité\n- Qualité\n- Économie",
        },
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
      }],
      userInputs: [{
        id: "message-answer",
        text: "Économie",
        runId: "run-answer",
        createdAt: "2026-09-03T00:00:01.000Z",
      }],
      runs: [run("run-question", "completed"), run("run-answer", "completed")],
    });

    const question = screen.getByText("Quelle priorité dois-je privilégier ?");
    const answer = screen.getByText("Économie");
    expect(question.parentElement?.hasAttribute("data-answered-question")).toBe(true);
    expect(question.parentElement?.className).toContain("self-end");
    expect(question.parentElement?.className).toContain("text-right");
    expect(question.parentElement?.parentElement).toBe(answer.closest<HTMLElement>("[data-message-id]"));
    expect(question.parentElement?.nextElementSibling?.contains(answer)).toBe(true);
    expect(container.querySelectorAll("[data-answered-question]")).toHaveLength(1);
  });

  test("un groupe ×2 dont un appel a réussi dit « 1 échec sur 2 », pas un ✗ global", () => {
    const at = new Date("2026-09-03T00:00:00.000Z");
    const { container } = renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-skill", type: "tool.call", payload: { toolCallId: "tc_0", tool: "skill_manage" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-skill", type: "tool.result", payload: { toolCallId: "tc_0", tool: "skill_manage", error: true, durationMs: 27, errorMessage: null }, occurredAt: at },
        { cursor: 3, sequence: 3, runId: "run-skill", type: "tool.call", payload: { toolCallId: "tc_1", tool: "skill_manage" }, occurredAt: at },
        { cursor: 4, sequence: 4, runId: "run-skill", type: "tool.result", payload: { toolCallId: "tc_1", tool: "skill_manage", error: false, durationMs: 40, errorMessage: null }, occurredAt: at },
      ],
      runs: [run("run-skill", "completed")],
    });

    expect(screen.getAllByText("1 échec sur 2").length).toBeGreaterThan(0);
    expect(container.querySelector("[data-tool-partial-failure]")).not.toBeNull();
    // With no error message forwarded by the runtime, the line is NOT a button.
    expect(container.querySelector("[data-tool-error-toggle]")).toBeNull();
  });

  test("un outil en échec s'ouvre d'office sur son erreur, le détail entier au clic", () => {
    const at = new Date("2026-09-03T00:00:00.000Z");
    const { container } = renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-fail", type: "tool.call", payload: { toolCallId: "tc_0", tool: "terminal" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-fail", type: "tool.result", payload: { toolCallId: "tc_0", tool: "terminal", error: true, durationMs: 5, errorMessage: "command not found: foo\nexit status 127" }, occurredAt: at },
      ],
      runs: [run("run-fail", "completed")],
    });

    // The Tool Result stays open on its error: the whole message reads in
    // its log without a click.
    const result =container.querySelector<HTMLElement>('[data-tool-result][data-state="failed"]');
    expect(result).not.toBeNull();
    expect(result!.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    expect(result!.querySelector("[data-tool-failure-reason]")?.textContent).toContain("command not found: foo");
    const errors = [...result!.querySelectorAll("[data-tool-error-inline]")].map((line) => line.textContent);
    expect(errors).toEqual(["command not found: foo", "exit status 127"]);
    // The header counts the failure on its one line; the raw error never
    // squeezes in after « Réflexion : Ns » (it reads in the log and the panel).
    const head = container.querySelector("[data-activity-head]");
    expect(head?.textContent).toContain("1 échec sur 1");
    expect(head?.textContent).not.toContain("command not found");

    fireEvent.click(result!.querySelector<HTMLElement>("[data-tool-inspect]")!);
    expect(screen.getByRole("dialog").textContent).toContain("exit status 127");
  });

  test("un seul échec connu : son compte dans l'en-tête du tour, sa raison dans le journal", () => {
    const at = new Date("2026-10-17T10:00:00.000Z");
    const { container } = renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-partial", type: "tool.call", payload: { toolCallId: "tc_0", tool: "terminal" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-partial", type: "tool.result", payload: { toolCallId: "tc_0", tool: "terminal", error: true, errorMessage: "permission denied" }, occurredAt: at },
        { cursor: 3, sequence: 3, runId: "run-partial", type: "tool.call", payload: { toolCallId: "tc_1", tool: "web_search" }, occurredAt: at },
        { cursor: 4, sequence: 4, runId: "run-partial", type: "tool.result", payload: { toolCallId: "tc_1", tool: "web_search", error: false }, occurredAt: at },
      ],
      runs: [run("run-partial", "completed")],
    });

    expect(container.querySelector("[data-activity-head]")?.textContent).toContain("1 échec sur 2");
    expect(container.querySelector("[data-activity-head]")?.textContent).not.toContain("permission denied");
    expect(container.querySelectorAll("[data-tool-failure-reason]").length).toBeGreaterThan(0);
  });

  test("le détail montre l'entrée, la sortie structurée, la durée et le temps d'approbation", () => {
    const at = new Date("2026-10-17T10:00:00.000Z");
    renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-code", type: "tool.call", payload: { toolCallId: "tc_0", tool: "execute_code", preview: "print(1)" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-code", type: "approval.requested", payload: { approvalRequestId: "approval-1", action: "execute_code" }, occurredAt: at },
        { cursor: 3, sequence: 3, runId: "run-code", type: "tool.result", payload: { toolCallId: "tc_0", tool: "execute_code", error: true, durationMs: 10000, errorMessage: null }, occurredAt: at },
        { cursor: 4, sequence: 4, runId: "run-code", type: "tool.result.attached", payload: {
          toolCallId: "tc_0",
          input: "from datetime import datetime\\nprint(datetime.now())",
          errorMessage: "Python is unavailable",
          result: '{"status":"error","output":"","exit_code":1}',
        }, occurredAt: at },
      ],
      approvals: [{
        id: "approval-1", runId: "run-code", threadId: "thread-1", botId: "bot-1", kind: "code", action: "execute_code",
        detail: null, choices: ["once"], status: "approved", requestedAt: "2026-10-17T10:00:00.000Z", respondedAt: "2026-10-17T10:00:09.900Z",
      }],
      runs: [run("run-code", "completed")],
    });

    const row = document.querySelector<HTMLElement>("[data-tool-activity] [data-tool-inspect]");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Python is unavailable");
    expect(dialog.textContent).toContain("Entrée");
    expect(dialog.querySelector('[data-code-block="python"]')).not.toBeNull();
    expect(dialog.textContent).toContain("Sortie");
    expect(dialog.textContent).toContain("Code de sortie 1");
    expect(dialog.textContent).toContain("10 s");
    expect(dialog.textContent).toContain("dont 9,9 s d’attente d’approbation");
  });

  test("le détail montre un bloc par appel replié et reconnaît l'absence d'information", () => {
    const at = new Date("2026-10-17T10:00:00.000Z");
    renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-two", type: "tool.call", payload: { toolCallId: "tc_0", tool: "terminal" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-two", type: "tool.result", payload: { toolCallId: "tc_0", tool: "terminal", error: false, durationMs: 2 }, occurredAt: at },
        { cursor: 3, sequence: 3, runId: "run-two", type: "tool.result.attached", payload: { toolCallId: "tc_0", input: "pwd", result: "/tmp" }, occurredAt: at },
        { cursor: 4, sequence: 4, runId: "run-two", type: "tool.call", payload: { toolCallId: "tc_1", tool: "terminal" }, occurredAt: at },
        { cursor: 5, sequence: 5, runId: "run-two", type: "tool.result", payload: { toolCallId: "tc_1", tool: "terminal", error: false, durationMs: 3 }, occurredAt: at },
        { cursor: 6, sequence: 6, runId: "run-two", type: "tool.result.attached", payload: { toolCallId: "tc_1", input: "ls", result: "file.txt" }, occurredAt: at },
      ],
      runs: [run("run-two", "completed")],
    });

    const row = document.querySelector<HTMLElement>("[data-tool-activity] [data-tool-inspect]");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(screen.getAllByText(/Appel [12] sur 2/)).toHaveLength(2);

    cleanup();
    renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-empty", type: "tool.call", payload: { toolCallId: "tc_0", tool: "terminal" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-empty", type: "tool.result", payload: { toolCallId: "tc_0", tool: "terminal", error: true, durationMs: 2, errorMessage: null }, occurredAt: at },
      ],
      runs: [run("run-empty", "completed")],
    });
    const emptyRow = document.querySelector<HTMLElement>("[data-tool-activity] [data-tool-inspect]");
    expect(emptyRow).not.toBeNull();
    fireEvent.click(emptyRow!);
    expect(screen.getByRole("dialog").textContent).toContain("Le runtime n’a transmis aucun détail.");
    expect(screen.getByRole("dialog").textContent).toContain("Les versions de Hermes antérieures au 15 septembre 2026");
  });

  test("le bouton des échecs ouvre le panneau capacités du bot", () => {
    const at = new Date("2026-10-17T10:00:00.000Z");
    let opened = false;
    renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-fail", type: "tool.call", payload: { toolCallId: "tc_0", tool: "terminal" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-fail", type: "tool.result", payload: { toolCallId: "tc_0", tool: "terminal", error: true, errorMessage: "command failed" }, occurredAt: at },
      ],
      runs: [run("run-fail", "completed")],
      defaultAuthor: { id: "bot-1", name: "Atlas", slug: "atlas", face: null },
      onOpenBotErrors: () => { opened = true; },
    });
    const row = document.querySelector<HTMLElement>("[data-tool-activity] [data-tool-inspect]");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    fireEvent.click(screen.getByRole("button", { name: "Voir les échecs du bot" }));
    expect(opened).toBe(true);
  });

  test("affiche le plan observé pendant que le run travaille", () => {
    renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-plan",
        type: "tool.result",
        payload: {
          toolCallId: "tc_1",
          tool: "todo",
          agentPlan: {
            steps: [
              { id: "prepare", content: "Préparer le contexte", status: "completed" },
              { id: "verify", content: "Vérifier l’identité", status: "in_progress" },
              { id: "summarize", content: "Résumer le contrôle", status: "pending" },
            ],
          },
        },
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
      }],
      runs: [run("run-plan", "running")],
      running: true,
    });

    // The block announces what is left to do, not its own name: two
    // steps open here, the one in progress and the one that follows.
    expect(screen.getByText("2 étapes restantes")).toBeTruthy();
    expect(screen.getByText("Vérifier l’identité")).toBeTruthy();
    expect(screen.queryByText("todo")).toBeNull();
  });

  test("affiche les recherches web relues dans le transcript, avec leurs sources", () => {
    renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-search",
        type: "tool.result",
        payload: {
          toolCallId: "tc_web",
          tool: "web_search",
          webSearch: {
            queries: [{
              id: "tc_web",
              query: "prix d’une bibliothèque de composants",
              sources: [
                { title: "Un fil Reddit", url: "https://www.reddit.com/r/webdev/x", domain: "reddit.com", description: null },
                { title: "Le registre shadcn", url: "https://github.com/shadcn/ui", domain: "github.com", description: null },
              ],
              resultCount: 2,
              error: null,
            }],
          },
        },
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
      }],
      runs: [run("run-search", "completed")],
    });

    // One feed row per query: the query, its result count, then its results
    // (title and domain), each a link that opens outside the console.
    const query = screen.getByText("prix d’une bibliothèque de composants");
    const row = query.closest<HTMLElement>('[data-activity-row="search"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute("role")).toBe("listitem");
    expect(row!.textContent).toContain("2 résultats");
    const links = [...row!.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.textContent)).toEqual([
      "Un fil Redditreddit.com",
      "Le registre shadcngithub.com",
    ]);
    expect(links[1]!.getAttribute("href")).toBe("https://github.com/shadcn/ui");
    expect(links[1]!.getAttribute("target")).toBe("_blank");
    expect(links[1]!.getAttribute("rel")).toContain("noopener");
  });

  // Lab, 2026-10-25: the query sat on a row of its own above a « Recherche
  // sur le web » card that no longer said what it searched.
  test("un appel web_search porte sa requête et ses sources dans sa carte, sans ligne à part", () => {
    const { container } = renderTimeline({
      events: [
        {
          cursor: 1,
          sequence: 1,
          runId: "run-search",
          type: "tool.call",
          payload: { toolCallId: "tc_0", tool: "web_search", preview: "météo Lille demain" },
          occurredAt: new Date("2026-09-03T00:00:00.000Z"),
        },
        {
          cursor: 2,
          sequence: 2,
          runId: "run-search",
          type: "tool.result",
          payload: {
            toolCallId: "tc_0",
            tool: "web_search",
            durationMs: 2574,
            webSearch: {
              queries: [{
                id: "toolu_01",
                query: "météo Lille demain",
                sources: [{ title: "Météo Lille", url: "https://meteo.example.com/lille", domain: "meteo.example.com", description: null }],
                resultCount: 1,
                error: null,
              }],
            },
          },
          occurredAt: new Date("2026-09-03T00:00:02.574Z"),
        },
      ],
      runs: [run("run-search", "completed")],
    });

    expect(container.querySelector('[data-activity-row="search"]')).toBeNull();
    const card = container.querySelector<HTMLElement>("[data-tool-result]")!;
    expect(card.querySelector("[data-tool-meta]")?.textContent).toContain("météo Lille demain · 2,6 s");
    fireEvent.click(card.querySelector("button")!);
    const link = card.querySelector<HTMLAnchorElement>("[data-tool-search] a")!;
    expect(link.getAttribute("href")).toBe("https://meteo.example.com/lille");
    expect(card.querySelector("[data-tool-result-log]")).toBeNull();
  });

  test("une recherche aux nombreuses sources en montre trois, puis « +N autres », et ne lie jamais un schéma douteux", () => {
    const source = (index: number, url = `https://example.com/${index}`) => ({
      title: `Source ${index}`, url, domain: "example.com", description: null,
    });
    renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-search",
        type: "tool.result",
        payload: {
          toolCallId: "tc_web",
          tool: "web_search",
          webSearch: {
            queries: [{
              id: "tc_web",
              query: "acme",
              sources: [source(1, "javascript:alert(1)"), source(2), source(3), source(4), source(5)],
              resultCount: null,
              error: null,
            }],
          },
        },
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
      }],
      runs: [run("run-search", "completed")],
    });

    const row = screen.getByText("acme").closest<HTMLElement>('[data-activity-row="search"]')!;
    expect(row.textContent).toContain("Source 1");
    expect(row.textContent).toContain("Source 3");
    expect(row.textContent).not.toContain("Source 4");
    expect(row.textContent).toContain("+2 autres");
    expect([...row.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/2",
      "https://example.com/3",
    ]);
  });

  // A finished trace is a path already walked: unfolded, three queries and their
  // sources pushed the reply off screen.
  test("la trace de recherche reste repliée sous la ligne d'état, pendant et après le tour", () => {
    const trace = (runId: string) => ({
      cursor: 1,
      sequence: 1,
      runId,
      type: "tool.result" as const,
      payload: {
        toolCallId: "tc_web",
        tool: "web_search",
        webSearch: {
          queries: [{ id: "tc_web", query: "météo Lille", sources: [], resultCount: 5, error: null }],
        },
      },
      occurredAt: new Date("2026-09-03T00:00:00.000Z"),
    });

    const conclu = renderTimeline({ events: [trace("run-done")], runs: [run("run-done", "completed")] });
    const teteConclue = conclu.container.querySelector("[data-activity-head]");
    expect(teteConclue?.getAttribute("aria-expanded")).toBe("false");
    cleanup();

    // While in progress, the row says the run works; the trace stays folded in its log.
    const enCours = renderTimeline({
      events: [trace("run-live")],
      runs: [run("run-live", "running")],
      running: true,
    });
    expect(enCours.container.querySelector("[data-turn-activity][data-live] [data-run-status='working']")).not.toBeNull();
    expect(enCours.container.querySelector("[data-turn-activity] [data-open='false'] [data-activity-row='search']")?.textContent).toContain("météo Lille");
  });

  // The turn opened on an orphan block: « N recherches sur le web » sat
  // above the bot's name, because the trace inserts BEFORE the
  // tool log and only `tools` and `assistant` carried the label.
  test("le nom du bot ouvre le tour, au-dessus de la trace de recherche", () => {
    const { container } = renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "run-search",
        type: "tool.result",
        payload: {
          toolCallId: "tc_web",
          tool: "web_search",
          webSearch: {
            queries: [{ id: "tc_web", query: "météo Lille aujourd’hui", sources: [], resultCount: 5, error: null }],
          },
        },
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
      }],
      runs: [run("run-search", "completed")],
      defaultAuthor: { id: "bot-1", name: "First bot prod", slug: "first-bot-prod", face: null },
    });

    const entete = container.querySelector("[data-turn-of='bot-1']");
    expect(entete).toBeTruthy();
    // The name opens the head line, the summary follows it, the trace folds under both.
    const nom = entete!.querySelector("[data-run-head] [data-tool-author]")!;
    expect(nom.textContent).toContain("First bot prod");
    const trace = entete!.querySelector("[data-activity-row='search']")!;
    expect(trace.textContent).toContain("météo Lille aujourd’hui");
    expect(nom.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Measured in a real thread: the hidden copy/edit row sat in flow under every
  // sent message and reserved 34 px. It is now an overlay beside the bubble.
  test("the user's hidden actions take no layout space and show on hover or focus", () => {
    const { container } = renderTimeline({
      userInputs: [
        { id: "message-1", text: "et au havre ?", runId: "run-1", createdAt: "2026-09-03T00:00:00.000Z" },
        { id: "message-2", text: "test", runId: "run-1", createdAt: "2026-09-03T00:00:01.000Z" },
      ],
      runs: [run("run-1", "completed")],
    });
    const rows = [...container.querySelectorAll<HTMLElement>("[data-user-bubble-row]")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const actions = row.querySelector<HTMLElement>("[data-user-turn-actions]")!;
      // The row's only in-flow child is the bubble: its height is the bubble's.
      expect(row.className).toContain("relative");
      expect(actions.className.split(" ")).toContain("absolute");
      expect([...row.children].filter((child) => !child.className.split(" ").includes("absolute")))
        .toEqual([row.querySelector("[data-user-bubble]")!]);
      // Hidden and inert until the pointer is on the message or focus is inside.
      expect(actions.className.split(" ")).toEqual(expect.arrayContaining([
        "opacity-0", "pointer-events-none",
        "group-hover/message:opacity-100", "group-hover/message:pointer-events-auto",
        "focus-within:opacity-100", "focus-within:pointer-events-auto",
      ]));
      expect(actions.closest(".group\\/message")).not.toBeNull();
      const copy = actions.querySelector<HTMLButtonElement>('button[aria-label="Copier"]')!;
      copy.focus();
      expect(document.activeElement).toBe(copy);
    }
  });

  test("a superseded run reserves no status or author slot while its replacement runs", () => {
    const { container } = renderTimeline({
      userInputs: [
        { id: "message-1", text: "et au havre ?", runId: "old-run", createdAt: "2026-09-11T00:00:00.000Z" },
        { id: "message-2", text: "test", runId: "new-run", createdAt: "2026-09-11T00:00:02.000Z" },
      ],
      runs: [run("old-run", "cancelled", "superseded_by_followup"), run("new-run", "running")],
      running: true,
      defaultAuthor: { id: "bot-1", name: "Atlas", slug: "atlas", face: null },
    });
    const replacedTurn = container.querySelector<HTMLElement>('[data-thread-turn="message-1"]')!;
    expect(replacedTurn.querySelector("[data-user-bubble]")?.textContent).toBe("et au havre ?");
    expect(replacedTurn.querySelector("[data-run-status], [data-run-head], [data-turn-of], [data-turn-activity]")).toBeNull();
    expect(container.querySelector('[data-run-id="old-run"]')).toBeNull();
  });

  test("la bulle de l'utilisateur n'affiche aucune infobulle d'heure au survol", () => {
    const { container } = renderTimeline({
      userInputs: [{ id: "message-1", text: "Bonjour", runId: "run-1", createdAt: "2026-09-03T00:00:00.000Z" }],
      runs: [run("run-1", "completed")],
    });

    const bubble = container.querySelector<HTMLElement>("[data-user-bubble]");
    expect(bubble?.textContent).toContain("Bonjour");
    expect(bubble?.closest("[title]")).toBeNull();
  });

  test("explique qu'un message steeré a été absorbé par la réponse en cours", () => {
    renderTimeline({
      userInputs: [{ id: "message-1", text: "Ajoute ce point", runId: "steered-run" }],
      runs: [run("steered-run", "cancelled", "steered_into_active")],
    });

    expect(screen.getByText("Pris en compte dans la réponse en cours")).toBeTruthy();
    expect(screen.queryByText("Annulé")).toBeNull();
  });

  test("le statut du run vit dans le tour (Thinking), plus au-dessus du composer", () => {
    renderTimeline({
      events: [{
        cursor: 1,
        sequence: 1,
        runId: "executing-run",
        type: "tool.call",
        payload: { tool: "search" },
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
      }],
      userInputs: [{ id: "message-2", text: "Puis fais ceci", runId: "queued-run" }],
      runs: [run("executing-run", "running"), run("queued-run", "queued")],
      running: true,
    });

    expect(screen.queryByText("En attente…")).toBeNull();
    // The live turn carries its status row itself, once.
    expect(document.querySelectorAll("[data-turn-activity][data-live] [data-run-status='working']")).toHaveLength(1);
  });

  // Writing while the bot replies: the second message is ABSORBED by the run
  // in progress (steering). It therefore belongs to the active turn and reads under the
  // first message, with its « Pris en compte… » mention. The activity, then the
  // reply, come under both: otherwise the message just sent
  // was overtaken by text that appeared above it.
  // Burst: the first run was REPLACED by the next message (the reference app policy). Its message stays, with no error bubble and no marker; the
  // single reply comes under the second message.
  test("un run remplacé par le message suivant ne rend ni erreur ni repère", () => {
    const { container } = renderTimeline({
      events: [
        {
          cursor: 1, sequence: 1, runId: "old-run", type: "system.notice",
          payload: { kind: "superseded", message: "Remplacé par le message suivant." },
          occurredAt: new Date("2026-09-11T00:00:03.000Z"),
        },
        {
          cursor: 2, sequence: 1, runId: "new-run", type: "agent.message",
          payload: { text: "Tokyo pour le Japon, Mexico pour le Mexique." },
          occurredAt: new Date("2026-09-11T00:00:09.000Z"),
        },
      ],
      userInputs: [
        { id: "message-1", text: "capitale du Japon ?", runId: "old-run", createdAt: "2026-09-11T00:00:00.000Z" },
        { id: "message-2", text: "capitale du Mexique ?", runId: "new-run", createdAt: "2026-09-11T00:00:02.000Z" },
      ],
      runs: [run("old-run", "cancelled", "superseded_by_followup"), run("new-run", "completed")],
      running: false,
    });
    expect(screen.queryByText("Remplacé par le message suivant.")).toBeNull();
    expect(screen.getByText("capitale du Japon ?")).toBeTruthy();
    expect(screen.getByText("Tokyo pour le Japon, Mexico pour le Mexique.")).toBeTruthy();
    // The replaced turn keeps its bubble alone: no status, author or activity
    // slot reserves height under it, live or settled.
    const replacedTurn = container.querySelector<HTMLElement>('[data-thread-turn="message-1"]')!;
    expect(replacedTurn.querySelector("[data-run-status], [data-run-head], [data-turn-of], [data-turn-activity]")).toBeNull();
    expect(container.querySelector('[data-run-id="old-run"]')).toBeNull();
    expect(container.querySelector(".bg-destructive")).toBeNull();
  });

  // Merged replay: two steers never read become ONE run (the oldest
  // fold takes its rank back), the second folds into it and reads as absorbed.
  test("un repli replié dans le run de rejeu se lit comme pris en compte", () => {
    renderTimeline({
      userInputs: [
        { id: "message-1", text: "Première question", runId: "done-run", createdAt: "2026-09-11T00:00:00.000Z" },
        { id: "message-2", text: "message 8", runId: "lead-run", createdAt: "2026-09-11T00:00:05.000Z" },
        { id: "message-3", text: "message 9", runId: "folded-run", createdAt: "2026-09-11T00:00:06.000Z" },
      ],
      runs: [
        run("done-run", "completed"),
        run("lead-run", "running"),
        run("folded-run", "cancelled", "folded_into_followup"),
      ],
      running: true,
    });
    expect(screen.getByText("Pris en compte dans la réponse en cours")).toBeTruthy();
  });

  test("un message absorbé par la réponse en cours reste collé au message précédent", () => {
    const { container } = renderTimeline({
      userInputs: [
        { id: "message-1", text: "Première question", runId: "active-run", createdAt: "2026-09-03T00:00:00.000Z" },
        { id: "message-2", text: "Deuxième question", runId: "steered-run", createdAt: "2026-09-03T00:00:05.000Z" },
      ],
      runs: [run("active-run", "running"), run("steered-run", "cancelled", "steered_into_active")],
      running: true,
    });

    const ordre = (texte: string) => {
      const noeud = [...container.querySelectorAll("*")].find(
        (element) => element.children.length === 0 && element.textContent?.trim() === texte,
      );
      if (!noeud) throw new Error(`introuvable dans le fil : ${texte}`);
      return [...container.querySelectorAll("*")].indexOf(noeud);
    };
    expect(ordre("Première question")).toBeLessThan(ordre("Deuxième question"));
    expect(ordre("Deuxième question")).toBeLessThan(ordre("Pris en compte dans la réponse en cours"));
  });

  // The absorbing run has already worked: the absorbed message stays anyway
  // under the question that opened the turn, so above the tools and the
  // reply that answer both.
  test("un message absorbé passe au-dessus de la machinerie du tour actif", () => {
    const { container } = renderTimeline({
      events: [
        {
          cursor: 1,
          sequence: 1,
          runId: "active-run",
          type: "tool.call",
          payload: { tool: "web_search" },
          occurredAt: new Date("2026-09-03T00:00:03.000Z"),
        },
        {
          cursor: 2,
          sequence: 2,
          runId: "active-run",
          type: "agent.message",
          payload: { text: "Réponse aux deux" },
          occurredAt: new Date("2026-09-03T00:00:09.000Z"),
        },
      ],
      userInputs: [
        { id: "message-1", text: "Première question", runId: "active-run", createdAt: "2026-09-03T00:00:00.000Z" },
        { id: "message-2", text: "Deuxième question", runId: "steered-run", createdAt: "2026-09-03T00:00:05.000Z" },
      ],
      runs: [run("active-run", "completed"), run("steered-run", "cancelled", "steered_into_active")],
      running: false,
    });
    // The absorbing run has rendered: nothing is « en cours » anymore. The label
    // stayed in the present forever, under every absorbed message.
    expect(screen.queryByText("Pris en compte dans la réponse en cours")).toBeNull();
    expect(screen.getByText("Pris en compte dans la réponse")).toBeTruthy();

    const ordre = (texte: string) => {
      const noeud = [...container.querySelectorAll("*")].find(
        (element) => element.children.length === 0 && element.textContent?.trim() === texte,
      );
      if (!noeud) throw new Error(`introuvable dans le fil : ${texte}`);
      return [...container.querySelectorAll("*")].indexOf(noeud);
    };
    expect(ordre("Première question")).toBeLessThan(ordre("Deuxième question"));
    expect(ordre("Deuxième question")).toBeLessThan(ordre("Réponse aux deux"));
  });
});


describe("Routine answers", () => {
  test("hides only the internal routine input and labels its answer", () => {
    const at = "2026-11-09T11:35:00.000Z";
    const { container } = renderTimeline({
      runs: [{ id: "routine-run", status: "completed", routineId: "routine-1", createdAt: at }],
      userInputs: [
        { id: "routine-input", runId: "routine-run", text: "PRIVATE SCHEDULER INSTRUCTION", createdAt: at },
        { id: "real-input", runId: null, text: "[Routine] This is a real operator message", createdAt: at },
      ],
      events: [{ cursor: 1, sequence: 1, runId: "routine-run", type: "agent.message", payload: { text: "Scheduled answer" }, occurredAt: new Date(at) }],
    });
    expect(screen.queryByText("PRIVATE SCHEDULER INSTRUCTION")).toBeNull();
    expect(screen.getByText("[Routine] This is a real operator message")).toBeTruthy();
    const stamp = container.querySelector("[data-routine-stamp]");
    expect(stamp?.textContent).toContain("Routine");
    expect(stamp?.querySelector("time")?.dateTime).toBe(at);
    const answer = screen.getByText("Scheduled answer");
    expect(stamp?.getAttribute("role")).toBe("separator");
    expect(stamp && (stamp.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    expect(answer.closest("[data-assistant-response]")?.contains(stamp!)).toBe(false);
    expect(container.querySelectorAll("[data-routine-stamp]")).toHaveLength(1);
  });

  test("does not label a normal reply whose input mentions a routine", () => {
    const at = "2026-11-09T11:35:00.000Z";
    const { container } = renderTimeline({
      runs: [{ id: "normal", status: "completed" }],
      userInputs: [{ id: "request", runId: "normal", text: "Create a routine", createdAt: at }],
      events: [{ cursor: 1, sequence: 1, runId: "normal", type: "agent.message", payload: { text: "Routine created" }, occurredAt: new Date(at) }],
    });
    expect(screen.getByText("Create a routine")).toBeTruthy();
    expect(container.querySelector("[data-routine-stamp]")).toBeNull();
  });
});
