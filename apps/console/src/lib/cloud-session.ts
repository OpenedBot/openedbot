import { fleetInPath, resolveWorkspaceKey, workspaceInPath } from "./workspace-location";

const STORAGE_KEY = "ohb:cloud-session";
const CSRF_COOKIE = "ohb_csrf";
const listeners = new Set<() => void>();
let revision = 0;

export type WebCloudSession = {
  /** `null` for an authenticated account that has no organization yet (0086): it is sent to "Définir votre organisation". */
  organizationId: string | null;
  csrfToken: string;
  userId?: string;
};

export function readCloudSession(): WebCloudSession | null {
  try {
    const raw = globalThis.window?.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<WebCloudSession>;
    if (typeof value.csrfToken !== "string") return null;
    if (typeof value.organizationId !== "string" && value.organizationId !== null) return null;
    const userId = typeof value.userId === "string" ? value.userId : undefined;
    let tabOrganization: string | null = null;
    try { tabOrganization = globalThis.window?.sessionStorage.getItem(`ohb:workspace:${userId ?? value.csrfToken}`) ?? null; } catch { /* URL context remains available. */ }
    const pathKey = workspaceInPath(globalThis.window?.location.pathname ?? "");
    const organizationId = (pathKey && resolveWorkspaceKey(pathKey, userId)) || tabOrganization || value.organizationId;
    return { organizationId, csrfToken: value.csrfToken, userId };
  } catch {
    return null;
  }
}

export function saveCloudSession(session: WebCloudSession): void {
  globalThis.window?.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  try {
    const workspaceKey = `ohb:workspace:${session.userId ?? session.csrfToken}`;
    if (session.organizationId) globalThis.window?.sessionStorage.setItem(workspaceKey, session.organizationId);
    else globalThis.window?.sessionStorage.removeItem(workspaceKey);
  } catch { /* URL context remains available. */ }
  revision += 1;
  for (const listener of listeners) listener();
}

export function syncCloudSession(session: WebCloudSession): void {
  const current = readCloudSession();
  if (!current || current.csrfToken !== session.csrfToken || (session.userId && current.userId !== session.userId)) {
    saveCloudSession(session);
  }
  // Selecting a client never writes its identity to another tab's context.
  try {
    if (session.organizationId) globalThis.window?.sessionStorage.setItem(
      `ohb:workspace:${session.userId ?? session.csrfToken}`, session.organizationId,
    );
  } catch { /* URL context remains available. */ }
}

export function readWebCsrfToken(cookieHeader: string = globalThis.document?.cookie ?? ""): string | null {
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator) !== CSRF_COOKIE) continue;
    const value = cookie.slice(separator + 1);
    return value || null;
  }
  return null;
}

export function clearCloudSession(): void {
  globalThis.window?.localStorage.removeItem(STORAGE_KEY);
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeCloudSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function activeOrganizationId(): string | null {
  return readCloudSession()?.organizationId ?? null;
}

/** Unknown agency slugs remain explicit so the server refuses them instead of using personal privileges. */
export function activeFleetId(): string | null {
  const key = fleetInPath(globalThis.window?.location.pathname ?? "");
  return key ? resolveWorkspaceKey(key, readCloudSession()?.userId) ?? key : null;
}

export function cloudSessionRevision(): number {
  return revision;
}

/** Notify streams and mounted screens when the URL changes the selected mandate. */
export function notifyWorkspaceContextChanged(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function reportWorkspaceRevoked(organizationId: string, fleetId: string | null = activeFleetId()): void {
  globalThis.window?.dispatchEvent(new CustomEvent("ohb:workspace-revoked", { detail: { organizationId, fleetId } }));
}
