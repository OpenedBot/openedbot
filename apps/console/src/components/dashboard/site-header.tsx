import type { ReactNode } from "react";
import { MobileHeader } from "../mobile/mobile-header";
import { useMobileDrawer } from "../mobile/mobile-drawer-shell";
import { RuntimeHealthBadge } from "./runtime-health-badge";
import { SupportHeaderButton } from "../support/support-header-button";
import { BoardHeader } from "../boardui/board-chrome";

/**
 * L'en-tête du bloc `dashboard-01`.
 *
 * Le titre et les actions viennent de l'écran affiché plutôt que d'être écrits
 * en dur : c'est le même bandeau pour l'aperçu, une conversation et les
 * réglages, et dupliquer la barre par écran la ferait diverger.
 */
export function SiteHeader({
  title,
  subtitle,
  avatar,
  actions,
  heading = true,
  align = "center",
  root = false,
  centered = false,
}: {
  title: ReactNode;
  /**
   * La deuxième ligne du titre : sur téléphone seulement. Une barre de
   * navigation de 430 pt ne tient pas un nom, un sélecteur et trois actions
   * sur UNE ligne : le nom finissait tronqué à « H… ». Le sélecteur descend
   * donc sous le nom, comme le sous-titre d'une barre iOS.
   */
  subtitle?: ReactNode;
  /**
   * Le visage d'une conversation. Sur téléphone il couvre les deux lignes du
   * titre (`MobileHeader`) ; au bureau il précède le titre, en ligne.
   */
  avatar?: ReactNode;
  actions?: ReactNode;
  /** `false` : le `h1` vit dans la scène (foyer `/`). */
  heading?: boolean;
  /**
   * Téléphone seulement. `center` (défaut) = barre de navigation iOS : titre
   * au centre optique entre deux colonnes de même largeur. `start` pour une
   * conversation, dont le titre porte un visage et un nom.
   */
  align?: "start" | "center";
  /** Bureau : le Salon lui-même, sans « Salon › » devant son titre. */
  root?: boolean;
  /** Bureau : le titre seul, centré sur la barre (`BoardHeader`), comme l'en-tête d'un fil. */
  centered?: boolean;
}) {
  // Dans la coque mobile (`MobileDrawerShell`), le même en-tête devient la
  // barre de navigation d'un écran du drawer : bouton du panneau ou
  // « Retour » à gauche, sans `SidebarTrigger` : il n'y a pas de barre à
  // replier, il y a un panneau à révéler.
  const drawer = useMobileDrawer();
  // La porte du guichet est l'action fixe de chaque en-tête, sur tous les
  // écrans de l'application : une place plutôt qu'une bulle flottante qui
  // se retirait des fils et recouvrait le reste. La bulle ne reste que là où
  // il n'y a pas d'en-tête (`support-launcher-visibility.ts`).
  // Sur un fil (`/bot/:id`, `/g/:id`), l'état du runtime précède ce bouton :
  // savoir si l'hôte répond avant d'écrire.
  const headerActions = (
    <>
      <RuntimeHealthBadge />
      <SupportHeaderButton />
      {actions}
    </>
  );
  if (drawer) {
    return <MobileHeader title={title} subtitle={subtitle} avatar={avatar} actions={headerActions} heading={heading} align={align} />;
  }
  // Bureau : le fil d'Ariane et les actions de l'écran, posés dans la barre
  // du haut du cadre (`board-chrome.tsx`). Le sous-titre est mobile seulement.
  return <BoardHeader title={title} avatar={avatar} actions={actions} heading={heading} root={root} centered={centered} />;
}
