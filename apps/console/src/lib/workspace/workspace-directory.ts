import type { AccountWorkspace, AccountWorkspacesDto } from "@openedbot/contracts-api";

const STORAGE_KEY = "ohb:workspace-directory";

type Directory = { userId: string; workspaces: AccountWorkspace[] };

/**
 * Tenant URLs carry the organization slug; API requests keep its UUID. This
 * per-tab directory maps one to the other synchronously, from the last
 * membership list the account read.
 */
export function rememberWorkspaces(workspaces: AccountWorkspace[], userId: string): void {
  const directory: Directory = { userId, workspaces: workspaces.map(({ id, slug, name, role, kind, viaAgencyIds }) => ({ id, slug, name, role, kind, viaAgencyIds })) };
  try { globalThis.window?.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(directory)); } catch { /* The next read resolves it again. */ }
}

/** Only own personal organizations remain addressable when agency workspaces are unavailable. */
export function personalWorkspaces(workspaces: readonly AccountWorkspace[]): AccountWorkspace[] {
  return workspaces.filter((workspace) => workspace.kind === "personal" && workspace.role !== "agency")
    .map(({ viaAgencyIds: _viaAgencyIds, ...workspace }) => workspace);
}

export function accountAvailableWorkspaces(account: AccountWorkspacesDto): AccountWorkspace[] {
  return account.agencyAvailable ? account.workspaces : personalWorkspaces(account.workspaces);
}

/** Keep the local slug directory in step with the workspaces the account can currently use. */
export function rememberAccountWorkspaces(account: AccountWorkspacesDto): void {
  rememberWorkspaces(accountAvailableWorkspaces(account), account.userId);
}

function readDirectory(): Directory | null {
  try {
    const raw = globalThis.window?.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Directory>;
    if (typeof value.userId !== "string" || !Array.isArray(value.workspaces)) return null;
    return { userId: value.userId, workspaces: value.workspaces.filter((w): w is AccountWorkspace =>
      typeof w?.id === "string" && typeof w.slug === "string" && typeof w.name === "string" && typeof w.role === "string") };
  } catch {
    return null;
  }
}

/** Forget agency and client slug mappings after a stale or failed feature read. */
export function rememberPersonalWorkspaces(userId?: string): void {
  const directory = readDirectory();
  if (!directory || (userId && directory.userId !== userId)) return;
  rememberWorkspaces(personalWorkspaces(directory.workspaces), directory.userId);
}

/** The first locally known personal workspace, used while leaving an unavailable agency context. */
export function findPersonalWorkspace(userId?: string): AccountWorkspace | null {
  const directory = readDirectory();
  if (!directory || (userId && directory.userId !== userId)) return null;
  return personalWorkspaces(directory.workspaces)[0] ?? null;
}

/** Finds a workspace by UUID or slug. A directory written for another account resolves nothing. */
export function findWorkspace(key: string, userId?: string): AccountWorkspace | null {
  const directory = readDirectory();
  if (!directory || (userId && directory.userId !== userId)) return null;
  const wanted = key.toLowerCase();
  return directory.workspaces.find((w) => w.id.toLowerCase() === wanted || w.slug.toLowerCase() === wanted) ?? null;
}
