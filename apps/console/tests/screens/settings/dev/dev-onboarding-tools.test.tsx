import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { AuthProvidersDto, OnboardingStateDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { DevOnboardingTools } from "../../../../src/screens/settings/dev/dev-onboarding-tools";

const realFetch = globalThis.fetch;

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const PROVIDERS_DEV: AuthProvidersDto = {
  google: { enabled: false, reason: "not_configured" },
  password: { enabled: true },
  devSignIn: { email: "dev@ohb.local", password: "secret" },
};

const PROVIDERS_PROD: AuthProvidersDto = {
  google: { enabled: false, reason: "not_configured" },
  password: { enabled: true },
};

const RESET_STATE: OnboardingStateDto = {
  questionnaire: null,
  workspaceName: "Dev",
  onboardedAt: null,
  completionPath: null,
  completed: false,
};

function stubFetch(providers: AuthProvidersDto, calls: string[], bodies: string[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = href(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url, "http://localhost").pathname}`);
    if (typeof init?.body === "string") bodies.push(init.body);
    if (url.includes("/api/auth/providers")) return Response.json(providers);
    if (url.includes("/api/onboarding/reset") && method === "POST") return Response.json(RESET_STATE);
    if (url.includes("/api/onboarding")) return Response.json({ ...RESET_STATE, completed: true });
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function renderTools() {
  const rootRoute = createRootRoute({ component: Outlet });
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/profile",
    component: DevOnboardingTools,
  });
  const onboardingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/onboarding",
    component: () => <p>accueil</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([profileRoute, onboardingRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/profile"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router as never} />
      </I18nProvider>
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

describe("DevOnboardingTools", () => {
  test("sans `devSignIn` publié par le cloud API, la carte n'existe pas", async () => {
    const calls: string[] = [];
    stubFetch(PROVIDERS_PROD, calls);
    renderTools();
    await waitFor(() => {
      expect(calls).toContain("GET /api/auth/providers");
    });
    expect(screen.queryByText("Outils de développement")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rejouer l’onboarding (dev)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Repartir de zéro (dev)" })).toBeNull();
  });

  test("en développement : le bouton appelle POST /api/onboarding/reset puis emmène sur /onboarding", async () => {
    const calls: string[] = [];
    stubFetch(PROVIDERS_DEV, calls);
    const router = renderTools();
    const button = await screen.findByRole("button", { name: "Rejouer l’onboarding (dev)" });
    expect(screen.getByText("Outils de développement")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => {
      expect(calls).toContain("POST /api/onboarding/reset");
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding");
    });
    expect(await screen.findByText("accueil")).toBeTruthy();
  });

  test("« Repartir de zéro » ne détruit rien sans confirmation explicite", async () => {
    const calls: string[] = [];
    stubFetch(PROVIDERS_DEV, calls);
    renderTools();
    const wipe = await screen.findByRole("button", { name: "Repartir de zéro (dev)" });
    fireEvent.click(wipe);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(calls).not.toContain("POST /api/onboarding/reset");
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(calls).not.toContain("POST /api/onboarding/reset");
  });

  test("confirmé, le vidage poste `scope: \"full\"` puis emmène sur /onboarding", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    stubFetch(PROVIDERS_DEV, calls, bodies);
    window.localStorage.setItem("ohb:onboarding-draft", "stale draft");
    const router = renderTools();
    fireEvent.click(await screen.findByRole("button", { name: "Repartir de zéro (dev)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Vider et repartir de zéro" }));
    await waitFor(() => {
      expect(calls).toContain("POST /api/onboarding/reset");
    });
    expect(bodies.map((body) => JSON.parse(body))).toContainEqual({ scope: "full" });
    expect(window.localStorage.getItem("ohb:onboarding-draft")).toBeNull();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding");
    });
    expect(await screen.findByText("accueil")).toBeTruthy();
  });
});
