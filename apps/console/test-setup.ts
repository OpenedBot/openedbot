import { afterEach } from "bun:test";
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PRO_CONSOLE_VIRTUAL_ID, proConsoleEntries, proConsoleModuleSource } from "./vite-pro-console";

/**
 * `virtual:openedbot-pro-console` as Vite builds it (`vite-pro-console.ts`):
 * `OPENEDBOT_CONSOLE_PLUGINS` empty is a solo console, the pro pass of `make test-dual`
 * lists the pro modules. They import the console's host surface as
 * `@openedbot/console/*`, which the external plug-in checkout links to `src/pro-console`
 * (`make link-core` there).
 */
plugin({
  name: "openedbot-pro-console",
  setup(build) {
    build.module(PRO_CONSOLE_VIRTUAL_ID, () => ({
      contents: proConsoleModuleSource(proConsoleEntries(process.env.OPENEDBOT_CONSOLE_PLUGINS)),
      loader: "js",
    }));
  },
});

// A DOM before React is imported: otherwise `react-dom/client` binds to
// an environment without `document` and the render tests cannot mount.
GlobalRegistrator.register();

/**
 * `window.localStorage` is a single happy-dom object shared by ALL the
 * test files of one `bun test` run, not only within
 * a file: measured with L7: a test that switches the language to English
 * left `connectors.test.tsx`, run afterwards, starting in English while
 * it looked for its assertions in French. A global `afterEach` is the
 * only place that covers every file, present and to come.
 */
afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // Nothing to clean if storage is not available in this test.
  }
});

/**
 * `matchMedia` is not implemented by happy-dom.
 *
 * Three pieces of the shell read it on the first render: resolution of the
 * `system` theme, `useIsMobile`, and the reduced-motion preference. Without this
 * stub, rendering breaks for a reason that has nothing to do with the code
 * under test.
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

// Recharts measures its container; happy-dom does not provide ResizeObserver.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// The dictionaries are no longer in the initial bundle (`@openedbot/browser-i18n`,
// one chunk per language): the provider shows nothing until the language is
// loaded. Tests render synchronously: both are loaded here.
{
  const { loadLocale } = await import("@openedbot/browser-i18n");
  await Promise.all([loadLocale("fr"), loadLocale("en")]);
}
