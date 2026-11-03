import { describe, expect, test } from "bun:test";

// `@openedbot/console/host` and `@openedbot/console/testing` are a contract with the
// external plugin repo: its console modules read the core only through them
// (open-core step 11). A change here is a change of that contract: review it
// with the plugin repo, then update this list.
describe("pro console host surface", () => {
  test("@openedbot/console/host lends exactly these names", async () => {
    expect(Object.keys(await import("../../src/pro-console/host")).sort()).toEqual(HOST.sort());
  });

  test("@openedbot/console/testing lends exactly these names", async () => {
    expect(Object.keys(await import("../../src/pro-console/testing")).sort()).toEqual(
      ["I18nProvider", "WorkspaceAccessBoundary", "rememberWorkspaces", "saveCloudSession", "workspaceRewriteInput"].sort());
  });
});

const HOST = [
  "ACTIONS", "activeFleetId", "activeOrganizationId", "FLEET_SECTIONS", "fleetAccountInPath",
  "fleetAuditRequestContext", "fleetClientRequestContext", "fleetHomeHref", "FleetFrameSkeleton",
  "fleetInPath", "fleetSection", "api", "ApiError", "apiRequest", "APP_HOME_HREF",
  "assertFleetClientRequestContext", "BAR_ICON_BUTTON", "BoardTopBar", "BotFace", "BUTTON", "CardHeading",
  "CardSkeleton", "CHART_FILL", "ChromeIconButton", "COLLAPSE_MOTION", "DATA_TABLE", "DATA_TABLE_PAGE_SIZE",
  "DataTablePagination", "defineMessages", "errorMessage", "FIELD", "findWorkspace", "formatDate", "GroupFaceStack",
  "InsetGroupedSection", "InsetGroupedStatic", "isOwnFleet", "ListRow", "ListRowsSkeleton", "ListSection",
  "MobileDrawerShell", "MobileHeader", "nativeBridge", "NAV_ROW", "Note", "NotFoundScreen", "operatingFleetId",
  "ORGANIZATION_SETUP_PATH", "OrganizationHead", "partitionThreadVisibility", "queryKeys", "readCloudSession",
  "resolveWorkspaceKey", "RowStatus", "saveCloudSession", "SECTION_LABEL_DENSE", "SectionHeading",
  "selectFleetOrganization", "SettingsCard", "SettingsOverlayHost", "settingsOverlayPath", "SettingsPane",
  "SettingsSidebarNav", "signOut", "SiteHeader", "StatusBadge", "StatusDot", "StatusList", "StatusRow",
  "StepHeading", "ToneBadge", "TreeView", "TreeViewItem", "useAccountWorkspaces", "useOperatorIdentity",
  "usePermissionContext", "userFacingError", "useSettingsModal", "useSupportUnread", "useWorkspaceNavigate",
  "Wordmark", "workspaceHref", "workspaceInPath", "WorkspaceLink", "workspaceQueryKey", "writeOnboardingDraft",
];
