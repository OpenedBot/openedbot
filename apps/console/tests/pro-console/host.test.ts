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
  "ACTIONS", "activeOrganizationId", "api", "apiRequest", "BUTTON", "CardHeading", "CardSkeleton",
  "defineMessages", "FIELD", "formatDate", "InsetGroupedSection", "InsetGroupedStatic", "Note", "queryKeys",
  "SectionHeading", "SettingsCard", "SettingsPane", "StatusList", "StatusRow", "ToneBadge", "usePermissionContext",
  "userFacingError", "workspaceQueryKey",
];
