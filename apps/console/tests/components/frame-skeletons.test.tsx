import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { AppFrameSkeleton, RosterSkeleton } from "../../src/components/skeletons/frame-skeletons";
import { DEFAULT_ACCOUNT_LAYOUT, setAccountLayout } from "../../src/lib/shell/account-layout";

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
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

  test("le roster dessine le nombre de rangées demandé", () => {
    render(<RosterSkeleton label="Chargement" rows={3} />);
    expect(screen.getByRole("status", { name: "Chargement" })).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="skeleton-list-row"]')).toHaveLength(3);
  });
});
