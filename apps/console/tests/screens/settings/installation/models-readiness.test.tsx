import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  OverviewDto,
  RuntimeConfigurationDto,
  RuntimeModelCatalogDto,
  RuntimeModelProviderDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { ModelsSettings } from "../../../../src/screens/settings/installation/models";
import { runtimeReadiness } from "../../../../src/screens/settings/installation/models-readiness";

const realFetch = globalThis.fetch;

const RUNTIME_ID = "runtime-1";
const RUNTIME_NAME = "Hermes du VPS";

const runtime: RuntimePublicDto = {
  id: RUNTIME_ID,
  configured: true,
  baseUrl: "https://hermes.example.test",
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

const EMPTY_OVERVIEW: OverviewDto = {
  bots: 0,
  runsTotal: 0,
  runsRunning: 0,
  awaitingApproval: 0,
  completed: 0,
  failed: 0,
  tokens: 0,
  successRate: null,
  activity: [],
};

function stubFetch(options: {
  runtimeMode: RuntimeConfigurationDto["runtimeMode"];
  runtime: RuntimePublicDto | null;
  catalog?: RuntimeModelCatalogDto | "error";
  overview?: OverviewDto;
  usageDays?: Array<{ date: string; inputTokens: number; outputTokens: number; totalTokens: number }>;
}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [] });
    if (url.includes("/api/overview")) return Response.json(options.overview ?? EMPTY_OVERVIEW);
    if (url.endsWith("/api/usage") || url.includes("/api/usage?")) {
      const day = options.usageDays ?? [];
      return Response.json({ day, week: [], month: [], year: [] });
    }
    if (url.includes("/model-selection")) {
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as { provider: string | null; model: string | null; reasoningEffort: string | null }
        : { provider: null, model: null, reasoningEffort: null };
      return Response.json({
        ...(options.runtime ?? runtime),
        selectedProvider: body.provider,
        selectedModel: body.model,
        reasoningEffort: body.reasoningEffort,
      });
    }
    if (url.includes("/models")) {
      if (options.catalog === "error" || options.catalog === undefined) {
        return new Response(JSON.stringify({ error: { code: "HERMES_UNREACHABLE", message: "Hermes est injoignable." } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json(options.catalog);
    }
    if (url.includes("/api/runtime")) {
      return Response.json({
        runtime: options.runtime,
        runtimeMode: options.runtimeMode,
        adminMode: "ssh",
        devDefaults: null,
      });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as unknown as typeof fetch;
}

// Bureau : une seule page, sans onglets ; le catalogue complet des
// fournisseurs s'ouvre en fenêtre depuis « Connecter un fournisseur ».
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("verdict de préparation du runtime", () => {
  test("sans runtime déclaré, rien d’autre n’est examiné", () => {
    expect(runtimeReadiness({ runtime: null, catalog: null }).state).toBe("missing");
  });

  // Le catalogue est lu en direct à chaque ouverture ; `lastHealthStatus` n'est
  // écrit que par une action d'opérateur et vieillit sans que rien ne le
  // corrige. Un Hermes revenu après une panne serait verrouillé à vie si le
  // statut daté primait.
  test("un catalogue lu prouve le runtime, même après un statut de santé périmé", () => {
    expect(runtimeReadiness({
      runtime: { ...runtime, lastHealthStatus: "unreachable" },
      catalog: catalogWith([provider]),
    })).toEqual({ state: "ready", pinned: false });
  });

  test("sans catalogue, le dernier état connu nomme la cause", () => {
    expect(runtimeReadiness({
      runtime: { ...runtime, lastHealthStatus: "unauthorized" },
      catalog: null,
    })).toEqual({ state: "unproven", status: "unauthorized" });
    expect(runtimeReadiness({ runtime, catalog: null }).state).toBe("catalog_unreachable");
  });

  test("un catalogue sans fournisseur authentifié n’est pas « prêt »", () => {
    expect(runtimeReadiness({
      runtime,
      catalog: catalogWith([{ ...provider, authenticated: false }]),
    }).state).toBe("no_provider");
    expect(runtimeReadiness({ runtime, catalog: catalogWith([]) }).state).toBe("no_provider");
  });

  // « Laisser Hermes décider » s'enregistre exactement comme « jamais réglé » :
  // le verdict ne dit donc que le fait présent, aucun modèle imposé.
  test("« imposé » se lit sur la sélection, jamais sur une date", () => {
    expect(runtimeReadiness({ runtime, catalog: catalogWith([provider]) }))
      .toEqual({ state: "ready", pinned: false });
    expect(runtimeReadiness({
      runtime: { ...runtime, selectedProvider: "openai-api", selectedModel: "gpt-5.6-luna" },
      catalog: catalogWith([provider]),
    })).toEqual({ state: "ready", pinned: true });
  });
});

/*
 * Caractérisation, pas régression : `models.tsx` n'a pas changé quand
 * Connecteurs a reçu sa garde : l'état `missing` remplaçait déjà tout le
 * panneau. Ce test verrouille ce fait, pour que les deux écrans continuent de
 * dire la même chose du même manque ; il ne prouve pas la garde de Connecteurs,
 * qui a ses propres tests.
 */
describe("écran Modèles fermé tant que le runtime n’est pas prouvé", () => {
  test("mode externe sans runtime : renvoie déclarer le runtime", async () => {
    stubFetch({ runtimeMode: "external", runtime: null });
    renderModels();
    expect(await screen.findByText("Aucun runtime")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Configurer le runtime" })).toBeTruthy();
    expect(screen.queryByLabelText("Fournisseur")).toBeNull();
  });

  /*
    Le pendant de la garde des Connecteurs (`connectors.test.tsx`) : sans
    runtime, ce n'est pas « des sélecteurs vides », c'est aucun geste. Rien à
    rafraîchir, aucune carte à ouvrir, rien à enregistrer, et un seul chemin
    de sortie, le runtime.
  */
  test("mode externe sans runtime : aucun geste ne reste, sauf celui qui répare", async () => {
    stubFetch({ runtimeMode: "external", runtime: null });
    renderModels();
    await screen.findByText("Aucun runtime");
    expect(screen.queryAllByRole("button").length).toBe(0);
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("/settings/runtime");
  });

  test("runtime déclaré, token refusé et catalogue muet : nomme l’état et ferme le choix", async () => {
    stubFetch({
      runtimeMode: "external",
      runtime: { ...runtime, lastHealthStatus: "unauthorized" },
      catalog: "error",
    });
    renderModels();
    expect(await screen.findByText("Runtime non vérifié")).toBeTruthy();
    expect(screen.getByText(/token refusé/)).toBeTruthy();
    // Un token refusé est une réponse : le trajet dit que le runtime a été atteint.
    expect(screen.getByRole("img", { name: "Le runtime a été atteint, et c’est lui qui refuse." })).toBeTruthy();
    expect(screen.queryByLabelText("Fournisseur")).toBeNull();
  });

  // La phrase de la dernière vérification est celle du système, jamais
  // réécrite ; et le pied de carte la date : « il y a 3 j » dit si l'état
  // affiché est encore une information.
  test("runtime non vérifié : la carte porte l’erreur de santé et la date de la vérification", async () => {
    stubFetch({
      runtimeMode: "external",
      runtime: {
        ...runtime,
        lastHealthStatus: "unauthorized",
        lastHealthError: "Hermes a répondu 401 : token refusé.",
        lastCheckedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
      },
      catalog: "error",
    });
    renderModels();
    expect(await screen.findByText("Hermes a répondu 401 : token refusé.")).toBeTruthy();
    expect(screen.queryByText(/Tant que Hermes n’a pas répondu/)).toBeNull();
    expect(screen.getByText("vérifié")).toBeTruthy();
    expect(screen.getByText("il y a 3 j")).toBeTruthy();
  });

  test("catalogue Hermes illisible : ferme l’écran sur la cause", async () => {
    stubFetch({
      runtimeMode: "external",
      runtime: { ...runtime, lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
      catalog: "error",
    });
    renderModels();
    expect(await screen.findByText("Catalogue Hermes illisible")).toBeTruthy();
    expect(screen.queryByLabelText("Fournisseur")).toBeNull();
    expect(screen.getByText("vérifié")).toBeTruthy();
    expect(screen.getByText("il y a 5 min")).toBeTruthy();
  });
});

describe("écran Modèles ouvert", () => {
  // Sans fournisseur, le serveur refuse la sélection : on retire les
  // sélecteurs, il reste un seul appel, connecter un fournisseur.
  test("sans fournisseur authentifié : pas de sélecteur, un seul appel à connecter", async () => {
    stubFetch({
      runtimeMode: "external",
      runtime,
      catalog: catalogWith([{ ...provider, authenticated: false }]),
    });
    renderModels();
    expect(await screen.findByText("Aucun fournisseur connecté")).toBeTruthy();
    expect(screen.queryByLabelText("Fournisseur")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    const catalog = await openCatalog();
    expect(within(catalog).getByPlaceholderText("Rechercher un fournisseur…")).toBeTruthy();
  });

  test("runtime prêt sans modèle imposé : mode affiché et défaut annoncé", async () => {
    stubFetch({ runtimeMode: "external", runtime, catalog: catalogWith([provider]) });
    renderModels();
    expect(await screen.findByText("Lien openedbot")).toBeTruthy();
    expect(screen.getByText("aucun modèle imposé")).toBeTruthy();
    expect(screen.getByText("Choisi par Hermes")).toBeTruthy();
    expect(screen.getByLabelText("Fournisseur")).toBeTruthy();
  });

  test("modèle imposé : ni badge ni bandeau de défaut", async () => {
    stubFetch({
      runtimeMode: "external",
      runtime: { ...runtime, selectedProvider: "openai-api", selectedModel: "gpt-5.6-luna" },
      catalog: catalogWith([provider]),
    });
    renderModels();
    expect(await screen.findByText("Lien openedbot")).toBeTruthy();
    expect(screen.queryByText("aucun modèle imposé")).toBeNull();
    expect(screen.getByLabelText("Fournisseur")).toBeTruthy();
  });

  test("bureau : une page en trois blocs, sans onglet ni dialogue", async () => {
    stubFetch({ runtimeMode: "external", runtime, catalog: catalogWith([provider]) });
    renderModels();
    expect(await screen.findByText("Modèle par défaut")).toBeTruthy();
    expect(screen.getByText("Modèle des bots")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Fournisseur")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByPlaceholderText("Rechercher un fournisseur…")).toBeNull();
  });

  test("bureau : le catalogue des fournisseurs s’ouvre en fenêtre", async () => {
    stubFetch({ runtimeMode: "external", runtime, catalog: catalogWith([provider]) });
    renderModels();
    const catalog = await openCatalog();
    expect(within(catalog).getByPlaceholderText("Rechercher un fournisseur…")).toBeTruthy();
    expect(within(catalog).getByText("OpenAI API")).toBeTruthy();
  });

  test("bureau : le fournisseur demandé se cherche et se choisit", async () => {
    const anthropic: RuntimeModelProviderDto = {
      slug: "anthropic",
      name: "Anthropic",
      isCurrent: false,
      authenticated: true,
      alwaysAuthenticated: false,
      provesInference: true,
      acceptsApiKey: true,
      acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
      warning: null,
      authCommand: null,
      models: [{ id: "claude-sonnet-4", fast: false, reasoning: true, isRuntimeDefault: false, freeTier: null }],
    };
    const gemini: RuntimeModelProviderDto = {
      slug: "google",
      name: "Google Gemini",
      isCurrent: false,
      authenticated: false,
      alwaysAuthenticated: false,
      provesInference: false,
      acceptsApiKey: true,
      acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
      warning: null,
      authCommand: null,
      models: [],
    };
    stubFetch({
      runtimeMode: "external",
      runtime,
      catalog: catalogWith([provider, anthropic, gemini]),
    });
    renderModels();

    fireEvent.click(await screen.findByLabelText("Fournisseur"));
    const search = await screen.findByPlaceholderText("Rechercher un fournisseur…");
    expect(screen.getByRole("option", { name: /OpenAI API/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Anthropic/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Google Gemini/ })).toBeTruthy();

    fireEvent.change(search, { target: { value: "Anthropic" } });
    expect(screen.getByRole("option", { name: /Anthropic/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /OpenAI API/ }) === null).toBe(true);
    expect(screen.queryByRole("option", { name: /Google Gemini/ }) === null).toBe(true);

    fireEvent.click(screen.getByRole("option", { name: /Anthropic/ }));
    await waitFor(() => {
      expect((screen.getByLabelText("Modèle") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByLabelText("Modèle").textContent).toContain("claude-sonnet-4");
  });
});

describe("l’écran ne se referme pas sur un incident passager", () => {
  // TanStack conserve `data` quand un RAFRAÎCHISSEMENT échoue. Fermer là-dessus
  // effaçait un catalogue encore en main, et avec lui le bouton qui permettait
  // de réessayer : il fallait quitter l’écran pour en sortir.
  test("un rafraîchissement raté se dit sans effacer le catalogue en main", async () => {
    let calls = 0;
    const catalog = catalogWith([provider]);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [] });
      if (url.includes("/api/overview")) return Response.json(EMPTY_OVERVIEW);
      if (url.endsWith("/api/usage")) return Response.json({ day: [], week: [], month: [], year: [] });
      if (url.includes("/models")) {
        calls += 1;
        if (calls === 1) return Response.json(catalog);
        return new Response(JSON.stringify({ error: { code: "HERMES_UNREACHABLE", message: "Hermes est injoignable." } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime")) {
        return Response.json({ runtime, runtimeMode: "external", adminMode: "ssh", devDefaults: null });
      }
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    renderModels();

    expect(await screen.findByLabelText("Fournisseur")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actualiser le catalogue des modèles" }));
    await waitFor(() => expect(calls).toBe(2));

    expect(await screen.findByText("Hermes est injoignable.")).toBeTruthy();
    expect(screen.getByLabelText("Fournisseur")).toBeTruthy();
    expect(screen.queryByText("Catalogue Hermes illisible")).toBeNull();
  });

  // Sans cette attente, le premier rendu annonçait « Aucun Edge »
  // avant la réponse, puis se contredisait.
  test("pendant la lecture, le squelette, jamais un verdict provisoire", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [] });
      if (url.includes("/api/overview")) return Response.json(EMPTY_OVERVIEW);
      if (url.endsWith("/api/usage")) return Response.json({ day: [], week: [], month: [], year: [] });
      if (url.includes("/models")) return Response.json(catalogWith([provider]));
      if (url.includes("/api/runtime")) {
        await gate;
        return Response.json({ runtime, runtimeMode: "external", adminMode: "ssh", devDefaults: null });
      }
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    renderModels();

    expect(await screen.findByRole("status", { name: "Chargement du catalogue Hermes…" })).toBeTruthy();
    expect(screen.queryByText("Aucun runtime")).toBeNull();
    expect(screen.queryByText("Catalogue Hermes illisible")).toBeNull();

    release!();
    expect(await screen.findByLabelText("Fournisseur")).toBeTruthy();
  });

  test("configuration illisible : le dit, sans inventer d’état de runtime", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [] });
      if (url.includes("/api/runtime")) {
        return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Base indisponible." } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    renderModels();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Aucun runtime")).toBeNull();
    expect(screen.queryByLabelText("Fournisseur")).toBeNull();
  });
});
