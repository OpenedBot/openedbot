import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { OnboardingStateDto } from "@openedbot/contracts-api";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../src/lib/i18n";
import { saveCloudSession, clearCloudSession } from "../../../src/lib/session/cloud-session";
import {
  EMPTY_RUNTIME_DRAFT,
  ONBOARDING_DRAFT_KEY,
  readOnboardingDraft,
  writeOnboardingDraft,
} from "../../../src/lib/session/onboarding-draft";
import { OnboardingFlow } from "../../../src/screens/onboarding/onboarding-flow";

const realFetch = globalThis.fetch;

const STATE: OnboardingStateDto = {
  questionnaire: null,
  workspaceName: null,
  onboardedAt: null,
  completionPath: null,
  completed: false,
};

function stubFetch(calls: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "http://localhost").pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/onboarding/complete") return Response.json({ ...STATE, completed: true });
    if (path === "/api/runtime/profiles") {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    // Les listes que traversent les étapes montées ici : une réponse vide est
    // une réponse, `undefined` ferait planter le rendu pour rien.
    return Response.json({ jobs: [], profiles: [] });
  }) as typeof fetch;
}

function renderFlow(state: OnboardingStateDto = STATE) {
  const rootRoute = createRootRoute({ component: Outlet });
  const onboardingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/onboarding",
    component: () => <OnboardingFlow state={state} roster={undefined} />,
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
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router as never} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // Les libellés attendus ci-dessous sont français : la langue est fixée ici
  // plutôt que laissée à celle du navigateur de test.
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
  saveCloudSession({ organizationId: "org-1", csrfToken: "csrf" });
});

afterEach(() => {
  cleanup();
  clearCloudSession();
  window.localStorage.clear();
  // `saveCloudSession` pose aussi l'espace de l'onglet (`ohb:workspace:<csrf>`)
  // en sessionStorage, que `clearCloudSession` ne retire pas : il primerait sur
  // l'organisation des fichiers joués ensuite dans le même lot.
  window.sessionStorage.clear();
  globalThis.fetch = realFetch;
});

describe("reprise du parcours d'accueil", () => {
  test("un brouillon rend l'étape enregistrée, pas l'accueil", async () => {
    stubFetch([]);
    writeOnboardingDraft({ step: "workspace" });

    renderFlow();

    await waitFor(() => expect(document.querySelector("#ws-username")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Commencer" })).toBeNull();
  });

  test("un brouillon corrompu retombe sur le début du parcours", async () => {
    stubFetch([]);
    window.localStorage.setItem(ONBOARDING_DRAFT_KEY, "{ pas du json");

    renderFlow();

    await waitFor(() => expect(screen.getByRole("button", { name: "Commencer" })).toBeTruthy());
    expect(document.querySelector("#ws-username")).toBeNull();
  });

  test("un reset complet rejoue l'étape Organisation avec un champ vide", async () => {
    stubFetch([]);

    renderFlow({ ...STATE, workspaceName: "kilwir", organizationReset: true });

    await waitFor(() => expect(document.querySelector("#org-name")).not.toBeNull());
    expect((document.querySelector("#org-name") as HTMLInputElement).value).toBe("");
  });

  test("la fin du parcours efface le brouillon : personne ne reprend celui d'un autre", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    writeOnboardingDraft({ step: "runtime", runtime: { ...EMPTY_RUNTIME_DRAFT, modelId: "grok-4.6" } });

    renderFlow();

    const skip = await screen.findByRole("button", { name: "Configurer plus tard" });
    skip.click();

    await waitFor(() => expect(calls).toContain("POST /api/onboarding/complete"));
    await waitFor(() => expect(readOnboardingDraft()).toBeNull());
  });
});
