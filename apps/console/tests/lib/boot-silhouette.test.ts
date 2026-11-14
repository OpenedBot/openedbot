import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The first inline script of index.html: theme, text size, then the boot
// silhouette, before the first paint (no module has run yet).
const html = readFileSync(path.resolve(import.meta.dir, "../../index.html"), "utf8");
const inline = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "";
const run = () => new Function(inline)();
const root = document.documentElement;
const ATTRIBUTES = ["data-openedbot-booting", "data-openedbot-boot-titlebar", "data-openedbot-text-zoom"];

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
    // The web build trusts only `__OPENEDBOT_SHELL__` (`native-bridge.ts`).
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

/*
 * The silhouette copies the app's tokens because no stylesheet is loaded yet.
 * When a copy drifts, the frame, the thread lane or the composer jumps the
 * moment React replaces the silhouette (a reload of a thread showed it).
 */
describe("silhouette de démarrage : jetons recopiés", () => {
  const css = (file: string) => readFileSync(path.resolve(import.meta.dir, "../../src/styles/components", file), "utf8");
  // The first `selector {…}` block, then one custom property inside it.
  const block = (source: string, selector: string) => {
    const start = source.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return source.slice(start, source.indexOf("}", start));
  };
  const token = (scope: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`, "u").exec(scope)?.[1]?.trim();
  const boardui = css("boardui.css");
  const theme = css("thread-theme.css");
  const timeline = css("thread-timeline.css");

  test("la taille choisie agit avant le CSS de l'app, avec la même règle racine", () => {
    const boot = block(html, ":root");
    const loaded = block(css("text-size.css"), ":root");
    expect(token(boot, "font-size")).toBe(token(loaded, "font-size"));
    expect(token(boot, "font-size")).toContain("--openedbot-text-scale");
  });

  for (const [mode, bootSelector, appSelector] of [
    ["clair", "html[data-openedbot-booting] #openedbot-boot", ":root"],
    ["sombre", "html.dark[data-openedbot-booting] #openedbot-boot", ".dark"],
  ] as const) {
    test(`thème ${mode} : cadre, cartes, fil et composer`, () => {
      const boot = block(html, bootSelector);
      const pairs: Array<[string, string, string]> = [
        ["--boot-full", boardui, "--bui-background-full"],
        ["--boot-surface", boardui, "--bui-background-secondary-default"],
        ["--boot-stream", theme, "--stream-base"],
        ["--boot-composer", theme, "--stream-composer"],
        ["--boot-composer-shadow", theme, "--stream-composer-shadow"],
        ["--boot-composer-edge", theme, "--stream-line"],
        ["--boot-composer-fill", theme, "--stream-fill"],
      ];
      for (const [bootName, source, appName] of pairs) {
        expect({ [bootName]: token(boot, bootName) }).toEqual({ [bootName]: token(block(source, appSelector), appName) });
      }
    });
  }

  test("le couloir du fil a la largeur de `--openedbot-thread-column`", () => {
    const lane = token(block(timeline, "[data-thread-column]"), "--openedbot-thread-column");
    expect(lane).toBeDefined();
    expect(token(block(html, "html[data-openedbot-booting] #openedbot-boot"), "--boot-column")).toBe(lane);
  });
});

// Rail shell: no icon rail; the cards start 12 px from the top and the boot
// script files the rail's markup into the conversations card (head, foot).
test("la silhouette à rail range la tête et le pied dans la carte, comme l'app", () => {
  expect(html).toMatch(/\[data-openedbot-boot-rail\] #openedbot-boot \{\s*padding-block-start: 0.75rem;/);
  expect(html).toMatch(/\[data-openedbot-boot-rail\] #openedbot-boot > \.bar \{\s*position: absolute;\s*inset-block-start: 0.75rem;\s*inset-inline: calc\(272px \+ 0.75rem\) 0.75rem;/);
  root.setAttribute("data-openedbot-boot-rail", "");
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/u.exec(html)![1]!.replace(/<script>[\s\S]*?<\/script>/gu, "");
  const boot = document.getElementById("openedbot-boot")!;
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!).find((code) => code.includes(`"rhead"`))!;
  try {
    new Function(script)();
    const card = boot.querySelector(".side .card")!;
    expect(card.firstElementChild!.className).toBe("rhead");
    // The search glass and the « + »; the collapse stays in the bar, left of the breadcrumb.
    expect([...card.querySelectorAll(".rhead .grp b")].map((button) => button.className)).toEqual(["search", "create"]);
    expect(boot.querySelector(".bar > .ico")).toBeTruthy();
    expect(card.lastElementChild!.className).toBe("rfoot");
    expect(card.querySelectorAll(".rfoot .quota")).toHaveLength(3);
  } finally {
    root.removeAttribute("data-openedbot-boot-rail");
    document.body.innerHTML = "";
  }
});
