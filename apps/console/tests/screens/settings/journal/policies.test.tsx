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
import { I18nProvider } from "../../../../src/lib/i18n";
import { PoliciesSettings } from "../../../../src/screens/settings/journal/policies";

/**
 * `useIsMobile` lit `window.innerWidth` de façon synchrone au premier rendu :
 * en dessous de 768 px la page monte la coque Inset Grouped, au-dessus la
 * version bureau. On force l'un ou l'autre ici, jamais via un navigateur.
 */
const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;
const realInnerWidth = window.innerWidth;
const queryClients: QueryClient[] = [];

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

/** Les phrases affichées en mobile, une par ligne `InsetGroupedStatic`. */
const MOBILE_VALUES = [
  "Autoriser une fois ou refuser ; un propriétaire ou un administrateur peut aussi choisir « Toujours » pour un outil sur un bot, ou pour les commandes jugées dangereuses d’un runtime",
  "Aucune autorisation permanente côté Hermes : l’API refuse ses choix permanents ; un « Toujours » reste dans openedbot et se retire dans les réglages du bot ou du runtime",
  "Une demande expirée ou déjà traitée ne peut pas être rejouée",
  "Propriétaire, administrateur, ou agence mandatée par le client",
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
  window.localStorage.setItem("ohb:locale", "fr");
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

    // OHB-15 : plus aucun canal SSH sortant ; la clé fournisseur part en HTTPS, pas par stdin.
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
});

describe("PoliciesSettings: mobile", () => {
  test("chaque invariant se lit en entier, jamais tronqué", async () => {
    setViewportWidth(MOBILE_WIDTH);
    renderPolicies();

    expect(await screen.findByText("Canal d’administration")).toBeTruthy();
    expect(document.querySelector("[data-mobile-settings]")).not.toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/ssh|stdin/i);
    expect(document.body.textContent ?? "").not.toContain("Cette page décrit les invariants appliqués");

    // Trois lignes d'approbations, quatre de runtime, trois de données : chacune est une `InsetGroupedStatic`.
    const staticRows = document.querySelectorAll("div[data-inset-grouped-row]");
    expect(staticRows.length).toBe(MOBILE_VALUES.length);

    for (const value of MOBILE_VALUES) {
      const node = screen.getByText(value);
      expect(node.className.split(/\s+/)).not.toContain("truncate");
    }
  });
});
