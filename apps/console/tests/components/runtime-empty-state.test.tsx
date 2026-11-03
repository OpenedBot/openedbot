import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { I18nProvider } from "../../src/lib/i18n";
import { RuntimeEmptyState } from "../../src/components/runtime-empty-state";

function renderEmpty() {
  const rootRoute = createRootRoute({ component: Outlet });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: RuntimeEmptyState,
  });
  const runtimeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/runtime",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, runtimeRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <I18nProvider>
      <RouterProvider router={router as never} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(cleanup);

describe("empty-state runtime", () => {
  test("annonce une seule machine et pointe vers son enrôlement", async () => {
    renderEmpty();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Aucune machine reliée" })).toBeTruthy();
    });
    expect(screen.getByText(/une machine pour tourner/i).textContent).toContain("une seule suffit");
    expect(screen.queryByText(/Add Gateway|gateways|runtime|Hermes/i)).toBeNull();
    const cta = screen.getByRole("link", { name: "Relier ma machine" });
    expect(cta.getAttribute("href")).toBe("/settings/runtime");
  });
});
