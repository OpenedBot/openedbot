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
import { applyNativeTitlebar } from "./lib/platform/native-titlebar";
import { trackKeyboardFocus } from "./lib/shell/keyboard-focus";
import { applyStoredTextSize } from "./lib/shell/text-size";
import "katex/dist/katex.min.css";
import "./styles/globals.css";

// Avant tout rendu : `<html>` porte déjà la bonne classe quand React monte,
// donc aucun basculement de thème visible. Doit rester du code appelé
// normalement, jamais une source passée à `eval`.
paintStoredTheme();

// Coque native macOS sans barre de titre : la place des feux tricolores et la
// poignée de la fenêtre sont posées avant le premier paint (voir
// `lib/platform/native-titlebar.ts`). Sans la coque, ne fait rien.
applyNativeTitlebar();

// Pas d'anneau ni de bordure de focus qui apparaît tout seul (autoFocus,
// dialogue, menu fermé, retour dans la fenêtre) ; Tab le rend. Voir
// `lib/shell/keyboard-focus.ts`.
trackKeyboardFocus();

// La taille du texte (Apparence) : la coque native zoome la fenêtre dès le
// chargement, avant que React ne peigne (voir `lib/shell/text-size.ts`).
applyStoredTextSize();

// La console n'est plus une PWA : un service worker resté de l'ancienne
// version est désinscrit (voir `lib/platform/legacy-service-worker.ts`).
retireLegacyServiceWorker();

// La silhouette du cadre (`#ohb-boot`, `index.html`) couvre la page jusqu'au
// premier rendu du routeur : gardes de session passées, vraie page peinte
// dessous. La retirer plus tôt, c'était remettre l'écran blanc entre le JS
// chargé et les gardes résolues. Une coque périmée (index.html précaché par le
// service worker) portait l'ancien splash sous le même id : même sortie.
// L'échéance couvre un routeur qui ne rendrait jamais (exception au démarrage).
const BOOT_FALLBACK_MS = 10_000;
function endBoot() {
  document.getElementById("ohb-boot")?.remove();
  document.documentElement.removeAttribute("data-ohb-booting");
}
if (document.getElementById("ohb-boot")) {
  // `onResolved` ET `onRendered` : le second n'est émis que si la transition
  // React confirme son rendu, ce qui n'arrive pas au premier chargement
  // (mesuré : la silhouette restait jusqu'à l'échéance). Le premier des deux
  // suffit : les gardes sont passées et les matches commités.
  const stops: Array<() => void> = [];
  const done = () => {
    for (const stop of stops.splice(0)) stop();
    // Une image plus tard : la page de React est peinte avant que le voile
    // tombe. `requestAnimationFrame` ne tourne pas dans un onglet masqué : le
    // délai court le relaie, sans quoi la silhouette y resterait 10 s.
    requestAnimationFrame(endBoot);
    window.setTimeout(endBoot, 100);
  };
  stops.push(router.subscribe("onResolved", done), router.subscribe("onRendered", done));
  window.setTimeout(endBoot, BOOT_FALLBACK_MS);
}

// OHB-88 perf HUD: dev only, and further gated behind `?perf=1` inside the
// module itself. The dynamic import keeps `thread-perf-hud.tsx` (and its
// probe) out of a production bundle entirely: see
// `docs/cloud/THREAD_PERF_HUD.md`. `=== true`: Bun maps `import.meta.env` to `process.env`
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
            {/* L'équivalent de `global-error.tsx` : le routeur attrape ce qui
                casse DANS un écran, cette frontière attrape ce qui casse autour
                : le shell, un provider, la palette. Elle est sous I18nProvider
                pour que son écran parle la langue de l'opérateur. */}
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
