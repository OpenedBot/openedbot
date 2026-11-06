import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESKTOP_FOCUS_CSS, DESKTOP_FOCUS_STYLE_ATTRIBUTE, hideFocusRings } from "../../../src/lib/platform/desktop-focus";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "../../..", path), "utf8");

afterEach(() => {
  for (const style of document.head.querySelectorAll(`style[${DESKTOP_FOCUS_STYLE_ATTRIBUTE}]`)) style.remove();
});

describe("l'app de bureau ne montre aucun focus", () => {
  test("la feuille se pose une fois et ne retire que le focus", () => {
    hideFocusRings(document);
    hideFocusRings(document);
    const styles = document.head.querySelectorAll(`style[${DESKTOP_FOCUS_STYLE_ATTRIBUTE}]`);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(DESKTOP_FOCUS_CSS);
    // Le contour natif (WebKit) et la bordure du composer au focus ; rien sur le survol ni la sélection.
    expect(DESKTOP_FOCUS_CSS).toContain(":is(:focus, :focus-visible, :focus-within)");
    expect(DESKTOP_FOCUS_CSS).toContain("outline: none !important");
    expect(DESKTOP_FOCUS_CSS).toContain("[data-composer-shell]:focus-within");
    expect(DESKTOP_FOCUS_CSS).not.toMatch(/:hover|aria-selected|data-state|aria-invalid/);
    // Le focus reste : rien ne le désactive.
    expect(DESKTOP_FOCUS_CSS).not.toMatch(/pointer-events|tabindex|display:\s*none/);
  });

  test("seul le build desktop l'installe, à la place du suivi du clavier qui rend l'anneau au web", () => {
    const main = read("src/main.tsx");
    expect(main).toContain('if (import.meta.env.VITE_OPENEDBOT_SHELL === "tauri") hideFocusRings();\nelse trackKeyboardFocus();');
    // Ni fichier CSS du bundle, ni import de feuille : le build web n'en garde rien.
    expect(read("src/styles/globals.css")).not.toContain("desktop-focus");
    expect(read("src/lib/platform/desktop-focus.ts")).not.toMatch(/import .*\.css/);
  });

  test("les anneaux restants attendent tous `data-keyboard-focus`, que le bureau ne pose jamais", () => {
    const appCss = read("../../browser/ui-kit/src/styles/app.css");
    expect(appCss).toContain("@custom-variant focus-visible (&:is(:root[data-keyboard-focus] *):focus-visible);");
    expect(appCss).toContain("@custom-variant focus-within (&:is(:root[data-keyboard-focus] *):focus-within);");
  });
});
