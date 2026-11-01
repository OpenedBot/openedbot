import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../../../lib/api";
import { EmptyState, SectionHeading } from "../../../components/settings/primitives";
import { useT } from "../../../lib/i18n";
import { DevOnboardingTools } from "./dev-onboarding-tools";
import { SettingsPane } from "../pane";

/**
 * Outils de dev : le seul endroit où vivent les surfaces de fabrication.
 *
 * L'entrée de nav n'existe que sous `make dev` (`SHOW_DEV_SETTINGS`), et
 * chaque carte garde en plus SA propre condition côté serveur : la remise à
 * zéro de l'accueil ne s'affiche que si le cloud API a publié `devSignIn`,
 * c'est-à-dire en `OHB_ENV=development`. Le serveur Vite ne suffit donc pas à
 * ouvrir une action ; il ne fait qu'ouvrir la page.
 */
export function DeveloperSettings() {
  const { t } = useT();
  const providers = useQuery({ queryKey: queryKeys.authProviders, queryFn: api.authProviders });

  return (
    <SettingsPane>
      <SectionHeading
        title={t("settingsDeveloper.title")}
        description={t("settingsDeveloper.description")}
      />
      <DevOnboardingTools />
      {providers.isPending || providers.data?.devSignIn ? null : (
        <EmptyState
          title={t("settingsDeveloper.unavailableTitle")}
          description={t("settingsDeveloper.unavailableDescription")}
        />
      )}
    </SettingsPane>
  );
}
