import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { SidebarProvider } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../src/lib/i18n";
import { OverviewScreen } from "../../src/screens/home/overview";

const realFetch = globalThis.fetch;

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function renderHome() {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: OverviewScreen,
  });
  const runtimeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/runtime",
    component: () => null,
  });
  const modelsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/models",
    component: () => null,
  });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, runtimeRoute, modelsRoute, inboxRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SidebarProvider>
          <RouterProvider router={router as never} />
        </SidebarProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = href(input);
    if (url.includes("/api/runtime") && !url.includes("/api/runtime/")) {
      return Response.json({
        runtime: null,
        runtimeMode: "external",
        adminMode: "cloud",
        devDefaults: null,
      });
    }
    if (url.includes("/api/overview")) {
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
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("accueil foyer", () => {
  test("placeholder salon, sans dashboard", async () => {
    renderHome();

    expect(await screen.findByRole("heading", { name: "Le salon est calme." })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ouvrir l.inbox/ }).getAttribute("href")).toBe("/inbox");
    expect(screen.queryByText("Aucun runtime")).toBeNull();
    expect(screen.queryByText("Un fil et une mémoire par bot")).toBeNull();
    expect(screen.queryByText(/Add Gateway|gateways/i)).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Installer l’application" })).toBeNull();
  });
});
