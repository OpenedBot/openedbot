/**
 * L'arrivée sur la coque mobile : quel écran ouvre l'app quand on la lance.
 *
 * Sur un téléphone, une app de conversation n'ouvre pas un tableau de bord :
 * elle ouvre un fil. Tant que le registre est vide, `/` reste l'aperçu (il
 * porte le « + Nouveau bot ») ; dès qu'il y a un bot, l'arrivée sélectionne
 * le PREMIER du panneau, celui que le doigt toucherait de toute façon.
 *
 * « Premier » veut dire premier de la colonne du drawer, pas premier du
 * tableau JSON : `board-sidebar.tsx` montre les épinglés d'abord, chaque
 * section triée par activité décroissante. Deux définitions divergentes
 * feraient ouvrir un fil qui n'est pas celui du haut.
 */

import { partitionThreadVisibility } from "@/lib/thread-visibility";
import type { BotDto } from "@openedbot/contracts-api";
import { isMobileShellPath } from "./mobile-navigation";

type RosterBot = Pick<BotDto, "id" | "pinned" | "lastActivityAt" | "archivedAt"> & { hidden?: boolean };

/**
 * Le bot du haut du panneau, ou `null` si le registre courant est vide.
 *
 * Masqués et archivés sortent : ils ne sont pas dans la colonne, donc les
 * ouvrir à l'arrivée mènerait sur un fil que le panneau ne montre pas.
 */
export function firstRosterBotId(bots: readonly RosterBot[]): string | null {
  const current = partitionThreadVisibility(bots).visible.filter((bot) => bot.archivedAt == null);
  const ordered = [...current].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
  return ordered[0]?.id ?? null;
}

/**
 * Le loquet de l'arrivée : la sélection automatique n'a lieu QU'UNE fois par
 * chargement de l'app.
 *
 * Sans lui, « Aperçu » (menu de l'opérateur, logo du panneau) deviendrait
 * inatteignable sur téléphone : chaque retour sur `/` renverrait aussitôt
 * sur le premier bot. L'arrivée est un lancement d'app, pas une adresse.
 *
 * Le chemin d'entrée est lu au chargement du module, donc avant toute
 * navigation : une app ouverte sur un lien profond (`/bot/…`, `/settings/…`)
 * a déjà dépensé son arrivée, sinon le premier « Aperçu » tapé dans le menu
 * se ferait avaler par une sélection qui n'a jamais eu lieu. Les écrans hors
 * coque (`/login`, `/onboarding`, `/legal`) ne la dépensent pas : le `/` qui
 * suit une connexion ou une fin d'accueil EST l'arrivée dans l'app.
 */
let landingConsumed = typeof window !== "undefined"
  && window.location.pathname !== "/"
  && isMobileShellPath(window.location.pathname);

/** Tests uniquement : rejoue l'entrée du chargement. */
export function setMobileLandingEntry(pathname: string): void {
  landingConsumed = pathname !== "/" && isMobileShellPath(pathname);
}

/** Vrai une seule fois : le premier passage sur `/` de ce chargement. */
export function consumeMobileLanding(): boolean {
  if (landingConsumed) return false;
  landingConsumed = true;
  return true;
}

/** L'arrivée a-t-elle déjà été jouée ? Lecture sans effet de bord. */
export function isMobileLandingConsumed(): boolean {
  return landingConsumed;
}

/** Tests uniquement : le loquet vit à l'échelle du module. */
export function resetMobileLanding(): void {
  landingConsumed = false;
}
