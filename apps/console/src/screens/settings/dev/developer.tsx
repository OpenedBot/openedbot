import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../../../lib/api";
import { EmptyState, SectionHeading } from "../../../components/settings/primitives";
import { useT } from "../../../lib/i18n";
import { DevOnboardingTools } from "./dev-onboarding-tools";
import { SettingsPane } from "../pane";

/**
 * Dev tools: the only place where the fabrication surfaces live.
 *
 * The nav entry exists only under `make dev` (`SHOW_DEV_SETTINGS`), and
 * each card also keeps ITS own server-side condition: the home
 * reset shows only if the cloud API has published `devSignIn`,
 * that is in `OPENEDBOT_ENV=development`. The Vite server is therefore not enough to
 * open an action; it only opens the page.
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
