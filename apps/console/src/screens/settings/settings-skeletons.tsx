import type { ComponentType } from "react";
import { CardSkeleton } from "../../components/settings/primitives";
import { OverviewDashboardSkeleton } from "../../components/dashboard/overview-skeleton";
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

/** La silhouette du corps d'une rubrique, d'après son chemin interne (`/settings/...`). */
export function settingsBodySkeletonFor(path: string): ComponentType {
  return path === "/settings" ? OverviewBodySkeleton : SettingsBodySkeleton;
}
