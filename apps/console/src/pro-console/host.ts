/**
 * What the core console lends a pro console module that lives in its own
 * package (`packages/<plug-in>/console/` of the external plugin repo):
 * imported as `@openedbot/console/host`, resolved to this file by Vite
 * (`vite.config.ts`), tsc (`tsconfig.json` paths) and bun test
 * (`test-setup.ts`).
 *
 * Each export is a contract with the plugin repo: the shell, the session,
 * the workspace addresses and the settings primitives a pro screen is drawn
 * with. Nothing here is a pro screen. `tests/pro-console/host.test.ts` pins it.
 */
// The console's request (session, CSRF, organization header, errors): a pro
// module keeps its own fetchers and query keys (`/api/pro/*`).
export { request as apiRequest } from "../lib/api";
// A pro module registers its own strings and reads them typed.
export { defineMessages } from "@openedbot/browser-i18n/provider";
export { usePermissionContext } from "../components/boardui/permission-picker";
export { InsetGroupedSection, InsetGroupedStatic } from "../components/mobile/inset-grouped";
export { ACTIONS, BUTTON, CardHeading, CardSkeleton, FIELD, Note, SectionHeading, SettingsCard, StatusList, StatusRow, type Tone, ToneBadge } from "../components/settings/primitives";
export { api, queryKeys, userFacingError, workspaceQueryKey } from "../lib/api";
export { activeOrganizationId } from "../lib/session/cloud-session";
export { formatDate } from "../lib/format";
export { SettingsPane } from "../screens/settings/pane";
