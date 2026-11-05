import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { BotDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { AgentEditorPanel } from "../../../src/components/boardui/agent-editor-panel";
import { useAgentEditor } from "../../../src/lib/bots/agent-editor";

const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;

const bot: BotDto = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Atlas",
  slug: "atlas",
  description: null,
  instructions: "",
  model: null,
  reasoningEffort: null,
  sectionId: "s",
  position: 0,
  pinned: false,
  face: null,
  voiceId: null,
  hermesProfile: null,
  isolation: "profile",
  hasOwnRuntime: false,
  runtimeName: null,
  awaitingApproval: false,
  preview: null,
  lastActivityAt: new Date().toISOString(),
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastRunAt: null,
};

let patches: Array<Record<string, unknown>> = [];

function serve(current: BotDto) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/bots/bot-1") && method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      patches.push(body);
      current = { ...current, ...body };
      return Response.json(current);
    }
    if (url.includes("/api/bots") && method === "GET") return Response.json({ bots: [current], groups: [], sections: [] });
    return Response.json({ error: { code: "NOT_FOUND", message: url } }, { status: 404 });
  }) as typeof fetch;
}

function renderEditor() {
  const rootRoute = createRootRoute();
  const botRoute = createRoute({ getParentRoute: () => rootRoute, path: "/bot/$botId", component: AgentEditorPanel });
  const router = createRouter({
    routeTree: rootRoute.addChildren([botRoute]),
    history: createMemoryHistory({ initialEntries: ["/bot/bot-1"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router as never} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patches = [];
  window.localStorage.setItem("openedbot:locale", "fr");
  // Wide window: the editor sits inline beside the thread.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  useAgentEditor.setState({ open: true, botId: null });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  useAgentEditor.setState({ open: false, botId: null });
});

describe("profile editor: the end-of-turn notice, no longer chosen at creation", () => {
  test("the switch shows the bot's setting and writes it at once", async () => {
    serve({ ...bot, notifyOnFinish: false });
    renderEditor();
    const toggle = await screen.findByRole("switch", { name: "Me prévenir quand il a fini" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(patches).toEqual([{ notifyOnFinish: true }]));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  test("a server that does not send the setting shows no switch", async () => {
    serve(bot);
    renderEditor();
    await screen.findByText("Langue");
    expect(screen.queryByRole("switch", { name: "Me prévenir quand il a fini" })).toBeNull();
  });
});
