import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalRequestDto, RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { I18nProvider } from "../../src/lib/i18n";
import type { SpeechSynthesisAdapter } from "../../src/lib/voice/web-speech-synthesis";
import { ThreadTimeline } from "../../src/components/thread-timeline";

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
}: {
  events?: StoredProductEvent[];
  userInputs?: Array<{
    id: string;
    text: string;
    runId: string | null;
    authorBot?: null;
    createdAt?: string;
  }>;
  runs?: ReadonlyArray<Pick<RunDto, "id" | "status" | "completionKind" | "stepKind">>;
  running?: boolean;
  defaultAuthor?: { id: string; name: string; slug: string; face: null } | null;
  scrollToBottomOnThreadKey?: string | null;
  approvals?: ApprovalRequestDto[];
  onOpenBotErrors?: () => void;
  outgoing?: { id: string; text: string; failed?: boolean } | null;
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
  test("reveals local turns before fetching history and preserves the anchor when older turns arrive", async () => {
    const inputs = Array.from({ length: 50 }, (_, index) => ({ id: `history-${index}`, runId: null,
      text: `Question historique ${index}`, createdAt: new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString() }));
    let requests = 0;
    let captureHeight: (() => void) | undefined;
    let resolvePage!: (loaded: boolean) => void;
    const onLoadOlder = (capture?: () => void) => {
      requests += 1;
      captureHeight = capture;
      return new Promise<boolean>((resolve) => { resolvePage = resolve; });
    };
    const view = (userInputs: typeof inputs, loadingOlder = false, hasOlderHistory = true) => (
      <I18nProvider><ThreadTimeline events={[]} userInputs={userInputs} approvals={[]} running={false}
        speechAdapter={speechAdapter} speechScope="history" hasOlderHistory={hasOlderHistory}
        loadingOlder={loadingOlder} onLoadOlder={onLoadOlder} /></I18nProvider>
    );
    const rendered = render(view(inputs));
    const node = rendered.container.querySelector<HTMLElement>('[role="log"]')!;
    Object.defineProperty(node, "scrollHeight", { configurable: true,
      get: () => rendered.container.querySelectorAll('[data-thread-find-target^="message:history-"]').length * 20 });
    Object.defineProperty(node, "clientHeight", { configurable: true, value: 100 });
    expect(screen.queryByText("Question historique 0")).toBeNull();
    // The first paint mounts a few turns; the live window follows when idle.
    fireEvent.click(await screen.findByRole("button", { name: "Charger 10 tours plus anciens" }));
    expect(screen.getByText("Question historique 0")).toBeTruthy();
    expect(requests).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Charger 30 tours plus anciens" }));
    expect(requests).toBe(1);
    rendered.rerender(view(inputs, true));
    expect(screen.getByRole("button", { name: "Chargement des tours plus anciens…" }).hasAttribute("disabled")).toBe(true);
    node.scrollTop = 120;
    const older = Array.from({ length: 4 }, (_, index) => ({ id: `history-old-${index}`, runId: null,
      text: `Ancienne question ${index}`, createdAt: new Date(Date.UTC(2026, 9, 4, 0, 0, index)).toISOString() }));
    await act(async () => {
      captureHeight?.();
      rendered.rerender(view([...older, ...inputs], false, false));
      resolvePage(true);
    });
    await waitFor(() => expect(screen.getByText("Ancienne question 0")).toBeTruthy());
    expect(screen.getByText("Question historique 0")).toBeTruthy();
    expect(node.scrollTop).toBe(200);
    expect(screen.queryByRole("button", { name: /Charger .* tours plus anciens/ })).toBeNull();
  });

  test("a history error remains visible with a retry control", () => {
    render(<I18nProvider><ThreadTimeline events={[]} userInputs={[]} approvals={[]} running={false}
      speechAdapter={speechAdapter} hasOlderHistory olderError onLoadOlder={async () => false} /></I18nProvider>);
    expect(screen.getByRole("alert").textContent).toContain("Impossible de charger les tours plus anciens");
    expect(screen.getByRole("button", { name: "Charger 30 tours plus anciens" }).hasAttribute("disabled")).toBe(false);
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
    // Under the bubble, in its box: one push of the thread, not a second one when the run is acknowledged.
    const box = sent.container.querySelector("[data-thread-outgoing]");
    expect(box?.querySelector("[data-user-bubble]")).not.toBeNull();
    expect(box?.lastElementChild?.hasAttribute("data-thread-thinking")).toBe(true);
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
    let callback: ResizeObserverCallback | null = null;
    const observed: Element[] = [];
    const frames: FrameRequestCallback[] = [];
    class FakeResizeObserver {
      constructor(next: ResizeObserverCallback) {
        callback = next;
      }
      observe(target: Element) {
        observed.push(target);
      }
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
      expect(observed).toEqual([content]);
      frames.splice(0).forEach((frame) => frame(0));
      expect(callback).not.toBeNull();

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

  test("reste au bas quand la fenêtre idle passe de 8 à 40 tours", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalRequestIdleCallback = window.requestIdleCallback;
    const originalCancelIdleCallback = window.cancelIdleCallback;
    const frames: FrameRequestCallback[] = [];
    let idleCallback: IdleRequestCallback | null = null;
    const restoreScrollMetrics = mockThreadScrollMetrics(
      () => document.querySelectorAll('[data-thread-find-target^="message:long-"]').length * 100,
      200,
      true,
    );
    globalThis.requestAnimationFrame = ((next: FrameRequestCallback) => {
      frames.push(next);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    window.requestIdleCallback = ((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 1;
    }) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = (() => {}) as typeof window.cancelIdleCallback;

    try {
      const userInputs = Array.from({ length: 50 }, (_, index) => ({
        id: `long-${index}`,
        runId: null,
        text: `Question ${index}`,
        createdAt: new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString(),
      }));
      const rendered = renderTimeline({ userInputs, scrollToBottomOnThreadKey: "thread-long" });
      const scroller = rendered.container.querySelector<HTMLElement>('[role="log"]');
      if (!scroller) throw new Error("ThreadTimeline test scroller is missing");
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
      act(() => frames.splice(0).forEach((frame) => frame(0)));

      expect(idleCallback).not.toBeNull();
      act(() => idleCallback?.({ didTimeout: false, timeRemaining: () => 50 }));
      act(() => frames.splice(0).forEach((frame) => frame(0)));

      expect(rendered.container.querySelectorAll('[data-thread-find-target^="message:long-"]')).toHaveLength(40);
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
    } finally {
      cleanup();
      restoreScrollMetrics();
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      window.requestIdleCallback = originalRequestIdleCallback;
      window.cancelIdleCallback = originalCancelIdleCallback;
    }
  });

  // `memory` reste dans l'union des `stepKind` pour les runs D'AVANT le 07-09,
  // qui vivent encore en base : leur sortie ne doit toujours pas faire bulle.
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

  test("la réponse dans la bulle de Grok Bot : sans signature ni durée affichée", () => {
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
    // Plus de signature sous la bulle : le fil d'un DM n'a qu'un locuteur.
    expect(turn?.querySelector("[data-assistant-author]")).toBeNull();
    expect(response?.querySelector('[data-assistant-layout="grok"] .prose')).not.toBeNull();
    expect([...(response?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "1.25s")).toBe(false);
    // Aucune infobulle native d'heure ni de durée au survol du tour : seuls
    // les boutons de la rangée d'actions nomment leur geste.
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
    // La bulle de Grok Bot : une seule surface, au plus 560 px, dont le voile
    // vient de la feuille de style (aucune classe `bg-`).
    expect(surface?.getAttribute("data-assistant-layout")).toBe("grok");
    expect(surface?.className).toContain("max-w-[min(80%,560px,calc(100%-82px))]");
    expect(surface?.className).not.toContain("bg-");
    expect(surface?.closest("article")?.className).toContain("w-full");
    expect(container.querySelectorAll("[data-assistant-layout]").length).toBe(1);
    expect(container.querySelector("[data-assistant-card]")).toBeNull();
    // L'arborescence est un bloc, pas cinq paragraphes ni trois cartes.
    expect(container.querySelector("[data-path-listing]")?.textContent).toBe("src/\nShared/\nDomain/\nApplication/\nInfrastructure/");
    expect(container.querySelector("aside")?.textContent).toContain("En résumé");
    // Comme grok.com, la rangée d'actions vit sous la réponse finie ; la
    // surface garde le focus pour la touche Menu.
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
    expect(surface?.getAttribute("data-assistant-layout")).toBe("grok");
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

    const turn = container.querySelector<HTMLElement>('[data-turn-of="bot-1"]');
    const author = turn?.querySelector<HTMLElement>("[data-tool-author]");
    const response = turn?.querySelector<HTMLElement>("[data-tool-response]");
    const activity = response?.querySelector<HTMLElement>("[data-tool-activity]");
    expect(turn?.className).toContain("flex-col");
    expect(author?.parentElement).toBe(turn);
    expect(response?.parentElement).toBe(turn);
    expect(response?.className).toContain("w-full");
    expect(activity?.className).toContain("max-w-full");
    // Le journal d'outils n'est plus une bulle : il se lit comme un arbre,
    // à plat sur l'axe de la réponse. Ce qui compte reste qu'il commence à
    // la même verticale que le visage, sans retrait.
    expect(activity?.className).toContain("self-start");
    expect(activity?.className).not.toContain("ml-8");
  });

  test("un tour entrecoupé de narration ne rend qu'un seul résumé d'outils", () => {
    const at = new Date("2026-09-03T00:00:00.000Z");
    const { container } = renderTimeline({
      events: [
        { cursor: 1, sequence: 1, runId: "run-activity", type: "tool.call", payload: { toolCallId: "tc-1", tool: "terminal" }, occurredAt: at },
        { cursor: 2, sequence: 2, runId: "run-activity", type: "agent.message", payload: { text: "Je vérifie." }, occurredAt: at },
        { cursor: 3, sequence: 3, runId: "run-activity", type: "tool.call", payload: { toolCallId: "tc-2", tool: "terminal" }, occurredAt: at },
      ],
      runs: [run("run-activity", "completed")],
    });

    // One header for the whole turn, grok's « Réflexion » line; the Tool
    // Result rows inside the log never repeat it.
    const heads = container.querySelectorAll("[data-turn-activity] > [data-activity-head]");
    expect(heads).toHaveLength(1);
    expect(heads[0]!.textContent).toContain("Réflexion");
    // The sentence between the two calls is a « thinking » row of the feed,
    // between the two Tool Result rows, in the runtime's order.
    const rows = [...container.querySelectorAll("[data-turn-activity] [data-activity-row]")]
      .map((row) => row.getAttribute("data-activity-row"));
    expect(rows).toEqual(["tool", "thinking", "tool"]);
  });

  test("une première phrase en direct reste dans l'activité : elle ne commence pas la réponse avant l'outil", () => {
    const at = new Date("2026-10-24T10:00:00.000Z");
    const sentence = { cursor: 1, sequence: 1, runId: "run-live", type: "agent.message" as const, payload: { text: "Je cherche d'abord le test." }, occurredAt: at };
    const live = renderTimeline({ events: [sentence], runs: [run("run-live", "running")], running: true });
    // Rien n'a encore dit si un outil suit : la phrase attend dans le bloc de travail.
    expect(live.container.querySelector("[data-turn-activity] [data-activity-narration]")?.textContent).toContain("Je cherche d'abord le test.");
    expect(live.container.querySelector("[data-assistant-response]")).toBeNull();
    live.unmount();

    // L'outil arrive : la phrase est déjà à sa place, rien ne saute.
    const withTool = renderTimeline({
      events: [sentence, { cursor: 2, sequence: 2, runId: "run-live", type: "tool.call", payload: { toolCallId: "tc-1", tool: "terminal" }, occurredAt: at }],
      runs: [run("run-live", "running")],
      running: true,
    });
    const rows = [...withTool.container.querySelectorAll("[data-turn-activity] [data-activity-row]")].map((row) => row.getAttribute("data-activity-row"));
    expect(rows).toEqual(["thinking", "tool"]);
    expect(withTool.container.querySelector("[data-assistant-response]")).toBeNull();
    withTool.unmount();

    // Sans outil, le run conclu fait de cette phrase la réponse.
    const done = renderTimeline({ events: [sentence], runs: [run("run-live", "completed")] });
    expect(done.container.querySelector("[data-turn-activity]")).toBeNull();
    expect(done.container.querySelector("[data-assistant-response]")?.textContent).toContain("Je cherche d'abord le test.");
  });

  test("une réponse en direct qui a déjà la forme d'un document s'écrit à sa place de réponse", () => {
    const at = new Date("2026-10-24T10:00:00.000Z");
    const { container } = renderTimeline({
      events: [{ cursor: 1, sequence: 1, runId: "run-live", type: "agent.message", payload: { text: "Voici le plan.\n\n1. Lire le test" }, occurredAt: at }],
      runs: [run("run-live", "running")],
      running: true,
    });
    expect(container.querySelector("[data-turn-activity]")).toBeNull();
    // Its text then smooths in from empty (`useSmoothText`): its PLACE is what counts here.
    expect(container.querySelector("[data-assistant-response]")).not.toBeNull();
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
    // Sans message d'erreur transmis par le runtime, la ligne n'est PAS un bouton.
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

    // Le bloc annonce ce qu'il reste à faire, pas son propre nom : deux
    // étapes ouvertes ici, celle en cours et celle qui suit.
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

  // Une trace conclue est un chemin parcouru : dépliée, trois requêtes et leurs
  // sources repoussaient la réponse hors de l'écran.
  test("la trace de recherche se replie quand le tour est conclu, et roule dans le flux pendant", () => {
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

    // En cours, la recherche roule dans le flux de grok.com, sous l'en-tête.
    const enCours = renderTimeline({
      events: [trace("run-live")],
      runs: [run("run-live", "running")],
      running: true,
    });
    expect(enCours.container.querySelector("[data-turn-activity][data-thinking]")).not.toBeNull();
    expect(enCours.container.querySelector('[data-agent-feed-item] [data-feed-row="search"]')?.textContent).toContain("météo Lille");
  });

  // Le tour s'ouvrait sur un bloc orphelin : « N recherches sur le web » se
  // posait au-dessus du nom du bot, parce que la trace s'insère AVANT le
  // journal d'outils et que seuls `tools` et `assistant` portaient le libellé.
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
    // Le libellé est DANS l'en-tête, et la trace est dans le corps qui suit :
    // l'imbrication prouve l'ordre visuel mieux qu'une comparaison d'index.
    expect(entete?.querySelector("[data-tool-author]")?.textContent).toContain("First bot prod");
    expect(entete?.querySelector("[data-tool-response]")?.textContent).toContain("météo Lille aujourd’hui");
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
    // The live turn carries the thinking header itself, once.
    expect(document.querySelectorAll("[data-turn-activity][data-thinking] [data-thinking-elapsed]")).toHaveLength(1);
  });

  // Écrire pendant que le bot répond : le second message est ABSORBÉ par le run
  // en cours (steering). Il appartient donc au tour actif et se lit sous le
  // premier message, avec sa mention « Pris en compte… ». L'activité, puis la
  // réponse, viennent sous les deux : sinon le message qu'on venait d'envoyer
  // se faisait dépasser par du texte apparu au-dessus de lui.
  // Rafale : le premier run a été REMPLACÉ par le message suivant (politique
  // de Grok Bot). Son message reste, sans bulle d'erreur ni repère ; la
  // réponse unique vient sous le second message.
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
    expect(container.querySelector(".bg-destructive")).toBeNull();
  });

  // Rejeu fusionné : deux steers jamais lus deviennent UN run (le plus ancien
  // repli reprend son rang), le second se replie dedans et se lit comme absorbé.
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

  // Le run absorbeur a déjà travaillé : le message absorbé reste malgré tout
  // sous la question qui a ouvert le tour, donc au-dessus des outils et de la
  // réponse qui répondent aux deux.
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
    // Le run absorbant a rendu : plus rien n'est « en cours ». L'étiquette
    // restait au présent à vie, sous chaque message absorbé.
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
