import type { AccountWorkspace } from "@openedbot/contracts-api";
import { personalWorkspaces } from "../workspace/workspace-directory";

/** The real onboarding flow. A first organization is created as a step there. */
export const ONBOARDING_PATH = "/onboarding";

/**
 * `true` only on a confirmed read: an account whose workspace list came back
 * without any organization of its own. An unread list proves nothing.
 */
export function needsOrganization(workspaces: readonly AccountWorkspace[] | undefined): boolean {
  return workspaces !== undefined && personalWorkspaces(workspaces).length === 0;
}
