import type { ReactNode } from "react";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";

/**
 * Bureau : des cartes courtes côte à côte selon la largeur du panneau (requête
 * de conteneur, pas la fenêtre) : une colonne, deux dès `@4xl`, trois dès
 * `@[90rem]`, hauteurs alignées par ligne. Une carte longue reste hors de la
 * grille, pleine largeur. Sur téléphone, les enfants restent dans la colonne
 * du panneau. `trio` : trois cartes, trois colonnes dès `@6xl`, pour ne pas
 * laisser la troisième seule sur sa ligne. Voir `DESIGN.md` › Bureau ›
 * Regrouper et aligner.
 */
export function SettingsCardGrid({ children, trio = false }: { children: ReactNode; trio?: boolean }) {
  const isMobile = useIsMobile();
  if (isMobile) return <>{children}</>;
  return (
    <div className="@container">
      <div className={cn("grid grid-cols-1 gap-6 @4xl:grid-cols-2 [&>*]:min-w-0", trio ? "@6xl:grid-cols-3" : "@[90rem]:grid-cols-3")}>{children}</div>
    </div>
  );
}
