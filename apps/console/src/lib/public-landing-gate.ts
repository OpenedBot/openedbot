/**
 * Les portes de la racine.
 *
 * La page publique a quitté la console : elle vit sur le site public
 * (`lib/public-site.ts`). `/` est l'application, sur tous les hôtes, dans un
 * onglet comme dans la coque native : l'aperçu, que le routeur ouvre sur
 * `/o/<slug>/`. `/home` est son entrée sans organisation connue. Sans session,
 * la coque `_app` renvoie vers `/login` (`resolveAppFrameEntry`). Rien ici ne
 * dépend de l'hôte ni de l'agent utilisateur : la même build sert l'hôte de la
 * console et le domaine nu pendant la transition.
 */
import { isAppAuthenticated, type AuthStatus } from "./auth-status";
import { APP_HOME_HREF } from "./workspace-location";

export { APP_HOME_HREF };

/**
 * Réécriture d'entrée de la racine, avant celle des espaces de travail :
 * `/` et `/home` ouvrent l'aperçu (`/` interne). `null` : l'URL n'est pas une
 * des portes, la suite décide.
 *
 * `addressPath` est le chemin de la barre d'adresse. Un `/` qui n'y est pas
 * est l'aperçu INTERNE qu'une entrée masquée de l'historique rejoue. La
 * surcouche des réglages (`app-frame.tsx`) garde l'emplacement réel dans
 * `__tempLocation`, dont TanStack re-parse le `href` interne à travers cette
 * réécriture au retour, à l'avant et au rechargement : il passe à la
 * réécriture des espaces de travail.
 */
export function rootRewriteInput(url: URL, addressPath: string): URL | null {
  if (url.pathname === "/" && addressPath !== "/") return null;
  if (url.pathname !== "/" && url.pathname !== APP_HOME_HREF) return null;
  const next = new URL(url);
  next.pathname = "/";
  return next;
}

/** Réécriture de sortie : l'aperçu sans organisation s'affiche `/home`. */
export function rootRewriteOutput(pathname: string, organizationId: string | null): string | null {
  if (pathname === "/" && !organizationId) return APP_HOME_HREF;
  return null;
}

export type AppFrameEntry = { kind: "app" } | { kind: "login"; reason: string | null };

/**
 * Ce que la coque `_app` fait d'une fenêtre à son entrée : pas de session veut
 * dire `/login`. Un cloud API qui ne répond pas (`unknown`) est traité comme
 * l'absence de session.
 */
export function resolveAppFrameEntry(status: AuthStatus): AppFrameEntry {
  if (isAppAuthenticated(status)) return { kind: "app" };
  return { kind: "login", reason: status.reason };
}
