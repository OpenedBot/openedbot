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

/** Lu dans le dictionnaire, jamais recopié : la copie change, l'intention non. */
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
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("fresh setup d’un runtime client non administré", () => {
  // OHB-15 : la console n'ouvre plus de session sur la machine du client. Le
  // parcours doit rester complet : conversations, catalogue, choix de modèle,
  // et dire explicitement où se pose une clé fournisseur : sur l'hôte.
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
    // L'appartenance du runtime n'est plus un bandeau : elle est au « ? » de
    // l'en-tête. Le contrat se vérifie donc en l'ouvrant.
    fireEvent.click(await screen.findByRole("button", { name: "À propos de ce runtime" }));
    // Les assertions portent sur le PANNEAU ouvert, pas sur la page : l'écran
    // nomme la même commande ailleurs (le guide d'accès direct), et une
    // recherche globale y trouvait deux éléments au lieu d'un.
    const ownership = (await screen.findByText("Ce runtime vous appartient")).closest("[role=\"dialog\"]");
    expect(ownership).not.toBeNull();
    const panel = ownership as HTMLElement;
    expect(within(panel).getByText(/n’ouvre aucune session sur votre machine/i)).toBeTruthy();
    expect(within(panel).getByText(/edge-setup credentials add/)).toBeTruthy();

    await act(async () => router.navigate({ to: "/settings/models" }));
    expect((await screen.findAllByText("gpt-5.6-luna")).length).toBeGreaterThan(0);
    // Bureau : chaque fournisseur connecté a sa ligne, « Gérer » ouvre son dialogue.
    fireEvent.click(await screen.findByRole("button", { name: "Gérer OpenAI API" }));
    // Sur un runtime joint en ACCÈS DIRECT, openedbot n'a pas de lien par où porter
    // une clé : le dialogue se réduit à nommer le geste, sur l'hôte, avec
    // edge-setup. Il ne propose donc ni champ de clé ni bouton OAuth.
    // (`ProviderConfigDialog` court-circuite sur `reachability === "direct"`.)
    const provider = await screen.findByRole("dialog", { name: "OpenAI API" });
    expect(within(provider).getByText(/Capacités gérées sur l’hôte/)).toBeTruthy();
    expect(within(provider).getByText("edge-setup credentials add openai-api")).toBeTruthy();
    expect(within(provider).queryByPlaceholderText(API_KEY_PLACEHOLDER)).toBeNull();
  });
});
