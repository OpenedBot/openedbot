/**
 * What the core console lends a pro console module that lives in its own
 * package (`packages/<plug-in>/console/` of the external plugin repo):
 * imported as `@openedbot/console/host`, resolved to this file by Vite
 * (`vite.config.ts`), tsc (`tsconfig.json` paths) and bun test
 * (`test-setup.ts`).
 *
 * Each export is a contract with the plugin repo: the shell, the session,
 * the workspace addresses and the settings primitives a pro screen is drawn
 * with. Since open-core step 11 the fleet screens (agency plug-in) live there too, so this
 * list is what they read from the core; nothing here is a pro screen.
 * `tests/pro-console/host.test.ts` pins it.
 */
// The console's request (session, CSRF, organization header, errors): a pro
// module keeps its own fetchers and query keys (`/api/pro/*`).
export { request as apiRequest } from "../lib/api";
// A pro module registers its own strings and reads them typed.
export { defineMessages } from "@openedbot/browser-i18n/provider";
export { NotFoundScreen } from "../components/app-not-found";
export { BAR_ICON_BUTTON, BoardTopBar, COLLAPSE_MOTION } from "../components/boardui/board-chrome";
export { NAV_ROW, OrganizationHead, RowStatus, SECTION_LABEL_DENSE } from "../components/boardui/board-sidebar";
export { DATA_TABLE, DATA_TABLE_PAGE_SIZE, DataTablePagination } from "../components/boardui/data-table";
export { usePermissionContext } from "../components/boardui/permission-picker";
export { SettingsSidebarNav, useSettingsModal } from "../components/boardui/settings-modal";
export { CHART_FILL, StatusBadge, StatusDot } from "../components/boardui/status";
export { TreeView, TreeViewItem } from "../components/boardui/tree-view";
export { BotFace } from "../components/bot-face";
export { SiteHeader } from "../components/dashboard/site-header";
export { SettingsOverlayHost } from "../components/frames/app-frame";
export { GroupFaceStack } from "../components/group-face-stack";
export { InsetGroupedSection, InsetGroupedStatic } from "../components/mobile/inset-grouped";
export { MobileDrawerShell } from "../components/mobile/mobile-drawer-shell";
export { ChromeIconButton, MobileHeader } from "../components/mobile/mobile-header";
export { ACTIONS, BUTTON, CardHeading, CardSkeleton, FIELD, ListRow, ListRowsSkeleton, ListSection, Note, SectionHeading, SettingsCard, StatusList, StatusRow, type Tone, ToneBadge } from "../components/settings/primitives";
export { FleetFrameSkeleton } from "../components/skeletons/frame-skeletons";
export { FLEET_SECTIONS, fleetSection, selectFleetOrganization, useAccountWorkspaces, useWorkspaceNavigate, WorkspaceLink } from "../components/workspace/workspace-navigation";
export { fleetAuditRequestContext, fleetClientRequestContext, api, ApiError, assertFleetClientRequestContext, errorMessage, queryKeys, userFacingError, workspaceQueryKey } from "../lib/api";
export { activeFleetId, activeOrganizationId, readCloudSession, saveCloudSession } from "../lib/session/cloud-session";
export { formatDate } from "../lib/format";
export { nativeBridge } from "../lib/platform/native-bridge";
export { writeOnboardingDraft } from "../lib/session/onboarding-draft";
export { useOperatorIdentity } from "../lib/session/operator-identity";
export { isOwnFleet, ORGANIZATION_SETUP_PATH } from "../lib/session/organization-gate";
export { settingsOverlayPath } from "../lib/shell/settings-overlay";
export { signOut } from "../lib/session/sign-out";
export { useSupportUnread } from "../lib/support/support-watch";
export { partitionThreadVisibility } from "../lib/thread/thread-visibility";
export { findWorkspace } from "../lib/workspace/workspace-directory";
export { fleetAccountInPath, fleetHomeHref, fleetInPath, APP_HOME_HREF, operatingFleetId, resolveWorkspaceKey, workspaceHref, workspaceInPath } from "../lib/workspace/workspace-location";
export { StepHeading } from "../screens/onboarding/components/step-shell";
export { Wordmark } from "../screens/onboarding/components/wordmark";
export { SettingsPane } from "../screens/settings/pane";
