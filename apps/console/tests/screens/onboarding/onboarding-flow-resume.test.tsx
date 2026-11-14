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
    // The lists the steps mounted here walk through: an empty response is
    // a response, `undefined` would crash the render for nothing.
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
  // The labels expected below are French: the language is fixed here
  // rather than left to that of the test browser.
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
  saveCloudSession({ organizationId: "org-1", csrfToken: "csrf" });
});

afterEach(() => {
  cleanup();
  clearCloudSession();
  window.localStorage.clear();
  // `saveCloudSession` also sets the tab's workspace (`openedbot:workspace:<csrf>`)
  // in sessionStorage, which `clearCloudSession` does not remove: it would take precedence over
  // the organization of the files played afterwards in the same batch.
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
