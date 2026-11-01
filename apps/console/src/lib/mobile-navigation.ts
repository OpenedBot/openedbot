/**
 * La géométrie de navigation de la coque mobile : hors React, pour que la
 * coque, l'en-tête et les tests partagent la même règle.
 *
 * Le modèle est le mode `sidebar` / `assistant` de `template-mobile-rn` :
 * un drawer (le panneau des conversations) sous une scène qui glisse, et une
 * pile pour les écrans de détail. Ici la pile ne concerne que les réglages :
 * `/settings` est un écran du drawer, `/settings/<rubrique>` est poussé
 * au-dessus et revient par « Retour ». Les conversations (`/bot/`, `/cs/`, `/g/`),
 * l'aperçu et la boîte « À traiter » sont des écrans du drawer : on passe
 * de l'un à l'autre par le panneau, jamais par une pile. Le journal des
 * décisions vit dans les réglages (`/settings/decisions`).
 */

/** Le point de rupture de `useIsMobile` : un téléphone ou une fenêtre étroite. */
export const MOBILE_BREAKPOINT = 768;

/** Largeur du panneau, celle du template (310 pt), bornée sur les petits écrans. */
export const DRAWER_WIDTH = 310;
export const DRAWER_MAX_VIEWPORT_RATIO = 0.84;

/**
 * Zone de bord qui ouvre le panneau au geste (template : `swipeEdgeWidth: 48`).
 *
 * UNE seule valeur, et c'est important : la bande qui reçoit le `pointerdown`
 * et l'heuristique du `touchmove` non passif doivent parler du même bord. Tant
 * qu'elles divergeaient (24 px pour la bande, 40 px pour l'heuristique), la
 * frange entre les deux volait le scroll, `preventDefault` y passait, sans
 * qu'aucun drag ne démarre : le doigt ne scrollait plus ET n'ouvrait rien.
 */
export const DRAWER_EDGE_WIDTH = 40;
/** Sous ce seuil, le doigt n'a pas encore choisi entre scroll et swipe. */
export const EDGE_GESTURE_SLOP = 8;
/** Vitesse (px/ms) qui emporte la décision quand la course est du même côté. */
export const FLING_VELOCITY = 0.35;

/**
 * Le listener natif `touchmove` (non passif) ne doit voler le geste que
 * quand c'est vraiment un balayage horizontal. Un scroll vertical qui
 * commence près du bord gauche, les bulles y vivent, doit rester un
 * scroll, sinon le fil PWA est figé.
 */
export function edgeSwipePreventsScroll(input: {
  fromEdge: boolean;
  captured: boolean;
  aborted: boolean;
  dx: number;
  dy: number;
}): boolean {
  if (input.aborted) return false;
  if (!input.fromEdge && !input.captured) return false;
  if (input.fromEdge && !input.captured) {
    if (Math.abs(input.dy) > EDGE_GESTURE_SLOP && Math.abs(input.dy) > Math.abs(input.dx)) {
      return false;
    }
    if (Math.abs(input.dx) < EDGE_GESTURE_SLOP) return false;
  }
  return true;
}

/**
 * Décide si le tiroir s'ouvre au pointerup. Un jitter de lift vers la
 * gauche ne referme plus une course déjà à mi-chemin : `flungClosed`
 * gagnait tout seul et snap-close un swipe à 80 %.
 */
export function decideDrawerOpen(input: {
  position: number;
  width: number;
  velocity: number;
}): boolean {
  if (input.velocity > FLING_VELOCITY) return true;
  if (input.velocity < -FLING_VELOCITY && input.position <= input.width / 2) {
    return false;
  }
  return input.position > input.width / 2;
}

export type DrawerPathChange = "restore" | "keep-open" | "close";

/**
 * Ce que fait le tiroir quand `pathname` change.
 *
 * `held` est le chemin tenu depuis un toucher sur la bande de bord ; `popped`
 * dit qu'un `popstate` est arrivé pendant qu'il était tenu : la signature du
 * « Retour » de Safari qui confisque le geste. Un push (lien tapé, hamburger
 * puis roster) n'est jamais annulé, tenu ou pas.
 */
export function drawerPathChange(input: {
  held: string | null;
  pathname: string;
  popped: boolean;
}): DrawerPathChange {
  if (input.held === null) return "close";
  if (input.held === input.pathname) return "keep-open";
  return input.popped ? "restore" : "close";
}

export function drawerWidthFor(viewportWidth: number): number {
  return Math.min(DRAWER_WIDTH, Math.round(viewportWidth * DRAWER_MAX_VIEWPORT_RATIO));
}

/** Les routes qui vivent HORS de la coque mobile : elles ont leur propre plein écran. */
export function isMobileShellPath(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/onboarding") return false;
  if (pathname === "/legal" || pathname.startsWith("/legal/")) return false;
  return true;
}

/**
 * Profondeur dans la pile mobile : 0 pour un écran du drawer, 1 pour une
 * rubrique de réglages poussée au-dessus.
 */
/** `/settings` et ses rubriques (`/settings/team`), hors préfixe `/o/<slug>` déjà réécrit. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

export function mobileRouteDepth(pathname: string): number {
  return /^\/settings\/[^/]+/u.test(pathname) ? 1 : 0;
}

/** La destination du bouton « Retour », ou `null` quand l'en-tête porte le menu. */
export function mobileBackTarget(pathname: string): string | null {
  return mobileRouteDepth(pathname) > 0 ? "/settings" : null;
}

export type MobileTransition = "push" | "pop";

/**
 * Le sens de la transition entre deux emplacements : `push` vers un écran
 * plus profond, `pop` vers la surface, rien entre deux écrans du drawer (le
 * panneau qui se referme est déjà l'animation).
 */
export function mobileTransition(from: string | undefined, to: string): MobileTransition | null {
  if (from === undefined) return null;
  const delta = mobileRouteDepth(to) - mobileRouteDepth(from);
  if (delta > 0) return "push";
  if (delta < 0) return "pop";
  return null;
}
