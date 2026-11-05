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
import type { OverviewDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { CloudSettingsOverview } from "../../../../src/screens/settings/installation/cloud";

const realFetch = globalThis.fetch;

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
  overview?: OverviewDto;
  usageDays?: Array<{ date: string; inputTokens: number; outputTokens: number; totalTokens: number }>;
} = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [] });
    if (url.includes("/api/overview")) return Response.json(options.overview ?? EMPTY_OVERVIEW);
    if (url.endsWith("/api/usage") || url.includes("/api/usage?")) {
      return Response.json({ day: options.usageDays ?? [], week: [], month: [], year: [] });
    }
    if (url.includes("/api/runtime")) {
      return Response.json({ runtime: null, runtimeMode: "external", adminMode: "ssh", devDefaults: null });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as unknown as typeof fetch;
}

function renderOverview() {
  const rootRoute = createRootRoute({ component: Outlet });
  const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: CloudSettingsOverview,
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      overviewRoute,
      stub("/settings/runtime"),
      stub("/settings/account"),
      stub("/settings/security"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
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
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("dashboard sur la Vue d’ensemble des réglages", () => {
  test("sans run : les cartes et les graphes vides", async () => {
    stubFetch();
    renderOverview();
    expect(await screen.findByText("Un fil et une mémoire par bot")).toBeTruthy();
    // Les blocs du tableau de bord se montent un par un, après une peinture.
    expect(await screen.findByText("Activité des bots")).toBeTruthy();
    expect(await screen.findByText("Consommation de jetons")).toBeTruthy();
    expect(await screen.findByText("Aucune consommation sur la période.")).toBeTruthy();
  });

  test("activité et jetons une fois les séries peuplées", async () => {
    stubFetch({
      overview: {
        ...EMPTY_OVERVIEW,
        bots: 2,
        runsTotal: 15,
        completed: 12,
        failed: 3,
        tokens: 3900,
        successRate: 80,
        activity: [{ date: "2026-08-31", completed: 12, failed: 3, tokens: 3900 }],
      },
      usageDays: [
        { date: "2026-08-30", inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 },
        { date: "2026-08-31", inputTokens: 400, outputTokens: 500, totalTokens: 900 },
      ],
    });
    renderOverview();
    expect(await screen.findByText("15")).toBeTruthy();
    expect(screen.getAllByText(/3\s900 jetons/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Aucune consommation sur la période.")).toBeNull();
  });

  test("« Mon compte » remplace le lien vers l’organisation", async () => {
    stubFetch();
    renderOverview();
    const link = await screen.findByRole("link", { name: /Mon compte/ });
    expect(link.getAttribute("href")).toBe("/settings/account");
  });
});
