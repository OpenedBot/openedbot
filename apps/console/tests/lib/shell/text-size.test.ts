import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { applyStoredTextSize, setTextSize, TEXT_SCALE_PROPERTY, TEXT_ZOOM_ATTRIBUTE } from "../../../src/lib/shell/text-size";

const STORAGE_KEY = "openedbot:settings-text-size";
const root = document.documentElement;
const scale = () => root.style.getPropertyValue(TEXT_SCALE_PROPERTY);

afterEach(() => {
  delete window.__OPENEDBOT_SHELL__;
  root.removeAttribute(TEXT_ZOOM_ATTRIBUTE);
  root.style.removeProperty(TEXT_SCALE_PROPERTY);
});

describe("taille du texte dans un navigateur", () => {
  test("un choix s'applique à toute la page, tout de suite, et reste sur l'appareil", () => {
    setTextSize(11);
    expect(scale()).toBe(String(11 / 14));
    expect(root.getAttribute(TEXT_ZOOM_ATTRIBUTE)).toBe(String(11 / 14));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("11");

    // A reload: only the stored value is left.
    root.style.removeProperty(TEXT_SCALE_PROPERTY);
    applyStoredTextSize(document);
    expect(scale()).toBe(String(11 / 14));
  });

  test("une valeur inconnue revient à 14 px, l'échelle 1", () => {
    localStorage.setItem(STORAGE_KEY, "9");
    applyStoredTextSize(document);
    expect(scale()).toBe("1");
  });

  test("un autre onglet change la taille : la page la suit", () => {
    applyStoredTextSize(document);
    localStorage.setItem(STORAGE_KEY, "12");
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(scale()).toBe(String(12 / 14));
  });
});

describe("taille du texte dans l'app de bureau", () => {
  test("la coque zoome la fenêtre : la page ne réduit rien de plus", () => {
    window.__OPENEDBOT_SHELL__ = { platform: "macos", version: "1.1.0", bridgeVersion: 2 };
    root.style.setProperty(TEXT_SCALE_PROPERTY, "0.5");
    setTextSize(12);
    expect(root.getAttribute(TEXT_ZOOM_ATTRIBUTE)).toBe(String(12 / 14));
    expect(scale()).toBe("");
  });
});

describe("index.html, avant la première peinture", () => {
  // The first inline script, like `boot-silhouette.test.ts`.
  const html = readFileSync(path.resolve(import.meta.dir, "../../../index.html"), "utf8");
  const inline = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "";
  const run = () => new Function(inline)();

  test("pose ce que pose text-size.ts : même défaut, même échelle", () => {
    run();
    expect(root.getAttribute(TEXT_ZOOM_ATTRIBUTE)).toBe("1");
    expect(scale()).toBe("1");
    localStorage.setItem(STORAGE_KEY, "10");
    run();
    expect(scale()).toBe(String(10 / 14));
  });

  test("dans la coque de bureau, seulement le facteur de zoom", () => {
    window.__OPENEDBOT_SHELL__ = { platform: "linux", version: "1.1.0", bridgeVersion: 2 };
    localStorage.setItem(STORAGE_KEY, "13");
    run();
    expect(root.getAttribute(TEXT_ZOOM_ATTRIBUTE)).toBe(String(13 / 14));
    expect(scale()).toBe("");
  });
});

describe("text-size.css", () => {
  const src = path.resolve(import.meta.dir, "../../../src");
  // The design system's components are compiled with the console's (`@source` of `browser/ui-kit`).
  const uiKit = path.resolve(import.meta.dir, "../../../../../browser/ui-kit/src");
  const css = readFileSync(path.join(src, "styles/components/text-size.css"), "utf8");
  // Markdown samples of the dev thread lab: `prose-*` variants, not text of the app.
  const EXEMPT = new Set(["prose-h2:text-[17px]", "prose-h3:text-[15px]"]);

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.(tsx?|css)$/u.test(name) ? [full] : [];
    });
  }

  test("chaque taille en pixels de la console et du design system suit l'échelle", () => {
    const used = new Set<string>();
    for (const file of [...files(src), ...files(uiKit)]) {
      for (const match of readFileSync(file, "utf8").matchAll(/(?:[a-z0-9-]+:)*(?:text|leading)-\[[0-9.]+px\]/gu)) used.add(match[0]);
    }
    expect(used.size).toBeGreaterThan(0);
    const selector = (name: string) => `.${name.replace(/[:.[\]]/gu, (char) => `\\${char}`)} {`;
    const missing = [...used].filter((name) => !EXEMPT.has(name) && !css.includes(selector(name)));
    expect(missing).toEqual([]);
  });
});
