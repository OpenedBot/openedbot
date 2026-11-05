import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../../../src/lib/i18n";
import {
  ARCHIVE_PAGE_SIZE,
  ArchiveSection,
  archivePage,
  pageCheckState,
} from "../../../../src/screens/settings/general/archive-section";

type Item = { id: string; name: string };
const items = (count: number): Item[] =>
  Array.from({ length: count }, (_, index) => ({ id: `b${index + 1}`, name: `Bot ${index + 1}` }));

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("les pages des archives", () => {
  test("15 lignes par page, et une page hors bornes revient sur la dernière", () => {
    expect(ARCHIVE_PAGE_SIZE).toBe(15);
    const list = items(37);
    expect(archivePage(list, 0)).toMatchObject({ page: 0, pages: 3, start: 0 });
    expect(archivePage(list, 0).rows).toHaveLength(15);
    expect(archivePage(list, 2).rows.map((item) => item.id)).toEqual(["b31", "b32", "b33", "b34", "b35", "b36", "b37"]);
    // La liste a rétréci sous la page ouverte (une sélection supprimée) : pas de page vide.
    expect(archivePage(items(16), 5)).toMatchObject({ page: 1, pages: 2, start: 15 });
    expect(archivePage([], 3)).toMatchObject({ page: 0, pages: 1, rows: [] });
  });

  test("la case de la page : rien, une partie, tout", () => {
    expect(pageCheckState(["a", "b"], new Set())).toBe(false);
    expect(pageCheckState(["a", "b"], new Set(["a", "z"]))).toBe("indeterminate");
    expect(pageCheckState(["a", "b"], new Set(["a", "b"]))).toBe(true);
  });
});

function renderSection(list: Item[], seen: Item[][]) {
  return render(
    <I18nProvider>
      <ArchiveSection
        title="Corbeille"
        description="Supprimés."
        items={list}
        keyOf={(item) => item.id}
        labelOf={(item) => item.name}
        actions={(selected) => {
          seen.push(selected);
          return <button type="button">{`Agir (${selected.length})`}</button>;
        }}
        renderRow={(item, select) => <li key={item.id}>{select}{item.name}</li>}
      />
    </I18nProvider>,
  );
}

describe("la sélection d'une section des archives", () => {
  test("la page, puis toute la section, et la sélection survit au changement de page", () => {
    const seen: Item[][] = [];
    renderSection(items(20), seen);
    expect(screen.getAllByRole("listitem")).toHaveLength(15);
    expect(screen.getByText("1 à 15 sur 20")).toBeTruthy();
    // Rien de sélectionné : pas de geste de masse.
    expect(screen.queryByRole("button", { name: /^Agir/ })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Sélectionner cette page" }));
    expect(screen.getByRole("button", { name: "Agir (15)" })).toBeTruthy();
    expect(screen.getByText("15 sur 20 sélectionnés")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Tout sélectionner (20)" }));
    expect(seen.at(-1)!.map((item) => item.id)).toHaveLength(20);
    expect(screen.queryByRole("button", { name: /^Tout sélectionner/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("checkbox", { name: "Sélectionner Bot 16" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("checkbox", { name: "Sélectionner Bot 16" }));
    expect(screen.getByRole("checkbox", { name: "Sélectionner cette page" }).getAttribute("aria-checked")).toBe("mixed");
    expect(screen.getByRole("button", { name: "Agir (19)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Désélectionner" }));
    expect(screen.queryByRole("button", { name: /^Agir/ })).toBeNull();
  });

  test("une entrée qui quitte la section sort de la sélection ; une seule page n'a pas de pagination", () => {
    const seen: Item[][] = [];
    const list = items(3);
    const view = renderSection(list, seen);
    expect(document.querySelector("[data-archive-pagination]")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Sélectionner cette page" }));
    expect(screen.getByRole("button", { name: "Agir (3)" })).toBeTruthy();
    // « Bot 2 » a été restauré : la liste revient sans lui.
    view.rerender(
      <I18nProvider>
        <ArchiveSection
          title="Corbeille"
          description="Supprimés."
          items={[list[0]!, list[2]!]}
          keyOf={(item) => item.id}
          labelOf={(item) => item.name}
          actions={(selected) => <button type="button">{`Agir (${selected.length})`}</button>}
          renderRow={(item, select) => <li key={item.id}>{select}{item.name}</li>}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Agir (2)" })).toBeTruthy();
  });
});
