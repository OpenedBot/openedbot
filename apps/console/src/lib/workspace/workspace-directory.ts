import type { AccountWorkspace, AccountWorkspacesDto } from "@openedbot/contracts-api";

const STORAGE_KEY = "openedbot:workspace-directory";

type Directory = { userId: string; workspaces: AccountWorkspace[] };

/**
 * Tenant URLs carry the organization slug; API requests keep its UUID. This
 * per-tab directory maps one to the other synchronously, from the last
 * membership list the account read.
 */
export function rememberWorkspaces(workspaces: AccountWorkspace[], userId: string): void {
  const directory: Directory = { userId, workspaces: workspaces.map(({ id, slug, name, role, kind }) => ({ id, slug, name, role, kind })) };
  try { globalThis.window?.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(directory)); } catch { /* The next read resolves it again. */ }
}

const MEMBERSHIP_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "member"]);

/**
 * The organizations the console opens: those the account is a member of.
 * `/api/account/workspaces` still labels each with a `kind`, and `personal` is
 * the only one the core knows; it is read here, and only here, so that any
 * other kind or a non-membership access an older server lists stays closed.
 */
export function personalWorkspaces(workspaces: readonly AccountWorkspace[]): AccountWorkspace[] {
  return workspaces.filter((workspace) => workspace.kind === "personal" && MEMBERSHIP_ROLES.has(workspace.role))
    .map(({ id, slug, name, role, kind }) => ({ id, slug, name, role, kind }));
}

/** Keep the local slug directory in step with the workspaces the account can open. */
export function rememberAccountWorkspaces(account: AccountWorkspacesDto): void {
  rememberWorkspaces(personalWorkspaces(account.workspaces), account.userId);
}

function readDirectory(): Directory | null {
  try {
    const raw = globalThis.window?.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Directory>;
    if (typeof value.userId !== "string" || !Array.isArray(value.workspaces)) return null;
    // A directory a tab wrote before this build may still list other workspaces.
    return { userId: value.userId, workspaces: personalWorkspaces(value.workspaces.filter((w): w is AccountWorkspace =>
      typeof w?.id === "string" && typeof w.slug === "string" && typeof w.name === "string" && typeof w.role === "string")) };
  } catch {
    return null;
  }
}

/** The first locally known personal workspace, used while leaving a revoked one. */
export function findPersonalWorkspace(userId?: string): AccountWorkspace | null {
  const directory = readDirectory();
  if (!directory || (userId && directory.userId !== userId)) return null;
  return directory.workspaces[0] ?? null;
}

/** Finds a workspace by UUID or slug. A directory written for another account resolves nothing. */
export function findWorkspace(key: string, userId?: string): AccountWorkspace | null {
  const directory = readDirectory();
  if (!directory || (userId && directory.userId !== userId)) return null;
  const wanted = key.toLowerCase();
  return directory.workspaces.find((w) => w.id.toLowerCase() === wanted || w.slug.toLowerCase() === wanted) ?? null;
}
