import { isUuid } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";

export const EMPTY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export function assertWorkspaceId(value: string): string {
  if (!isUuid(value)) throw new HttpError(400, "WORKSPACE_INVALID", "Espace invalide.");
  return value;
}

/** Account endpoints never grant tenant access or escape an assistance session. */
export function isAccountIdentityPath(path: string, method?: string): boolean {
  // Session management belongs to the user, even without a workspace. Keep
  // this method/path allowlist narrow so future security actions stay closed.
  const ownSessions = (method === "GET" && path === "/api/account/security")
    || (method === "DELETE" && /^\/api\/account\/security\/sessions\/[^/]{1,64}$/.test(path))
    || (method === "POST" && path === "/api/account/security/sessions/revoke-others");
  // Answering a member invitation: the invitee has no workspace yet.
  const invitationAnswer = method === "POST" && /^\/api\/invite\/member\/[A-Za-z0-9_-]{32,128}\/(accept|decline)$/.test(path);
  return invitationAnswer || path === "/api/account/workspaces" || path === "/api/account/organizations"
    || path === "/api/auth/me"
    || path === "/api/auth/logout" || path === "/api/onboarding" || ownSessions
    || ((method === "GET" || method === "POST") && path === "/api/account/deletion")
    || (method === "POST" && path === "/api/account/deletion/cancel");
}
