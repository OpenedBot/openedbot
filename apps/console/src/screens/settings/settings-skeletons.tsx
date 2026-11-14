import type { ComponentType } from "react";
import { CardSkeleton } from "../../components/settings/primitives";
import { OverviewDashboardSkeleton } from "../../components/dashboard/overview-skeleton";
import { CatalogSkeleton } from "./installation/models/models-catalog-parts";
import { useT } from "../../lib/i18n";
import { SettingsPane } from "./pane";

/**
 * The fallback of a settings body while its module loads: a
 * card in `SettingsPane`'s margins, so the page does not stay empty
 * between its title and the content.
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
 * Activity (`/settings/activity`): the tiles and the two charts at their size,
 * in the same margins as `CloudSettingsOverview`, instead of the generic
 * card that let the page jump when the module arrived.
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
 * Models (`/settings/models`): the silhouette the screen itself shows
 * while the catalog is read. The module then the data thus keep
 * the same drawing, instead of going from a generic card to three cards.
 */
export function ModelsBodySkeleton() {
  const { t } = useT();
  return (
    <SettingsPane>
      <CatalogSkeleton label={t("modelsSettings.loading")} />
    </SettingsPane>
  );
}

/** The silhouette of a section's body, from its internal path (`/settings/...`). */
export function settingsBodySkeletonFor(path: string): ComponentType {
  if (path === "/settings" || path === "/settings/activity") return OverviewBodySkeleton;
  if (path === "/settings/models") return ModelsBodySkeleton;
  return SettingsBodySkeleton;
}
