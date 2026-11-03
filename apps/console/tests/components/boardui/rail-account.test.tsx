import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@openedbot/browser-ui-kit";
import { ThemeProvider } from "@openedbot/browser-ui-kit/theme";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../src/lib/i18n";
import { RailLanguageToggle, RailThemeToggle } from "../../../src/components/boardui/rail-account";

const BUTTON = "rail-button";

function mount(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <TooltipProvider>{node}</TooltipProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("le compte à plat dans le rail", () => {
  test("le rail ne monte plus le menu du compte : chaque action y est un bouton", () => {
    const rails = readFileSync(resolve(import.meta.dir, "../../../src/components/boardui/board-rails.tsx"), "utf8");
    expect(rails).not.toContain("AccountMenu");
    for (const control of ["<RailThemeToggle", "<RailLanguageToggle"]) {
      expect(rails).toContain(control);
    }
    expect(rails).not.toContain("RailUsage");
    expect(rails).not.toContain("RailSignOut");
    // Plus d'avatar : le compte s'ouvre par les Réglages.
    expect(rails).not.toContain("RailAccountButton");
    expect(rails).not.toContain("OperatorBlob");
  });

  test("un clic bascule le thème, et le bouton annonce le thème suivant", () => {
    mount(<RailThemeToggle buttonClassName={BUTTON} />);
    const toDark = screen.getByRole("button", { name: "Thème sombre" });
    fireEvent.click(toDark);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: "Thème clair" })).toBeTruthy();
  });

  test("un clic passe à l'autre langue, et le bouton affiche la langue courante", async () => {
    mount(<RailLanguageToggle buttonClassName={BUTTON} />);
    const toEnglish = screen.getByRole("button", { name: "Passer en English" });
    expect(toEnglish.textContent).toBe("fr");
    fireEvent.click(toEnglish);
    // Le catalogue anglais se charge à la demande : la bascule n'est pas synchrone.
    const toFrench = await screen.findByRole("button", { name: "Switch to Français" });
    expect(toFrench.textContent).toBe("en");
  });
});
