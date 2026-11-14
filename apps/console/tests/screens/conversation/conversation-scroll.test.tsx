import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { SidebarProvider } from "@openedbot/browser-ui-kit";
import type { BotDto, GroupDto, RosterDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { clearCloudSession } from "../../../src/lib/session/cloud-session";
import { queryKeys, type ThreadView } from "../../../src/lib/api";
import { GroupConversationScreen } from "../../../src/screens/conversation/group-conversation";

// Vite's DEV flag is boolean; Bun's process.env cannot represent that build.
mock.module("../../../src/lib/thread/dev-approval-probe", () => ({ SHOW_FEATURE_LAB: true }));
const { ConversationScreen } = await import("../../../src/screens/conversation/conversation");

const realFetch = globalThis.fetch;
const timestamp = "2026-10-17T10:00:00.000Z";

const bots: BotDto[] = [
  {
    id: "bot-one",
    threadId: "thread-bot",
    name: "Scout",
    slug: "scout",
    description: "Research",
    instructions: "Find and cite sources.",
    model: null,
    reasoningEffort: null,
    sectionId: "section-one",
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
    lastActivityAt: timestamp,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastRunAt: null,
  },
  {
    id: "bot-two",
    threadId: "thread-bot-two",
    name: "Relay",
    slug: "relay",
    description: "Support",
    instructions: "Draft replies.",
    model: null,
    reasoningEffort: null,
    sectionId: "section-one",
    position: 1,
    pinned: false,
    face: null,
    voiceId: null,
    hermesProfile: null,
    isolation: "profile",
    hasOwnRuntime: false,
    runtimeName: null,
    awaitingApproval: false,
    preview: null,
    lastActivityAt: timestamp,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastRunAt: null,
  },
];

const group: GroupDto = {
  id: "group-one",
  name: "Support room",
  instructions: "",
  defaultResponder: { kind: "everyone" },
  threadId: "thread-group",
  members: bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    slug: bot.slug,
    face: null,
    voiceId: null,
    archivedAt: null,
  })),
  sectionId: "section-one",
  position: 0,
  needsYou: false,
  awaitingApproval: false,
  running: false,
  preview: null,
  lastActivityAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const roster: RosterDto = {
  sections: [{ id: "section-one", name: "Main", position: 0, collapsed: false }],
  bots,
  groups: [group],
  operator: null,
  cursor: 0,
};

function threadView(id: string, botId: string | null): ThreadView {
  return {
    id,
    botId,
    title: "Long conversation",
    botName: botId ? "Scout" : null,
    instructions: "",
    model: "gpt-6-luna",
    effectiveModel: "gpt-6-luna",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: Array.from({ length: 60 }, (_, index) => ({
      id: `${id}-message-${index}`,
      sequence: String(index + 1),
      role: "user" as const,
      content: [{ type: "text" as const, text: `Message ${index}` }],
      runId: null,
      createdAt: timestamp,
    })),
    runs: [],
    events: [],
    approvals: [],
    cursor: 60,
    organizationCursor: 60,
    truncated: false,
    history: { nextBefore: null, hasMore: false, turnKeys: [] },
  };
}

const snapshots = {
  "thread-bot": threadView("thread-bot", "bot-one"),
  "thread-group": threadView("thread-group", null),
};

function mockLogGeometry(): () => void {
  const prototype = HTMLElement.prototype;
  const scrollHeightOwn = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
  const clientHeightOwn = Object.getOwnPropertyDescriptor(prototype, "clientHeight");
  const parent = Object.getPrototypeOf(prototype) as object;
  const scrollHeightInherited = Object.getOwnPropertyDescriptor(parent, "scrollHeight");
  const clientHeightInherited = Object.getOwnPropertyDescriptor(parent, "clientHeight");
  Object.defineProperties(prototype, {
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") === "log") return 10_000;
        return scrollHeightInherited?.get?.call(this) ?? 0;
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") === "log") return 200;
        return clientHeightInherited?.get?.call(this) ?? 0;
      },
    },
  });
  return () => {
    if (scrollHeightOwn) Object.defineProperty(prototype, "scrollHeight", scrollHeightOwn);
    else delete (prototype as unknown as Record<string, unknown>).scrollHeight;
    if (clientHeightOwn) Object.defineProperty(prototype, "clientHeight", clientHeightOwn);
    else delete (prototype as unknown as Record<string, unknown>).clientHeight;
  };
}

