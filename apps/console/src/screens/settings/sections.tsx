import { Suspense, type ComponentType, type ReactElement } from "react";
import { lazyRouteComponent, useRouterState } from "@tanstack/react-router";
import { SiteHeader } from "../../components/dashboard/site-header";
import { FleetClientSettingsContext } from "../../pro-console/slots";
import { proConsole, useProFeature } from "../../pro-console/registry";
import { ModelsBodySkeleton, OverviewBodySkeleton, SettingsBodySkeleton } from "./settings-skeletons";
import { useT, type MessageKey } from "../../lib/i18n";
import { useSettingsOverlay, type OverlaySettingsPath } from "../../lib/shell/settings-overlay";
import { isRuntimeSection } from "./installation/cloud/cloud-shared";

// Each settings body is its own chunk: the console boots on a conversation,
// and loading every settings screen with it cost the first paint. The
// header renders at once; the body follows from its chunk.
const AccountSettings = lazyRouteComponent(() => import("./account/account"), "AccountSettings");
const AccountProfileSettings = lazyRouteComponent(() => import("./account/account"), "AccountProfileSettings");
const OrganizationTeamSettings = lazyRouteComponent(() => import("./account/team"), "OrganizationTeamSettings");
const DeveloperSettings = lazyRouteComponent(() => import("./dev/developer"), "DeveloperSettings");
const AppearanceSettings = lazyRouteComponent(() => import("./general/appearance"), "AppearanceSettings");
const ArchivesSettings = lazyRouteComponent(() => import("./general/archives"), "ArchivesSettings");
const NotificationsSettings = lazyRouteComponent(() => import("./general/notifications"), "NotificationsSettings");
const AgentsSettings = lazyRouteComponent(() => import("./installation/agents"), "AgentsSettings");
const CloudRuntimeSettings = lazyRouteComponent(() => import("./installation/cloud"), "CloudRuntimeSettings");
const CloudSettingsOverview = lazyRouteComponent(() => import("./installation/cloud/cloud-overview"), "CloudSettingsOverview");
const ConnectorsSettings = lazyRouteComponent(() => import("./installation/connectors"), "ConnectorsSettings");
const ModelsSettings = lazyRouteComponent(() => import("./installation/models"), "ModelsSettings");
const DecisionsSettings = lazyRouteComponent(() => import("./journal/decisions"), "DecisionsSettings");
const PoliciesSettings = lazyRouteComponent(() => import("./journal/policies"), "PoliciesSettings");
const CloudSecuritySettings = lazyRouteComponent(() => import("./journal/security"), "CloudSecuritySettings");

type SettingsSection = () => ReactElement;

export { SettingsBodySkeleton } from "./settings-skeletons";

function section(titleKey: MessageKey, Body: ComponentType, Fallback: ComponentType = SettingsBodySkeleton): SettingsSection {
  return function SettingsSection() {
    const { t } = useT();
    return (
      <>
        <SiteHeader title={t(titleKey)} />
        <FleetClientSettingsContext>
          <Suspense fallback={<Fallback />}>
            <Body />
          </Suspense>
        </FleetClientSettingsContext>
      </>
    );
  };
}

// The pro bodies come from the console modules (`src/pro-console/`): a build
// without the module, or a session without the entitlement, renders none.
function FleetClientsSettings() {
  const Body = proConsole().fleet?.screens.FleetClientsSettings;
  return Body ? <Body /> : null;
}

function FleetJournalSettings() {
  const Body = proConsole().fleet?.screens.FleetJournalSettings;
  return Body ? <Body /> : null;
}

function BillingSettings() {
  const Body = useProFeature("billing")?.BillingSettings;
  return Body ? <Body /> : null;
}

/** Keep tab links shareable without leaving the settings overlay. */
function RuntimeOverlaySettings() {
  const overlay = useSettingsOverlay();
  const section = useRouterState({
    select: (state) => {
      const value = state.location.maskedLocation?.search.section;
      return isRuntimeSection(value) ? value : undefined;
    },
  });
  return (
    <CloudRuntimeSettings
      section={section}
      onSectionChange={(next) => overlay?.open("/settings/runtime", { section: next, replace: true })}
    />
  );
}

/**
 * Shared settings content for standalone routes and the desktop overlay.
 * Runtime tabs adapt their search parameters to the masked overlay URL.
 */
export const SETTINGS_SECTIONS: Record<OverlaySettingsPath, SettingsSection> = {
  "/settings": section("settingsSidebar.overview", CloudSettingsOverview, OverviewBodySkeleton),
  "/settings/account": section("settingsSidebar.account", AccountSettings),
  "/settings/profile": section("fleet.myAccount", AccountProfileSettings),
  "/settings/team": section("fleet.myTeam", OrganizationTeamSettings),
  "/settings/clients": section("fleet.clientsSettings", FleetClientsSettings),
  "/settings/journal": section("fleet.journalSettings", FleetJournalSettings),
  "/settings/runtime": section("settingsSidebar.runtime", RuntimeOverlaySettings),
  "/settings/agents": section("settingsSidebar.agents", AgentsSettings),
  "/settings/models": section("settingsSidebar.models", ModelsSettings, ModelsBodySkeleton),
  "/settings/appearance": section("settingsSidebar.appearance", AppearanceSettings),
  "/settings/archives": section("settingsSidebar.archives", ArchivesSettings),
  "/settings/connectors": section("settingsSidebar.connectors", ConnectorsSettings),
  "/settings/notifications": section("settingsSidebar.notifications", NotificationsSettings),
  "/settings/decisions": section("settingsSidebar.decisions", DecisionsSettings),
  "/settings/policies": section("settingsSidebar.policies", PoliciesSettings),
  "/settings/security": section("settingsSidebar.security", CloudSecuritySettings),
  "/settings/billing": section("settingsSidebar.billing", BillingSettings),
  "/settings/developer": section("settingsDeveloper.title", DeveloperSettings),
};
