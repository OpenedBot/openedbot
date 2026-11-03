import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  BotDto,
  OverviewDto,
  RuntimeConfigurationDto,
  RuntimeModelCatalogDto,
  RuntimeModelProviderDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { ModelsSettings } from "../../../../src/screens/settings/installation/models";
import {
  clearProviderReconnect,
  freshProviderReconnect,
  PROVIDER_RECONNECT_TTL_MS,
  requestProviderReconnect,
  useProviderReconnectRequest,
} from "../../../../src/lib/runtime/provider-auth";

const providerReconnectRequest = () => renderHook(() => useProviderReconnectRequest()).result.current;

/**
 * L'écran Modèles sur téléphone : des LIGNES de réglage et des feuilles à
 * coches, pas des `<select>` empilés dans une carte.
 *
 * `useIsMobile` lit `window.innerWidth` de façon synchrone au premier rendu :
 * fixer la fenêtre avant le montage suffit à obtenir la branche mobile.
 */

const realInnerWidth = window.innerWidth;
const realInnerHeight = window.innerHeight;
const realFetch = globalThis.fetch;
const RUNTIME_ID = "runtime-1";

const runtime: RuntimePublicDto = {
  id: RUNTIME_ID,
  configured: true,
  baseUrl: "https://hermes.example",
  transport: "connector",
  reachability: "connector",
  link: null,
  management: { kind: "host", credentialsWritable: true, oauthWritable: true },
  name: "Hermes VPS",
  isDefault: true,
  isActive: true,
  tokenConfigured: true,
  botCount: 1,
  selectedProvider: null,
  selectedModel: null,
  reasoningEffort: null,
  detectedVersion: null,
  capabilities: null,
  capacity: 4,
  lastHealthStatus: "healthy",
  lastHealthError: null,
  lastCheckedAt: null,
  createdAt: null,
  updatedAt: null,
};

const provider: RuntimeModelProviderDto = {
  slug: "openai-api",
  name: "OpenAI API",
  isCurrent: true,
  authenticated: true,
  alwaysAuthenticated: false,
  provesInference: true,
  acceptsApiKey: true,
  acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
  warning: null,
  authCommand: null,
  models: [
    { id: "gpt-5.6-luna", fast: true, reasoning: true, isRuntimeDefault: true, freeTier: null },
    { id: "gpt-5.6-sol", fast: false, reasoning: false, isRuntimeDefault: false, freeTier: null },
  ],
};

const catalog: RuntimeModelCatalogDto = {
  runtimeId: RUNTIME_ID,
  runtimeName: runtime.name ?? "",
  hermesProfile: null,
  currentProvider: provider.slug,
  runtimeDefaultModel: "gpt-5.6-luna",
  hasUsableProvider: true,
  runtimeConfigWritable: false,
  providers: [provider],
};

const EMPTY_OVERVIEW: OverviewDto = {
  bots: 0, runsTotal: 0, runsRunning: 0, awaitingApproval: 0,
  completed: 0, failed: 0, tokens: 0, successRate: null, activity: [],
};

const bot = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Atlas",
  slug: "atlas",
  description: null,
  instructions: "",
  model: null,
  reasoningEffort: null,
  sectionId: "section-1",
  position: 0,
  pinned: false,
  face: null,
  archivedAt: null,
} as unknown as BotDto;

/** Les écritures observées, pour prouver qu'un choix part vraiment. */
function stubFetch() {
  const writes: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if ((init?.method ?? "GET") !== "GET") writes.push({ url: new URL(url, "http://test").pathname, body });
    if (url.includes("/api/bots/")) return Response.json({ ...bot, ...(body as object) });
    if (url.includes("/api/bots")) return Response.json({ bots: [bot], sections: [], groups: [] });
    if (url.includes("/api/overview")) return Response.json(EMPTY_OVERVIEW);
    if (url.includes("/api/usage")) return Response.json({ day: [], week: [], month: [], year: [] });
    if (url.includes("/model-selection")) {
      const next = body as { provider: string | null; model: string | null; reasoningEffort: string | null };
      return Response.json({
        ...runtime,
        selectedProvider: next.provider,
        selectedModel: next.model,
        reasoningEffort: next.reasoningEffort,
      });
    }
    if (url.includes("/models")) return Response.json(catalog);
    if (url.includes("/api/runtime")) {
      const configuration: RuntimeConfigurationDto = {
        runtime,
        runtimeMode: "external",
        adminMode: "disabled",
        devDefaults: null,
      };
      return Response.json(configuration);
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
  return writes;
}

function renderModels() {
  const rootRoute = createRootRoute({ component: Outlet });
  const modelsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/models",
    component: ModelsSettings,
  });
  const runtimeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/runtime",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([modelsRoute, runtimeRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 430 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 932 });
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: realInnerWidth });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: realInnerHeight });
});

