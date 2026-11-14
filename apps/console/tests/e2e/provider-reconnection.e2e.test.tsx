import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  RuntimeModelCatalogDto,
  RuntimeModelProviderDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { t } from "@openedbot/browser-i18n";
import { I18nProvider } from "../../src/lib/i18n";
import { ModelsSettings } from "../../src/screens/settings/installation/models";

/** Read from the dictionary, never copied: the copy changes, the intention does not. */
const API_KEY_PLACEHOLDER = t("fr", "modelsSettings.apiKeyPlaceholder");

const realFetch = globalThis.fetch;

const RUNTIME_ID = "runtime-1";
const RUNTIME_NAME = "Hermes du VPS";

const runtime: RuntimePublicDto = {
  id: RUNTIME_ID,
  configured: true,
  baseUrl: null,
  transport: "connector",
  reachability: "connector",
  link: null,
  management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
  name: RUNTIME_NAME,
  isDefault: true,
  isActive: true,
  tokenConfigured: true,
  botCount: 0,
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
  models: [{ id: "gpt-5.6-luna", fast: true, reasoning: true, isRuntimeDefault: true, freeTier: null }],
};

function catalogWith(providers: RuntimeModelProviderDto[]): RuntimeModelCatalogDto {
  return {
    runtimeId: RUNTIME_ID,
    runtimeName: RUNTIME_NAME,
    hermesProfile: null,
    currentProvider: providers[0]?.slug ?? null,
    runtimeDefaultModel: providers[0]?.models[0]?.id ?? null,
    hasUsableProvider: providers.some((entry) => entry.authenticated),
    runtimeConfigWritable: false,
    providers,
  };
}

let connected = false;
let managementKind: "manual" | "host" = "manual";
let configurationReads = 0;

function stubConnection() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [] });
    if (url.includes("/models")) return Response.json(catalogWith([provider]));
    if (url.endsWith("/api/runtime")) {
      configurationReads++;
      return Response.json({
        runtime: {
          ...runtime,
          management: { kind: managementKind, credentialsWritable: managementKind === "host" && connected, oauthWritable: managementKind === "host" && connected },
          link: { connected, lastSeenAt: null, lastReplacedAt: null, hijackSuspectedAt: null, rotatedAt: null },
        },
        runtimeMode: "external", adminMode: "disabled", devDefaults: null,
      });
    }
    throw new Error(`Unexpected route: ${url}`);
  }) as typeof fetch;
}

// Desktop: the full provider catalog opens in a window.
async function openCatalog() {
  fireEvent.click(await screen.findByRole("button", { name: "Connecter un fournisseur" }));
  return screen.findByRole("dialog", { name: "Connecter un fournisseur" });
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
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

// HTTP-stubbed screen E2E, matching this directory's conventions. No live host.
test("provider dialog recovers after connector reconnection without reloading the screen", async () => {
  connected = true;
  managementKind = "manual";
  configurationReads = 0;
  stubConnection();
  renderModels();
  const catalog = await openCatalog();
  fireEvent.click(within(catalog).getByText("OpenAI API"));
  expect(await screen.findByText("sudo edge-setup credentials add openai-api --yes")).toBeTruthy();
  expect(screen.queryByPlaceholderText(API_KEY_PLACEHOLDER)).toBeNull();

  // A later hello announces host management while this same dialog stays open.
  managementKind = "host";
  await waitFor(() => expect(screen.getByPlaceholderText(API_KEY_PLACEHOLDER)).toBeTruthy(), { timeout: 4_500 });
  expect(configurationReads).toBeGreaterThan(1);
  expect(screen.queryByText(/sudo edge-setup/)).toBeNull();
  const dummyKey = "dummy-key-for-reconnection-test";
  fireEvent.change(screen.getByPlaceholderText(API_KEY_PLACEHOLDER), { target: { value: dummyKey } });

  connected = false;
  await waitFor(() => expect(screen.getByText(/Le lien avec votre runtime est temporairement déconnecté/)).toBeTruthy(), { timeout: 4_500 });
  expect(screen.queryByPlaceholderText(API_KEY_PLACEHOLDER)).toBeNull();
  expect(screen.queryByText(/sudo edge-setup/)).toBeNull();

  connected = true;
  await waitFor(() => expect(screen.getByPlaceholderText(API_KEY_PLACEHOLDER)).toBeTruthy(), { timeout: 4_500 });
  expect((screen.getByPlaceholderText(API_KEY_PLACEHOLDER) as HTMLInputElement).value).toBe(dummyKey);
  expect(screen.queryByText(/Le lien avec votre runtime est temporairement déconnecté/)).toBeNull();
  expect(screen.queryByText(/sudo edge-setup/)).toBeNull();
}, 15_000);
