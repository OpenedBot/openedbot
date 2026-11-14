import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  OnboardingStateDto,
  RuntimeConfigurationDto,
  RuntimeModelCatalogDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../src/lib/i18n";
import { saveCloudSession, clearCloudSession } from "../../../src/lib/session/cloud-session";
import { writeOnboardingDraft } from "../../../src/lib/session/onboarding-draft";
import { OnboardingFlow } from "../../../src/screens/onboarding/onboarding-flow";

/**
 * The « Configuration » step records the provider and the model on the
 * runtime, finishes onboarding and opens the application. It creates no bot:
 * the first one is created afterwards, from the application.
 */

const realFetch = globalThis.fetch;

const STATE: OnboardingStateDto = {
  questionnaire: null,
  workspaceName: null,
  onboardedAt: null,
  completionPath: null,
  completed: false,
};

const RUNTIME: RuntimePublicDto = {
  id: "rt-1",
  name: "VPS",
  configured: true,
  baseUrl: null,
  transport: "connector",
  reachability: "connector",
  link: null,
  management: { kind: "host", credentialsWritable: true, oauthWritable: true },
  isDefault: true,
  isActive: true,
  tokenConfigured: true,
  botCount: 0,
  selectedProvider: "xai-oauth",
  selectedModel: "grok-4.6",
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

const CONFIGURATION: RuntimeConfigurationDto = {
  runtime: RUNTIME,
  runtimeMode: "external",
  adminMode: "disabled",
  devDefaults: null,
};

/** Two authenticated providers serve the same model identifier: the provider must travel with it. */
const CATALOG: RuntimeModelCatalogDto = {
  runtimeId: "rt-1",
  runtimeName: "VPS",
  hermesProfile: null,
  currentProvider: "xai-oauth",
  runtimeDefaultModel: "grok-4.6",
  hasUsableProvider: true,
  runtimeConfigWritable: false,
  providers: [
    {
      slug: "xai-oauth",
      name: "xAI",
      isCurrent: true,
      authenticated: true,
      alwaysAuthenticated: false,
      provesInference: true,
      acceptsApiKey: false,
      acceptsOauth: true,
      sdkInstalled: null, sdkInstallable: null,
      warning: null,
      authCommand: null,
      models: [
        { id: "grok-4.6", fast: false, reasoning: true, isRuntimeDefault: true, freeTier: null },
      ],
    },
  ],
};

function stubFetch(bodies: Array<{ path: string; body: unknown }>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "http://localhost").pathname;
    if (typeof init?.body === "string") {
      bodies.push({ path, body: JSON.parse(init.body) as unknown });
    }
    if (path === "/api/runtime") return Response.json(CONFIGURATION);
    if (path === "/api/runtime/test") return Response.json({ ok: true });
    if (path === "/api/runtimes/rt-1/models") return Response.json(CATALOG);
    if (path === "/api/runtimes/rt-1/model-selection") return Response.json(RUNTIME);
    if (path === "/api/onboarding/complete") return Response.json({ ...STATE, completed: true });
    return Response.json({ jobs: [], profiles: [], bots: [] });
  }) as typeof fetch;
}

async function renderFlow() {
  const rootRoute = createRootRoute({ component: Outlet });
  const onboardingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/onboarding",
    component: () => <OnboardingFlow state={STATE} roster={undefined} />,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p>accueil</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([onboardingRoute, homeRoute]),
    history: createMemoryHistory({ initialEntries: ["/onboarding"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Flush initial router work before starting the dependent runtime queries.
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <RouterProvider router={router as never} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
  saveCloudSession({ organizationId: "org-1", csrfToken: "csrf" });
});

afterEach(() => {
  cleanup();
  clearCloudSession();
  window.localStorage.clear();
  window.sessionStorage.clear();
  globalThis.fetch = realFetch;
});

describe("étape Configuration du parcours d'accueil", () => {
  test("Terminer enregistre le fournisseur ET le modèle sur le runtime, puis ouvre l'application sans créer de bot", async () => {
    const bodies: Array<{ path: string; body: unknown }> = [];
    stubFetch(bodies);
    writeOnboardingDraft({ step: "runtime", runtime: { providerSlug: "xai-oauth", modelId: "grok-4.6" } });

    await renderFlow();

    const finish = await screen.findByRole("button", { name: "Terminer" });
    await waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      finish.click();
    });

    await waitFor(() => expect(bodies.some((call) => call.path === "/api/onboarding/complete")).toBe(true));
    const selection = bodies.find((call) => call.path === "/api/runtimes/rt-1/model-selection")!.body as Record<string, unknown>;
    expect(selection.provider).toBe("xai-oauth");
    expect(selection.model).toBe("grok-4.6");
    expect(bodies.some((call) => call.path === "/api/bots")).toBe(false);
    // Keep fetch and session fixtures alive until completion and navigation settle.
    expect(await screen.findByText("accueil")).toBeTruthy();
  });

  test("un modèle à prouver ne retient pas l'accueil : la preuve finit en arrière-plan", async () => {
    const bodies: Array<{ path: string; body: unknown }> = [];
    const queued = {
      status: "queued" as const, provider: "xai-oauth", model: "grok-4.6-fast", reasoningEffort: null,
      requestedAt: "2026-10-26T08:00:00.000Z", attempts: 0, nextAttemptAt: null, error: null,
    };
    const fastCatalog: RuntimeModelCatalogDto = {
      ...CATALOG,
      providers: CATALOG.providers.map((provider) => ({
        ...provider,
        models: [...provider.models, { id: "grok-4.6-fast", fast: true, reasoning: false, isRuntimeDefault: false, freeTier: null }],
      })),
    };
    let completed = false;
    let pollsAfterCompletion = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (typeof init?.body === "string") bodies.push({ path, body: JSON.parse(init.body) as unknown });
      if (path === "/api/runtime") {
        // The proof stays queued until onboarding is finished: finishing
        // must therefore never wait for it.
        if (!completed) return Response.json(CONFIGURATION);
        pollsAfterCompletion += 1;
        return Response.json({ ...CONFIGURATION, runtime: { ...RUNTIME, selectedModel: "grok-4.6-fast", modelSelection: null } });
      }
      if (path === "/api/runtime/test") return Response.json({ ok: true });
      if (path === "/api/runtimes/rt-1/models") return Response.json(fastCatalog);
      if (path === "/api/runtimes/rt-1/model-selection") return Response.json({ ...RUNTIME, modelSelection: queued }, { status: 202 });
      if (path === "/api/onboarding/complete") {
        completed = true;
        return Response.json({ ...STATE, completed: true });
      }
      return Response.json({ jobs: [], profiles: [], bots: [] });
    }) as typeof fetch;
    writeOnboardingDraft({ step: "runtime", runtime: { providerSlug: "xai-oauth", modelId: "grok-4.6-fast" } });

    await renderFlow();

    const finish = await screen.findByRole("button", { name: "Terminer" });
    await waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      finish.click();
    });

    expect(await screen.findByText("accueil")).toBeTruthy();
    expect(bodies.some((call) => call.path === "/api/onboarding/complete")).toBe(true);
    // The background follow-up rereads the proof, then stops on the promotion.
    await waitFor(() => expect(pollsAfterCompletion).toBe(1), { timeout: 3_000 });
    // And rereads nothing after that: the loop has indeed exited.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(pollsAfterCompletion).toBe(1);
  });
});
