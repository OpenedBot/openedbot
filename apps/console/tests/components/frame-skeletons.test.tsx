import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../src/lib/i18n";
import { AppFrameSkeleton, RosterSkeleton } from "../../src/components/skeletons/frame-skeletons";
import { DEFAULT_ACCOUNT_LAYOUT, setAccountLayout } from "../../src/lib/shell/account-layout";

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.location.href = "http://localhost/";
  document.documentElement.classList.remove("dark");
  setAccountLayout(DEFAULT_ACCOUNT_LAYOUT);
  window.localStorage.clear();
});

describe("silhouettes du cadre", () => {
  // UNE annonce pour les lecteurs d'écran, pas un nœud vide par bloc gris.
  test("le cadre s'annonce une seule fois", () => {
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute("aria-busy")).toBe("true");
  });

  // Seules les données pulsent : les cinq rangées du roster et, hors coque à
  // rail, la carte du compte. Les deux boutons du haut (recherche, « + ») sont le décor, peint
  // avec ses icônes.
  test("seuls les composants de données sont des formes", () => {
    setAccountLayout("base");
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(6);
    const tools = document.querySelector("[data-sidebar-tools]")!;
    expect(tools.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    expect(tools.querySelectorAll("svg")).toHaveLength(2);
  });

  // Coque à rail (la mise en page par défaut) : le compte vit dans le rail,
  // la barre latérale ne garde que les cinq rangées du roster.
  test("dans la coque à rail, le compte quitte la barre latérale", () => {
    setAccountLayout("c");
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(5);
  });

  // Dans la coque macOS, les feux tricolores et la poignée de déplacement
  // vivent sur la barre du haut, pleine largeur : la silhouette la garde.
  test("le cadre garde la rangée de la barre de titre native", () => {
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    expect(document.querySelector("[data-titlebar-drag] [data-titlebar-lights]")).toBeTruthy();
  });

  // Le bas du rail est celui du vrai `BoardIconRail` : runtime, thème, langue,
  // Réglages, déconnexion ; plus d'avatar ni de Support d'office.
  test("le rail porte les boutons du vrai rail, sans avatar", () => {
    setAccountLayout("c");
    document.documentElement.classList.add("dark");
    render(<I18nProvider><AppFrameSkeleton /></I18nProvider>);
    const rail = document.querySelector("[data-board-icon-rail]")!;
    // Ni thème ni langue : ils se règlent dans Réglages > Apparence.
    expect(rail.textContent).toBe("");
    expect(rail.querySelector(".tabler-icon-server-bolt")).toBeTruthy();
    expect(rail.querySelectorAll("svg")).toHaveLength(5);
    expect(rail.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  // Sur une rubrique des réglages : le menu des réglages remplace le roster,
  // le fil d'Ariane nomme la rubrique, la carte porte le corps de la rubrique.
  test("sur les réglages, le cadre dessine la page des réglages", async () => {
    setAccountLayout("c");
    window.location.href = "http://localhost/o/dev/settings/agents";
    const root = createRootRoute({ component: AppFrameSkeleton });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/o/dev/settings/agents"] }) });
    render(<I18nProvider><RouterProvider router={router as never} /></I18nProvider>);
    expect(await screen.findByText("Quitter les réglages")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(0);
    // L'import des agents est rangé sous Runtime, comme dans le menu.
    expect(screen.getAllByText("Runtime").length).toBeGreaterThan(1);
    expect(screen.getByText("Salon")).toBeTruthy();
  });

  // Activité : les quatre tuiles et les deux graphiques à leur place, comme
  // le repli de la rubrique, pour que rien ne saute entre les deux étapes.
  test("sur Activité, la carte porte les tuiles et les graphiques", async () => {
    setAccountLayout("c");
    window.location.href = "http://localhost/o/dev/settings";
    const root = createRootRoute({ component: AppFrameSkeleton });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/o/dev/settings"] }) });
    render(<I18nProvider><RouterProvider router={router as never} /></I18nProvider>);
    await screen.findByText("Quitter les réglages");
    expect(document.querySelectorAll('[data-settings-pane] [data-slot="card"]')).toHaveLength(6);
    expect(screen.getAllByText("Activité").length).toBeGreaterThan(1);
  });

  // Modèles : l'en-tête et les trois cartes de la page (modèle par défaut,
  // modèle des bots avec son tableau, fournisseurs), pas une carte générique.
  // C'est aussi la silhouette de l'écran pendant la lecture du catalogue.
  test("sur Modèles, la carte porte les trois blocs de la page", async () => {
    setAccountLayout("c");
    window.location.href = "http://localhost/o/dev/settings/models";
    const root = createRootRoute({ component: AppFrameSkeleton });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/o/dev/settings/models"] }) });
    render(<I18nProvider><RouterProvider router={router as never} /></I18nProvider>);
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
