import { afterEach } from "bun:test";
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PRO_CONSOLE_VIRTUAL_ID, proConsoleEntries, proConsoleModuleSource } from "./vite-pro-console";

/**
 * `virtual:ohb-pro-console` as Vite builds it (`vite-pro-console.ts`):
 * `OPENEDBOT_CONSOLE_PLUGINS` empty is a solo console, the pro pass of `make test-dual`
 * lists the pro modules. They import the console's host surface as
 * `@openedbot/console/*`, which the external plug-in checkout links to `src/pro-console`
 * (`make link-core` there).
 */
plugin({
  name: "ohb-pro-console",
  setup(build) {
    build.module(PRO_CONSOLE_VIRTUAL_ID, () => ({
      contents: proConsoleModuleSource(proConsoleEntries(process.env.OPENEDBOT_CONSOLE_PLUGINS)),
      loader: "js",
    }));
  },
});

// Un DOM avant que React ne soit importé : sinon `react-dom/client` se lie à
// un environnement sans `document` et les tests de rendu ne peuvent pas monter.
GlobalRegistrator.register();

/**
 * `window.localStorage` est un unique objet happy-dom partagé par TOUS les
 * fichiers de test d'une même exécution `bun test`, pas seulement au sein
 * d'un fichier : measuré avec L7 : un test qui bascule la langue en anglais
 * laissait `connectors.test.tsx`, exécuté ensuite, démarrer en anglais alors
 * qu'il cherchait ses assertions en français. Un `afterEach` global est le
 * seul endroit qui couvre tous les fichiers, présents et à venir.
 */
afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // Rien à nettoyer si le stockage n'est pas disponible dans ce test.
  }
});

/**
 * `matchMedia` n'est pas implémenté par happy-dom.
 *
 * Trois éléments de la coque le lisent au premier rendu : la résolution du
 * thème `system`, `useIsMobile`, et la préférence de mouvement réduit. Sans ce
 * bouchon, le rendu casse pour une raison qui n'a rien à voir avec le code
 * qu'on teste.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// Recharts mesure son conteneur ; happy-dom ne fournit pas ResizeObserver.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Les dictionnaires ne sont plus dans le paquet initial (`@openedbot/browser-i18n`,
// un chunk par langue) : le provider n'affiche rien tant que la langue n'est
// pas chargée. Les tests rendent de façon synchrone : les deux sont chargés ici.
{
  const { loadLocale } = await import("@openedbot/browser-i18n");
  await Promise.all([loadLocale("fr"), loadLocale("en")]);
}
