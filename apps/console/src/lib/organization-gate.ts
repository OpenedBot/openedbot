import type { AccountWorkspace } from "@openedbot/contracts-api";

/** The real onboarding flow. A first organization is created as a step there. */
export const ONBOARDING_PATH = "/onboarding";

/**
 * Creating the other organization type later (`?create=1`). A first
 * organization is no longer defined here: that step lives on `/onboarding`.
 */
export const ORGANIZATION_SETUP_PATH = "/onboarding/organization";

/** Organizations the account belongs to, as opposed to clients it reaches through an agency grant. */
export function ownWorkspaces(workspaces: readonly AccountWorkspace[]): AccountWorkspace[] {
  return workspaces.filter((workspace) => workspace.role !== "agency");
}

/**
 * `true` only on a confirmed read: an account whose workspace list came back
 * without any organization of its own. An unread list proves nothing.
 */
export function needsOrganization(workspaces: readonly AccountWorkspace[] | undefined): boolean {
  return workspaces !== undefined && ownWorkspaces(workspaces).length === 0;
}

/** An agency organization the account belongs to, as opposed to a client it operates for one. */
export function isOwnFleet(workspace: AccountWorkspace): boolean {
  return workspace.role !== "agency" && workspace.kind === "agency";
}
