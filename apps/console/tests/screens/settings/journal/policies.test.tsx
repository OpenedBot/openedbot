import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { I18nProvider } from "../../../../src/lib/i18n";
import { PoliciesSettings } from "../../../../src/screens/settings/journal/policies";

/**
 * `useIsMobile` reads `window.innerWidth` synchronously on the first render:
 * below 768 px the page mounts the Inset Grouped shell, above it the
 * desktop version. One or the other is forced here, never via a browser.
 */
const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;
const realInnerWidth = window.innerWidth;
const queryClients: QueryClient[] = [];

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

/** The sentences shown on mobile, one per `InsetGroupedStatic` row. */
const MOBILE_VALUES = [
  "Autoriser une fois ou refuser ; un propriétaire ou un administrateur peut aussi choisir « Toujours » pour un outil sur un bot, ou pour les commandes jugées dangereuses d’un runtime",
  "Aucune autorisation permanente côté Hermes : l’API refuse ses choix permanents ; un « Toujours » reste dans openedbot et se retire dans les réglages du bot ou du runtime",
  "Une demande expirée ou déjà traitée ne peut pas être rejouée",
  "Propriétaire ou administrateur",
  "Aucune session shell vers un hôte client : les opérations fournisseur passent par le lien connecteur authentifié",
  "Un brouillon est testé avant d’être enregistré",
  "Transmis à Hermes sur le canal HTTPS authentifié, jamais relus ni stockés par openedbot",
  "Chaque requête et chaque donnée sont limitées à l’organisation active",
  "HTTPS obligatoire en production ; une origine HTTP n’est acceptée qu’en développement, déclarée explicitement, et signalée comme non sûre",
  "Les décisions humaines sont liées à la précédente par une chaîne de hachage SHA-256 ; les autorisations données par le mode de l’agent sont tracées à part comme résolutions de politique",
];

function renderPolicies() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  queryClients.push(queryClient);
  const rootRoute = createRootRoute({ component: Outlet });
  const policiesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/policies",
    component: PoliciesSettings,
  });
  const targetRoutes = ["/settings/decisions", "/settings/runtime", "/settings/security", "/legal/$slug"].map(
    (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([policiesRoute, ...targetRoutes]),
    history: createMemoryHistory({ initialEntries: ["/settings/policies"] }),
  });
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
});

afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  setViewportWidth(realInnerWidth);
  window.localStorage.clear();
});

describe("PoliciesSettings: bureau", () => {
  test("décrit le canal d’administration réel, sans SSH ni stdin, avec ses trois liens", async () => {
    setViewportWidth(DESKTOP_WIDTH);
    renderPolicies();

    expect(await screen.findByText("Canal d’administration")).toBeTruthy();
    expect(document.querySelector("[data-mobile-settings]")).toBeNull();
    expect(screen.getByText("Connexion au runtime")).toBeTruthy();
    expect(screen.getByText("Secrets fournisseurs")).toBeTruthy();

    // No outgoing SSH channel anymore; the provider key leaves over HTTPS, not through stdin.
    expect(document.body.textContent ?? "").not.toMatch(/ssh|stdin/i);

    expect(screen.getByRole("link", { name: "Voir le journal des décisions" }).getAttribute("href")).toBe(
      "/settings/decisions",
    );
    expect(screen.getByRole("link", { name: "Configurer le runtime" }).getAttribute("href")).toBe(
      "/settings/runtime",
    );
    expect(screen.getByRole("link", { name: "Voir la session et la sécurité" }).getAttribute("href")).toBe(
      "/settings/security",
    );
    expect(document.body.textContent ?? "").not.toContain("Cette page décrit les invariants appliqués");
  });

  // Legal texts are public web pages: they open in the
  // browser (a new tab, which the desktop app hands to the system).
  test("les textes légaux s'ouvrent sur le web, hors de l'application", async () => {
    setViewportWidth(DESKTOP_WIDTH);
    renderPolicies();
    const legal = await screen.findByRole("navigation", { name: "Documents légaux" });
    const links = within(legal).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")])).toEqual(
      (["mentions", "privacy", "terms"] as const).map((slug, index) => [
        ["Mentions légales", "Politique de confidentialité", "Conditions d’utilisation"][index]!,
        `/legal/${slug}`,
        "_blank",
        "noopener noreferrer",
      ]),
    );
  });
});

describe("PoliciesSettings: mobile", () => {
  test("chaque invariant se lit en entier, jamais tronqué", async () => {
    setViewportWidth(MOBILE_WIDTH);
    renderPolicies();

    expect(await screen.findByText("Canal d’administration")).toBeTruthy();
    expect(document.querySelector("[data-mobile-settings]")).not.toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/ssh|stdin/i);
    expect(document.body.textContent ?? "").not.toContain("Cette page décrit les invariants appliqués");

    // Three approval rows, four runtime rows, three data rows: each is an `InsetGroupedStatic`.
    const staticRows = document.querySelectorAll("div[data-inset-grouped-row]");
    expect(staticRows.length).toBe(MOBILE_VALUES.length);

    for (const value of MOBILE_VALUES) {
      const node = screen.getByText(value);
      expect(node.className.split(/\s+/)).not.toContain("truncate");
    }
  });
});
