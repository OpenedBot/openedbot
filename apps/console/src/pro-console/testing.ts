/**
 * What the tests of a pro console module (`packages/<plug-in>/console/tests`
 * of the external plugin repo) set up a console with: imported as
 * `@openedbot/console/testing`, never by a screen (`.dependency-cruiser.cjs`).
 */
export { WorkspaceAccessBoundary } from "../components/workspace/workspace-access-boundary";
export { saveCloudSession } from "../lib/cloud-session";
export { I18nProvider } from "../lib/i18n";
export { rememberWorkspaces } from "../lib/workspace-directory";
export { workspaceRewriteInput } from "../lib/workspace-location";
