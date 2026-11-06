import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The first inline script of index.html: theme, text size, then the boot
// silhouette, before the first paint (no module has run yet).
const html = readFileSync(path.resolve(import.meta.dir, "../../index.html"), "utf8");
const inline = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "";
const run = () => new Function(inline)();
const root = document.documentElement;
const ATTRIBUTES = ["data-openedbot-booting", "data-openedbot-boot-titlebar", "data-openedbot-boot-fleet", "data-openedbot-boot-fleet-client", "data-openedbot-text-zoom"];

afterEach(() => {
  delete window.__OPENEDBOT_SHELL__;
  delete window.__OPENEDBOT_NATIVE__;
  localStorage.clear();
  for (const name of ATTRIBUTES) root.removeAttribute(name);
});

describe("silhouette de démarrage", () => {
  test("l'app Tauri : la coque est vue avant que le pont existe (D3)", () => {
    expect(inline).toContain("__OPENEDBOT_SHELL__");
    window.__OPENEDBOT_SHELL__ = { platform: "macos", version: "1.1.0", bridgeVersion: 2 };
    run();
    expect(root.hasAttribute("data-openedbot-booting")).toBe(true);
    expect(root.getAttribute("data-openedbot-boot-titlebar")).toBe("mac");
  });

  test("sous Linux, la coque Tauri garde la barre du système", () => {
    window.__OPENEDBOT_SHELL__ = { platform: "linux", version: "1.1.0", bridgeVersion: 2 };
    run();
    expect(root.hasAttribute("data-openedbot-booting")).toBe(true);
    expect(root.hasAttribute("data-openedbot-boot-titlebar")).toBe(false);
  });

  test("un pont posé par la page hôte, sans coque, reste un navigateur", () => {
    // Le build web ne fait confiance qu'à `__OPENEDBOT_SHELL__` (`native-bridge.ts`).
    window.__OPENEDBOT_NATIVE__ = { shell: { platform: "windows", version: "1.0.3" } } as unknown as Window["__OPENEDBOT_NATIVE__"];
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      run();
      expect(root.hasAttribute("data-openedbot-booting")).toBe(false);
      expect(root.hasAttribute("data-openedbot-boot-titlebar")).toBe(false);
    } finally {
      delete (navigator as { platform?: string }).platform;
    }
  });

  test("un navigateur sans session n'a pas de silhouette", () => {
    run();
    expect(root.hasAttribute("data-openedbot-booting")).toBe(false);
    expect(root.hasAttribute("data-openedbot-boot-titlebar")).toBe(false);
  });
});
