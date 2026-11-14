import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ThemeProvider } from "@openedbot/browser-ui-kit/theme";
import { t } from "@openedbot/browser-i18n";
import { I18nProvider } from "../../src/lib/i18n";
import { CloudRuntimeSettings } from "../../src/screens/settings/installation/cloud";
import { ModelsSettings } from "../../src/screens/settings/installation/models";

/** Read from the dictionary, never copied: the copy changes, the intention does not. */
const API_KEY_PLACEHOLDER = t("fr", "modelsSettings.apiKeyPlaceholder");

const runtime = {
  id: "runtime-fresh",
  configured: true,
  baseUrl: "https://hermes.example.test",
  transport: "direct" as const,
  reachability: "direct" as const,
  link: null,
  ssh: null,
  management: { kind: "manual" as const, credentialsWritable: false, oauthWritable: false },
  name: "Hermes fresh",
  isDefault: true as const,
  tokenConfigured: true,
  botCount: 0,
  selectedProvider: "openai-api",
  selectedModel: "gpt-5.6-luna",
  reasoningEffort: "low" as const,
  detectedVersion: null,
  capabilities: null,
  lastHealthStatus: "healthy" as const,
  lastCheckedAt: null,
  updatedAt: null,
};

const catalog = {
  runtimeId: runtime.id,
  runtimeName: runtime.name,
  hermesProfile: null,
  currentProvider: "openai-api",
  runtimeDefaultModel: "gpt-5.6-luna",
  hasUsableProvider: true,
  runtimeConfigWritable: false as const,
  providers: [{
    slug: "openai-api",
    name: "OpenAI API",
    isCurrent: true,
    authenticated: true,
    alwaysAuthenticated: false,
    provesInference: true,
    acceptsApiKey: true,
    acceptsOauth: false,
    warning: null,
    authCommand: "hermes auth add openai-api",
    models: [{ id: "gpt-5.6-luna", fast: true, reasoning: true, isRuntimeDefault: true, freeTier: null }],
  }],
};

const realFetch = globalThis.fetch;

function renderJourney() {
  const rootRoute = createRootRoute({ component: Outlet });
  const runtimeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/runtime",
    component: CloudRuntimeSettings,
  });
  const modelsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/models",
    component: ModelsSettings,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([runtimeRoute, modelsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/runtime"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("fresh setup d’un runtime client non administré", () => {
  // The console no longer opens a session on the client's machine. The
  // journey must stay complete: conversations, catalog, model choice,
  // and say explicitly where a provider key is set: on the host.
  test("garde Hermes utilisable et renvoie vers le geste client", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/api/runtime")) return Response.json({ runtime, adminMode: "disabled" });
      if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [] });
      if (url.endsWith("/api/overview")) {
        return Response.json({
          bots: 0,
          runsTotal: 0,
          runsRunning: 0,
          awaitingApproval: 0,
          completed: 0,
          failed: 0,
          tokens: 0,
          successRate: null,
          activity: [],
        });
      }
      if (url.endsWith("/api/usage")) return Response.json({ day: [], week: [], month: [], year: [] });
      if (url.endsWith(`/api/runtimes/${runtime.id}/models`)) return Response.json(catalog);
      throw new Error(`Route inattendue : GET ${url}`);
    }) as typeof fetch;

    const router = renderJourney();
    // Runtime ownership is no longer a banner: it sits on the header's « ? ».
    // The contract is therefore checked by opening it.
    fireEvent.click(await screen.findByRole("button", { name: "À propos de ce runtime" }));
    // Assertions bear on the open PANEL, not on the page: the screen
    // names the same command elsewhere (the direct-access guide), and a
    // global search found two elements there instead of one.
    const ownership = (await screen.findByText("Ce runtime vous appartient")).closest("[role=\"dialog\"]");
    expect(ownership).not.toBeNull();
    const panel = ownership as HTMLElement;
    expect(within(panel).getByText(/n’ouvre aucune session sur votre machine/i)).toBeTruthy();
    expect(within(panel).getByText(/edge-setup credentials add/)).toBeTruthy();

    await act(async () => router.navigate({ to: "/settings/models" }));
    expect((await screen.findAllByText("gpt-5.6-luna")).length).toBeGreaterThan(0);
    // Desktop: each connected provider has its row, « Gérer » opens its dialog.
    fireEvent.click(await screen.findByRole("button", { name: "Gérer OpenAI API" }));
    // On a runtime joined by DIRECT ACCESS, openedbot has no link through which to carry
    // a key: the dialog only names the gesture, on the host, with
    // edge-setup. It therefore offers neither a key field nor an OAuth button.
    // (`ProviderConfigDialog` short-circuits on `reachability === "direct"`.)
    const provider = await screen.findByRole("dialog", { name: "OpenAI API" });
    expect(within(provider).getByText(/Capacités gérées sur l’hôte/)).toBeTruthy();
    expect(within(provider).getByText("edge-setup credentials add openai-api")).toBeTruthy();
    expect(within(provider).queryByPlaceholderText(API_KEY_PLACEHOLDER)).toBeNull();
  });
});
