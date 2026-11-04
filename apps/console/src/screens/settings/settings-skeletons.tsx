import type { ComponentType } from "react";
import { CardSkeleton } from "../../components/settings/primitives";
import { OverviewDashboardSkeleton } from "../../components/dashboard/overview-skeleton";
import { CatalogSkeleton } from "./installation/models/models-catalog-parts";
import { useT } from "../../lib/i18n";
import { SettingsPane } from "./pane";

/**
 * Le repli d'un corps de réglages pendant le chargement de son module : une
 * carte dans les marges de `SettingsPane`, pour que la page ne reste pas vide
 * entre son titre et le contenu.
 */
export function SettingsBodySkeleton() {
  const { t } = useT();
  return (
    <SettingsPane>
      <CardSkeleton label={t("common.loading")} />
    </SettingsPane>
  );
}

/**
 * Activité (`/settings`) : les tuiles et les deux graphiques à leur taille,
 * dans les mêmes marges que `CloudSettingsOverview`, au lieu de la carte
 * générique qui laissait la page sauter à l'arrivée du module.
 */
export function OverviewBodySkeleton() {
  const { t } = useT();
  return (
    <SettingsPane>
      <div className="px-4 md:px-0">
        <OverviewDashboardSkeleton label={t("common.loading")} />
      </div>
    </SettingsPane>
  );
}

/**
 * Modèles (`/settings/models`) : la silhouette que l'écran affiche lui-même
 * pendant la lecture du catalogue. Le module puis les données gardent ainsi
 * le même dessin, au lieu de passer d'une carte générique à trois cartes.
 */
export function ModelsBodySkeleton() {
  const { t } = useT();
  return (
    <SettingsPane>
      <CatalogSkeleton label={t("modelsSettings.loading")} />
    </SettingsPane>
  );
}

/** La silhouette du corps d'une rubrique, d'après son chemin interne (`/settings/...`). */
export function settingsBodySkeletonFor(path: string): ComponentType {
  if (path === "/settings") return OverviewBodySkeleton;
  if (path === "/settings/models") return ModelsBodySkeleton;
  return SettingsBodySkeleton;
}