describe("Modèles sur téléphone", () => {
  test("les réglages sont des lignes qui montrent leur valeur, jamais des <select>", async () => {
    stubFetch();
    renderModels();

    // Le fait, sur la ligne : ce que Hermes applique tant qu'openedbot n'impose rien.
    const rows = await screen.findAllByRole("button", { name: /^Fournisseur/ });
    expect(rows[0]!.textContent).toContain("openai-api");
    // `^Modèle` attrape aussi la ligne du bot (« Modèle de Atlas ») : c'est la
    // PREMIÈRE, celle du groupe par défaut, qu'on interroge.
    expect(screen.getAllByRole("button", { name: /^Modèle/ })[0]!.textContent).toContain("gpt-5.6-luna");

    // Aucun menu déroulant : c'est ce qui trahissait la page web.
    expect(document.querySelector("select")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();

    // Les onglets Global / Par bot ont disparu : deux groupes, pas deux vues.
    expect(screen.queryByRole("tab", { name: /Global/ })).toBeNull();
  });

  test("choisir un fournisseur passe par une feuille à coches et part vers l'hôte", async () => {
    const writes = stubFetch();
    renderModels();

    fireEvent.click((await screen.findAllByRole("button", { name: /^Fournisseur/ }))[0]!);
    const sheet = await screen.findByRole("dialog");
    // La valeur en cours porte la coche, les autres non.
    const current = within(sheet).getByRole("option", { name: /Laisser Hermes décider/ });
    expect(current.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(within(sheet).getByRole("option", { name: /OpenAI API/ }));
    // Choisir ne fait que poser un brouillon : rien ne part avant « Enregistrer ».
    expect(writes.some((write) => write.url.includes("/model-selection"))).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Enregistrer" }));
    await waitFor(() =>
      expect(writes.some((write) => write.url.includes("/model-selection"))).toBe(true),
    );
    const write = writes.find((entry) => entry.url.includes("/model-selection"))!;
    // Choisir un fournisseur pose son modèle par défaut : une préférence à
    // moitié posée ne serait honorée par aucun run.
    expect(write.body).toMatchObject({ provider: "openai-api", model: "gpt-5.6-luna" });
  });

  test("un bot ouvre sa propre feuille, où « Modèle global » est une option", async () => {
    const writes = stubFetch();
    renderModels();

    fireEvent.click(await screen.findByRole("button", { name: /Modèle de Atlas/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Suit le modèle par défaut")).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("button", { name: /^Modèle/ }));
    const picker = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(picker).getByRole("option", { name: /Modèle global/ })).toBeTruthy();

    fireEvent.click(within(picker).getByRole("option", { name: /gpt-5\.6-sol/ }));
    await waitFor(() => expect(writes.some((write) => write.url.includes("/api/bots/"))).toBe(true));
    expect(writes.find((write) => write.url.includes("/api/bots/"))!.body)
      .toMatchObject({ model: "gpt-5.6-sol" });
  });
});

// Codex review (2026-10-24): "Reconnecter <provider>" on a failed turn only
// opened Models; the operator then had to find the provider again.
describe("Modèles ouvert depuis « Reconnecter »", () => {
  afterEach(() => clearProviderReconnect());

  test("the requested provider's connection dialog opens, and closing it clears the request", async () => {
    stubFetch();
    requestProviderReconnect("openai-api");
    renderModels();
    const dialog = await screen.findByRole("dialog", { name: "OpenAI API" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Fermer" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "OpenAI API" })).toBeNull());
    // Taken once: the next visit opens the screen alone.
    cleanup();
    renderModels();
    await screen.findAllByRole("button", { name: /^Fournisseur/ });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Codex review (2026-10-26): navigating away with the dialog open left the
  // request held forever, so a much later visit reopened the abandoned login.
  test("leaving Models with the dialog open lets the request go stale again", async () => {
    stubFetch();
    const at = Date.now();
    requestProviderReconnect("openai-api", at);
    renderModels();
    await screen.findByRole("dialog", { name: "OpenAI API" });
    expect(freshProviderReconnect(providerReconnectRequest(), at + 10 * PROVIDER_RECONNECT_TTL_MS)).toBe("openai-api");
    cleanup();
    expect(freshProviderReconnect(providerReconnectRequest(), at + PROVIDER_RECONNECT_TTL_MS + 1)).toBeNull();
  });

  test("a provider the catalogue does not list, or a stale request, opens nothing", async () => {
    stubFetch();
    requestProviderReconnect("xai-oauth");
    renderModels();
    await screen.findAllByRole("button", { name: /^Fournisseur/ });
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    requestProviderReconnect("openai-api", Date.now() - PROVIDER_RECONNECT_TTL_MS - 1);
    renderModels();
    await screen.findAllByRole("button", { name: /^Fournisseur/ });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
