import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { activateLocale, FALLBACK_LOCALE, isLocaleLoaded, loadLocale, readInitialLocale } from "@openedbot/browser-i18n";
import { ThemeProvider, paintStoredTheme } from "@openedbot/browser-ui-kit/theme";
import { I18nProvider } from "./lib/i18n";
import { queryClient } from "./lib/query-client";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { retireLegacyServiceWorker } from "./lib/platform/legacy-service-worker";
import { router } from "./route-tree";
import { dropLoginBoot, hasLoginBoot } from "./screens/auth/login-boot";
import { applyNativeTitlebar } from "./lib/platform/native-titlebar";
import { trackKeyboardFocus } from "./lib/shell/keyboard-focus";
import { hideFocusRings } from "./lib/platform/desktop-focus";
import { applyStoredTextSize } from "./lib/shell/text-size";
import "./styles/globals.css";

// Before any render: `<html>` already carries the right class when React mounts,
// so no visible theme switch. Must stay ordinary called code,
// never a source passed to `eval`.
paintStoredTheme();

// Native macOS shell without a title bar: the traffic-light slot and the
// window drag handle are placed before the first paint (see
// `lib/platform/native-titlebar.ts`). Without the shell, this does nothing.
applyNativeTitlebar();

// No focus ring or border that appears on its own (autoFocus,
// dialog, closed menu, return to the window); on the web, Tab shows it
// (`lib/shell/keyboard-focus.ts`). The desktop app never shows one, even
// from the keyboard (`lib/platform/desktop-focus.ts`).
if (import.meta.env.VITE_OPENEDBOT_SHELL === "tauri") hideFocusRings();
else trackKeyboardFocus();

// Text size (Appearance): the native shell zooms the window from
// load, before React paints (see `lib/shell/text-size.ts`).
applyStoredTextSize();

// The console is no longer a PWA: a service worker left over from the old
// version is unregistered (see `lib/platform/legacy-service-worker.ts`).
retireLegacyServiceWorker();

// The frame silhouette (`#openedbot-boot`, `index.html`) covers the page until the
// router's first render: session guards passed, the real page painted
// underneath. Removing it earlier put the white screen back between the loaded
// JS and the resolved guards. A stale shell (index.html precached by the
// service worker) carried the old splash under the same id: same exit.
// The deadline covers a router that would never render (exception at startup).
const BOOT_FALLBACK_MS = 10_000;
function endBoot() {
  document.getElementById("openedbot-boot")?.remove();
  document.documentElement.removeAttribute("data-openedbot-booting");
}
if (document.getElementById("openedbot-boot")) {
  // `onResolved` AND `onRendered`: the second is emitted only if the React
  // transition confirms its render, which does not happen on the first load
  // (measured: the silhouette stayed until the deadline). The first of the two
  // is enough: the guards have passed and the matches are committed.
  const stops: Array<() => void> = [];
  const done = () => {
    for (const stop of stops.splice(0)) stop();
    // One frame later: React's page is painted before the veil
    // drops. `requestAnimationFrame` does not run in a hidden tab: the
    // short timeout takes over, otherwise the silhouette would stay there for 10 s.
    requestAnimationFrame(endBoot);
    window.setTimeout(endBoot, 100);
  };
  stops.push(router.subscribe("onResolved", done), router.subscribe("onRendered", done));
  window.setTimeout(endBoot, BOOT_FALLBACK_MS);
}

// The `/login` mascot (`#openedbot-boot-login`) is the login screen's to
// take over. Anywhere else (a session sends `/login` on to the app), it goes
// at the first resolution; the deadline covers a screen that never mounts.
if (hasLoginBoot()) {
  const stop = router.subscribe("onResolved", ({ toLocation }) => {
    stop();
    if (!/^\/login\/?$/.test(toLocation.pathname)) dropLoginBoot();
  });
  window.setTimeout(() => {
    if (hasLoginBoot()) dropLoginBoot();
  }, BOOT_FALLBACK_MS);
}

// Thread perf HUD: dev only, and further gated behind `?perf=1` inside the
// module itself. The dynamic import keeps `thread-perf-hud.tsx` (and its
// probe) out of a production bundle entirely. `=== true`: Bun maps `import.meta.env` to `process.env`
// (strings) where Vite injects a boolean; a `DEV=1` env var must not open it.
if (import.meta.env.DEV === true) {
  import("./components/dev/thread-perf-hud").then(({ mountThreadPerfHud }) => mountThreadPerfHud());
}

async function renderConsole() {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root introuvable");
  // Only the active language ships on the critical path (`@openedbot/browser-i18n`,
  // one chunk per locale). A chunk that fails to load falls back to French,
  // never to a blank page.
  const initialLocale = readInitialLocale();
  await loadLocale(initialLocale).catch(() => loadLocale(FALLBACK_LOCALE)).catch(() => undefined);
  if (isLocaleLoaded(initialLocale)) activateLocale(initialLocale);
  else if (isLocaleLoaded(FALLBACK_LOCALE)) activateLocale(FALLBACK_LOCALE);

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <I18nProvider>
            {/* The equivalent of `global-error.tsx`: the router catches what
                breaks INSIDE a screen, this boundary catches what breaks around
                it: the shell, a provider, the palette. It sits under I18nProvider
                so its screen speaks the operator's language. */}
            <AppErrorBoundary>
              <RouterProvider router={router} />
            </AppErrorBoundary>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void renderConsole().catch((error: unknown) => {
  console.error("Unable to load the selected interface language", error);
});
