import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "@tanstack/react-router";
import { cn, SidebarProvider, Toaster, TooltipProvider, useIsMobile } from "@openedbot/browser-ui-kit";
import { isMobileShellPath, isSettingsPath } from "../lib/mobile-navigation";
import { isIosDevice, isStandaloneDisplay } from "../lib/pwa-display";
import { useVisualViewportInset } from "../lib/use-visual-viewport-height";

/**
 * Les providers de la coque, et rien d'autre.
 *
 * La barre latérale et l'inset sont montés par les routes de layout
 * (`route-tree.tsx`) : les conversations et les réglages n'ont pas la même
 * barre. Les garder ici les figerait, et c'est précisément ce qui laissait la
 * liste des bots affichée dans les réglages.
 *
 * En contrepartie, `SidebarProvider` reste au-dessus des deux modes : l'état
 * plié/déplié survit au passage de l'un à l'autre au lieu d'être réinitialisé.
 *
 * `TooltipProvider` est OBLIGATOIRE ici. `SidebarMenuButton` rend un `Tooltip`
 * dès qu'on lui passe `tooltip`, et notre `sidebar.tsx`, contrairement à
 * celui de shadcn en amont, n'embarque pas le provider : il attend que
 * l'application le fournisse, comme le fait la mise en page racine du bloc.
 * Sans lui, le premier rendu lève « Tooltip must be used within
 * TooltipProvider » et toute l'application tombe.
 *
 * `--header-height` est déclarée ici et non dans la CSS globale parce que la
 * barre latérale s'en sert pour aligner son propre en-tête sur celui du
 * contenu ; les deux doivent lire la même valeur.
 *
 * `h-svh overflow-hidden` remplace le `min-h-svh` de shadcn, et ce n'est pas
 * cosmétique : sans hauteur DÉFINIE, le `flex-1 overflow-y-auto` des corps de
 * page ne s'active jamais, le document déborde, et c'est la fenêtre qui défile.
 * La barre de défilement englobe le `SiteHeader`, qui disparaît vers le haut,
 * alors que la barre latérale, elle, est `fixed h-svh` et reste en place. La
 * coque tient dans le viewport, le défilement appartient au corps de page.
 *
 * Sur un téléphone (`useIsMobile`, hors `/login`, `/onboarding`, `/legal`),
 * la coque mobile prend le relais : PAS de marges de zone sûre ici. C'est
 * l'en-tête (`MobileHeader`) et le composer qui peignent jusque sous la barre
 * d'état et l'indicateur d'accueil, avec leur propre `env(safe-area-inset-*)`,
 * comme une barre de navigation native. La CSS pose `100dvh` sur html dans un
 * onglet et `100vh` dans une PWA iOS installée (WebKit #254868) ; la coque
 * fait `height: 100%`. Un parent `100%` trop court rognait le composer sur
 * l'indicateur d'accueil. `/login` et `/onboarding` (téléphone) n'héritent
 * plus du padding safe-area du shell bureau : ils le posent eux-mêmes.
 * Quand le clavier est déployé, la géométrie mesurée du `visualViewport`
 * remplace les deux (`useVisualViewportInset`) : hauteur + `offsetTop`,
 * sinon Safari laisse un trou entre le composer et le clavier.
 */
export function Shell({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const mobileShell = isMobile && isMobileShellPath(pathname);
  // Stables pendant la session : le mode standalone ne change qu'après une
  // nouvelle ouverture, et les figer évite une divergence au premier paint.
  const [standalone] = useState(isStandaloneDisplay);
  const [ios] = useState(isIosDevice);
  const keyboardInset = useVisualViewportInset(mobileShell);
  useRootShellAttributes(mobileShell, standalone, ios);
  // Les réglages bureau sont une modale centrée : le toast se pose sous elle,
  // au centre. Ailleurs, le coin bas droit d'affectUI.
  const toastPosition = isSettingsPath(pathname) ? "bottom-center" : "bottom-right";
  return (
    <TooltipProvider>
      {/* Keep the iOS scroll-edge backing outside the keyboard-transformed shell. */}
      {mobileShell && standalone && ios
        ? createPortal(<div aria-hidden data-mobile-status-edge="" />, document.body)
        : null}
      <SidebarProvider
        data-shell={mobileShell ? "mobile" : "desktop"}
        data-pwa-standalone={standalone ? "" : undefined}
        data-ios-device={ios ? "" : undefined}
        data-keyboard-open={mobileShell && keyboardInset !== null ? "" : undefined}
        className={cn(
          // Desktop: `clip`, not `hidden`. A hidden box is still a scroll
          // container: a `scrollIntoView` or a focus deep in the thread
          // scrolled the whole frame (Firefox, the desktop shell), the
          // sidebar cut on the left and the top bar out of view. A clipped
          // box cannot scroll at all.
          mobileShell || isMobile ? "overflow-hidden" : "overflow-clip",
          mobileShell
            ? "min-h-0 h-full bg-sidebar"
            : isMobile
              ? "min-h-0 h-full"
              : "h-svh pt-[var(--ohb-safe-top)] pr-[var(--ohb-safe-right)] pb-[var(--ohb-safe-bottom)] pl-[var(--ohb-safe-left)]",
        )}
        style={
          {
            // 260 px, la largeur du rail amont : 288 px poussait la colonne
            // de lecture hors de son axe sur un portable.
            "--sidebar-width": "260px",
            "--header-height": "calc(var(--spacing) * 12)",
            ...(keyboardInset !== null
              ? {
                  height: `${keyboardInset.height}px`,
                  minHeight: `${keyboardInset.height}px`,
                  transform:
                    keyboardInset.offsetTop !== 0
                      ? `translateY(${keyboardInset.offsetTop}px)`
                      : undefined,
                }
              : {}),
          } as CSSProperties
        }
      >
        {children}
        <Toaster position={toastPosition} />
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * Recopie le mode de la coque sur `<html>` (`data-ohb-shell`,
 * `data-ohb-pwa-standalone`, `data-ohb-ios-device`) pour `mobile.css`.
 *
 * La CSS lisait `html:has([data-shell="mobile"]) ...` : un `:has()` sur la
 * racine oblige Chrome à revalider le style de tout le document à CHAQUE
 * mutation du DOM. Mesuré le 2026-10-05 sur un long fil (3 100 nœuds) :
 * ~50 ms de style par mutation, et un graphique Recharts qui mesure ses
 * libellés un par un montait à plusieurs secondes. Un attribut sur la racine
 * coûte un sélecteur simple. Noms distincts de ceux de la coque : les passes
 * PWA lisent `document.querySelector("[data-shell]")`.
 */
function useRootShellAttributes(mobileShell: boolean, standalone: boolean, ios: boolean): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-ohb-shell", mobileShell ? "mobile" : "desktop");
    root.toggleAttribute("data-ohb-pwa-standalone", standalone);
    root.toggleAttribute("data-ohb-ios-device", ios);
    return () => {
      root.removeAttribute("data-ohb-shell");
      root.removeAttribute("data-ohb-pwa-standalone");
      root.removeAttribute("data-ohb-ios-device");
    };
  }, [mobileShell, standalone, ios]);
}
