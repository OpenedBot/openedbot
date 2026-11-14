import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../src/lib/i18n";
import { queryKeys } from "../../src/lib/api";
import { AppFrameSkeleton, RosterSkeleton } from "../../src/components/skeletons/frame-skeletons";
import { DEFAULT_ACCOUNT_LAYOUT, setAccountLayout } from "../../src/lib/shell/account-layout";

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

/**
 * The frame silhouette at `path`, mounted as the app mounts it: under the
 * query client of `main.tsx`, after the `_app` guards have read the session
 * (`AppAccessPending` draws it only then). A pro build reads the session's
 * entitlements there to show its settings entries.
 */
function renderGuardedFrame(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.authMe, { entitlements: [] });
  const root = createRootRoute({ component: AppFrameSkeleton });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
  return render(<QueryClientProvider client={client}><I18nProvider><RouterProvider router={router as never} /></I18nProvider></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  window.location.href = "http://localhost/";
  document.documentElement.classList.remove("dark");
  setAccountLayout(DEFAULT_ACCOUNT_LAYOUT);
  window.localStorage.clear();
});

describe("silhouettes du cadre", () => {
  // ONE announcement for screen readers, not an empty node per grey block.
  test("le cadre s'annonce une seule fois", () => {
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute("aria-busy")).toBe("true");
  });

  // Only the data pulses: the roster's five rows and, outside a rail
  // shell, the account card. The two top buttons (search, « + ») are decor, painted
  // with their icons.
  test("seuls les composants de données sont des formes", () => {
    setAccountLayout("base");
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(6);
    const tools = document.querySelector("[data-sidebar-tools]")!;
    expect(tools.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    expect(tools.querySelectorAll("svg")).toHaveLength(2);
  });

  // Rail shell (the default layout): no account row at the card's foot,
  // the sidebar keeps only the roster's five rows.
  test("dans la coque à rail, le compte quitte la barre latérale", () => {
    setAccountLayout("c");
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(5);
  });

  // In the macOS shell, the traffic lights and the drag handle
  // live on the top bar, full width: the silhouette keeps it.
  test("le cadre garde la rangée de la barre de titre native", () => {
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    expect(document.querySelector("[data-titlebar-drag] [data-titlebar-lights]")).toBeTruthy();
  });

  // Rail shell: no icon rail any more; the conversations card carries its
  // head (logo or traffic lights, then the collapse) and its foot (the three
  // LLM quotas loading, the runtime, Réglages), as `RailHead` / `RailFooter`.
  test("la carte des conversations porte la tête et le pied du rail, sans avatar", () => {
    setAccountLayout("c");
    document.documentElement.classList.add("dark");
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    expect(document.querySelector("[data-board-icon-rail]")).toBeNull();
    const head = document.querySelector("[data-rail-head]")!;
    expect(head.querySelector("[data-titlebar-lights]")).toBeTruthy();
    expect(head.querySelector("[data-rail-logo]")).toBeTruthy();
    // The search glass and the « + »; the collapse sits left of the breadcrumb (09-11-2026).
    expect(head.querySelectorAll("svg")).toHaveLength(2);
    expect(document.querySelector("[data-board-surface-header] [data-rail-lead] svg")).toBeTruthy();
    const foot = document.querySelector("[data-rail-footer]")!;
    // Neither theme nor language: they are set in Réglages > Apparence.
    expect(foot.textContent).toBe("");
    expect(foot.querySelector(".tabler-icon-server-bolt")).toBeTruthy();
    const quotas = foot.querySelector('[data-rail-llm-quotas="loading"]')!;
    expect(quotas.children).toHaveLength(3);
    // Runtime and Réglages.
    expect([...foot.querySelectorAll("svg")].filter((icon) => !quotas.contains(icon))).toHaveLength(2);
    expect(foot.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  // On a settings section: the settings menu replaces the roster,
  // the breadcrumb names the section, the card carries the section body.
  test("sur les réglages, le cadre dessine la page des réglages", async () => {
    setAccountLayout("c");
    window.location.href = "http://localhost/o/dev/settings/agents";
    renderGuardedFrame("/o/dev/settings/agents");
    expect(await screen.findByText("Quitter les réglages")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(0);
    // Agent import is filed under Runtime, as in the menu.
    expect(screen.getAllByText("Runtime").length).toBeGreaterThan(1);
    expect(screen.getByText("Salon")).toBeTruthy();
  });

  // Activité: the four tiles and the two charts in their place, like
  // the section's fallback, so nothing jumps between the two stages.
  test("sur Activité, la carte porte les tuiles et les graphiques", async () => {
    setAccountLayout("c");
    window.location.href = "http://localhost/o/dev/settings/activity";
    renderGuardedFrame("/o/dev/settings/activity");
    await screen.findByText("Quitter les réglages");
    // One card for the four figures, one per chart (`DashboardCard`), the
    // tiles laid flat in the first (`StatTile`).
    expect(document.querySelectorAll("[data-settings-pane] [data-dashboard-card]")).toHaveLength(3);
    expect(document.querySelectorAll("[data-settings-pane] [data-stat-tile]")).toHaveLength(4);
    expect(screen.getAllByText("Activité").length).toBeGreaterThan(1);
  });

  // Modèles: the header and the page's three cards (default model,
  // bots' model with its table, providers), not a generic card.
  // It is also the screen's silhouette while the catalog is being read.
  test("sur Modèles, la carte porte les trois blocs de la page", async () => {
    setAccountLayout("c");
    window.location.href = "http://localhost/o/dev/settings/models";
    renderGuardedFrame("/o/dev/settings/models");
    await screen.findByText("Quitter les réglages");
    const page = document.querySelector("[data-settings-pane] [data-models-skeleton]")!;
    expect(page).toBeTruthy();
    expect(page.querySelectorAll("[data-settings-card]")).toHaveLength(3);
    expect(page.textContent).toContain("Modèle par défaut");
    expect(page.textContent).toContain("Modèle des bots");
    expect(page.textContent).toContain("Effort de raisonnement");
  });

  test("le roster dessine le nombre de rangées demandé", () => {
    render(<RosterSkeleton label="Chargement" rows={3} />);
    expect(screen.getByRole("status", { name: "Chargement" })).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(3);
  });
});
