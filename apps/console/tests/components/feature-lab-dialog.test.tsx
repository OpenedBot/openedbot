import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { FeatureLabDialog } from "../../src/components/feature-lab-dialog";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderLab(onLaunch = (_prompt: string) => {}, disabledReason?: string) {
  window.localStorage.setItem("openedbot:locale", "fr");
  render(
    <I18nProvider>
      <FeatureLabDialog
        open
        botName="Cahier2"
        disabledReason={disabledReason}
        onClose={() => {}}
        onLaunch={onLaunch}
      />
    </I18nProvider>,
  );
}

describe("laboratoire de scénarios", () => {
  test("propose quatre cas et lance seulement le scénario sélectionné", () => {
    let prompt = "";
    renderLab((next) => { prompt = next; });

    expect(screen.getByRole("dialog", { name: "Tester Cahier2" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Lancer le scénario" }).parentElement?.className).toContain("flex-row");

    fireEvent.click(screen.getByRole("button", { name: "Lancer le scénario" }));
    expect(prompt).toContain("outil `execute_code`");
    expect(prompt).not.toContain("outil terminal");

    const question = screen.getByRole("radio", { name: /Question interactive/ });
    fireEvent.click(question);
    expect(question.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Lancer le scénario" }));
    expect(prompt).toContain("@user");
    expect(prompt).not.toContain("utilise ask_user");

    const plan = screen.getByRole("radio", { name: /Plan multi-étapes/ });
    fireEvent.click(plan);
    fireEvent.click(screen.getByRole("button", { name: "Lancer le scénario" }));
    expect(prompt).toContain("outil `todo`");
  });

  test("reste consultable mais bloque le lancement pendant un run", () => {
    renderLab(() => {}, "Le bot termine déjà une demande.");
    expect(screen.getByText("Le bot termine déjà une demande.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Lancer le scénario" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
