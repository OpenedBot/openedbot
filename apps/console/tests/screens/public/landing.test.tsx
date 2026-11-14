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
import { I18nProvider } from "../../../src/lib/i18n";
import { ModeLanding } from "../../../src/screens/public/landing";

const realFetch = globalThis.fetch;
const NOW = new Date().toISOString();
const ATLAS = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "atlas",
  name: "Atlas",
  face: null,
  preview: null,
  lastActivityAt: NOW,
  pinned: false,
  unread: false,
  running: false,
  awaitingApproval: false,
  archivedAt: null,
  hiddenAt: null,
};

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function renderLanding() {
  const rootRoute = createRootRoute({ component: Outlet });
  const landingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot",
    component: () => <ModeLanding />,
  });
  const botRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    component: () => null,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([landingRoute, botRoute, homeRoute]),
    history: createMemoryHistory({ initialEntries: ["/bot"] }),
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
  window.localStorage.setItem("openedbot:locale", "fr");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = href(input);
    if (url.includes("/api/bots")) {
      return Response.json({ bots: [], sections: [], groups: [] });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("ModeLanding", () => {
  test("le registre : affirmation, action, index vide", async () => {
    renderLanding();
    expect(await screen.findByRole("heading", { level: 1, name: /Un contact/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Nouveau bot/ }).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByText(/Aucun contact pour l’instant/)).toBeTruthy();
    });
  });

  test("une ligne par bot, qui mène à son fil unique", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = href(input);
      if (url.includes("/api/bots")) {
        return Response.json({ bots: [ATLAS], sections: [], groups: [] });
      }
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;

    renderLanding();
    const row = await screen.findByRole("link", { name: /Atlas/ });
    expect(row.getAttribute("href")).toBe(`/bot/${ATLAS.id}`);
  });
});
