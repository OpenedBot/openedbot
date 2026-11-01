import { useRouterState } from "@tanstack/react-router";

/**
 * Où la BULLE du guichet se montre, et où elle se retire.
 *
 * Dans l'application (coque `_app` et réglages), le guichet est une page,
 * `/support`, et chaque écran rend `SiteHeader`, qui porte la porte vers elle
 * (`components/support/support-header-button.tsx`). La bulle y ferait
 * doublon.
 *
 * La bulle ne reste donc que là où il n'y a pas d'en-tête : la page publique
 * (`_app` avec `landing`), `/login`, `/legal/*`, l'onboarding. Un visiteur sans
 * compte doit pouvoir écrire au support sans chercher.
 */

// `/compact` : la fenêtre compacte (DEV-139) n'a ni bulle ni en-tête de guichet.
// `/fleet` and `/fleets`: the fleet frame is part of the application too.
const HEADER_FRAME_ROUTE_IDS: readonly string[] = ["/_app", "/settings", "/compact", "/fleet", "/fleets"];

export const SUPPORT_ROUTE_ID = "/_app/support/{-$conversationId}" as const;

export function isSupportLauncherVisible(routeIds: readonly string[], landing: boolean): boolean {
  if (landing) return true;
  return !routeIds.some((routeId) => HEADER_FRAME_ROUTE_IDS.includes(routeId));
}

/** Vrai quand l'écran est le guichet : sa porte d'en-tête se retire. */
export function isSupportPage(routeIds: readonly string[]): boolean {
  return routeIds.some((routeId) => routeId === SUPPORT_ROUTE_ID);
}

export function useOnSupportPage(): boolean {
  return useRouterState({ select: (state) => isSupportPage(state.matches.map((match) => match.routeId)) });
}