function renderConversation(initialPath: string, configureClient?: (client: QueryClient) => void) {
  const rootRoute = createRootRoute();
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_app",
    component: Outlet,
  });
  const indexRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/",
    component: () => null,
  });
  const botRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/bot/$botId",
    validateSearch: (search: Record<string, unknown>): { task?: string } => ({
      task: typeof search.task === "string" ? search.task : undefined,
    }),
    component: ConversationScreen,
  });
  const groupRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/g/$groupId",
    component: GroupConversationScreen,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([indexRoute, botRoute, groupRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.roster, roster);
  queryClient.setQueryData(queryKeys.runtimeConfiguration, {
    runtime: {
      id: null,
      configured: true,
      baseUrl: "https://hermes.example.com",
      reachability: "direct",
      transport: "direct",
      link: null,
      management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
      name: "Acme runtime",
      isDefault: true,
      isActive: true,
      tokenConfigured: true,
      botCount: 2,
      selectedProvider: "openai",
      selectedModel: "gpt-6-luna",
      reasoningEffort: null,
      detectedVersion: null,
      capabilities: null,
      lastHealthStatus: "healthy",
      lastHealthError: null,
      lastCheckedAt: timestamp,
      updatedAt: timestamp,
    },
    runtimeMode: "external",
    adminMode: "disabled",
    devDefaults: null,
  });
  queryClient.setQueryData(queryKeys.authMe, {
    kind: "session",
    sessionId: "web",
    user: { id: "user-one", email: "operator@example.com", displayName: "Operator" },
    organization: { id: "org-one", slug: "acme", name: "Acme" },
    session: { role: "member", canWrite: false, impersonation: null },
  });
  for (const [threadId, snapshot] of Object.entries(snapshots)) {
    queryClient.setQueryData(queryKeys.thread(threadId), snapshot);
    queryClient.setQueryData(queryKeys.messageVersions(threadId), { families: [] });
  }

  configureClient?.(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SidebarProvider>
          <RouterProvider router={router as never} />
        </SidebarProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  window.sessionStorage.clear();
  clearCloudSession();
  document.cookie = "openedbot_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/auth/me")) {
      return Response.json({
        user: { id: "user-one", email: "operator@example.com", displayName: "Operator" },
        organization: { id: "org-one", slug: "acme", name: "Acme" },
        role: "member",
      });
    }
    if (url.endsWith("/api/runtime")) {
      return Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    const history = url.match(/\/api\/threads\/([^/]+)\/history$/);
    if (history) return Response.json(snapshots[history[1] as keyof typeof snapshots]);
    if (url.endsWith("/message-versions")) return Response.json({ families: [] });
    if (/\/api\/threads\/[^/]+\/read$/.test(url)) return new Response(null, { status: 204 });
    if (url.includes("/api/events")) return new Response(null, { status: 204 });
    return Response.json({}, { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  clearCloudSession();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("conversation scroll position", () => {
  test("the desktop header opens the development scenario lab without sending a message", async () => {
    const requests: string[] = [];
    const fallbackFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") requests.push(String(input));
      return fallbackFetch(input, init);
    }) as typeof fetch;
    renderConversation("/bot/bot-one");
    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir le laboratoire de scénarios" }));
    expect(await screen.findByRole("dialog", { name: "Tester Scout" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(requests.some((url) => url.includes("/messages"))).toBe(false);
  });

  test("a direct runtime outage keeps automatic retry available and recovers without reloading", async () => {
    let available = false;
    const fallbackFetch = globalThis.fetch;
    renderConversation("/bot/bot-one", (client) => {
      const configuration = client.getQueryData<{ runtime: { id: string | null } }>(queryKeys.runtimeConfiguration)!;
      const withRuntime = { ...configuration, runtime: { ...configuration.runtime, id: "recovery-runtime" } };
      client.setQueryData(queryKeys.runtimeConfiguration, withRuntime);
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/bots?")) return Response.json(roster);
        if (url.endsWith("/api/runtime")) return Response.json(withRuntime);
        if (url.endsWith("/api/runtimes/recovery-runtime/models")) {
          return available
            ? Response.json({ runtimeId: "recovery-runtime", providers: [], hasUsableProvider: true })
            : Response.json({ error: { code: "HERMES_UNREACHABLE", message: "Le runtime Hermes est inaccessible." } }, { status: 502 });
        }
        return fallbackFetch(input, init);
      }) as typeof fetch;
    });
    expect(await screen.findByText("Le runtime ne répond plus.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Conversation indisponible" }) === null).toBe(true));
    expect(screen.getByText("Message 59")).toBeTruthy();
    available = true;
    fireEvent.click(screen.getByRole("button", { name: /Réessayer/ }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Message à Scout" }) as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.queryByText("Le runtime ne répond plus.")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Conversation indisponible" }) === null).toBe(true));
  });

  test("opens a long bot thread at the bottom on first visit and after returning to the same URL", async () => {
    const restoreGeometry = mockLogGeometry();
    try {
      const router = renderConversation("/bot/bot-one");
      const firstScroller = await screen.findByRole("log");
      expect(firstScroller.scrollTop).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).toBeNull();

      await act(async () => router.navigate({ to: "/" }));
      await act(async () => router.navigate({ to: "/bot/$botId", params: { botId: "bot-one" } }));
      const returnedScroller = await screen.findByRole("log");
      expect(returnedScroller.scrollTop).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).toBeNull();
    } finally {
      restoreGeometry();
    }
  });

  test("opens a long group conversation at the bottom", async () => {
    const restoreGeometry = mockLogGeometry();
    try {
      renderConversation("/g/group-one");
      const scroller = await screen.findByRole("log");
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Aller en bas de la conversation" })).toBeNull();
    } finally {
      restoreGeometry();
    }
  });
});
