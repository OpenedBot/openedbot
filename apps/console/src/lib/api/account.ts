import type { AccountDeletionDto, AccountDeletionStateDto } from "@openedbot/contracts-api";
import type { AuthStatus } from "../session/auth-status";
import { clearCloudSession, readWebCsrfToken, syncCloudSession } from "../session/cloud-session";
import { NATIVE_SESSION_MARK, nativeBridge } from "../platform";
import { clearOnboardingDraft } from "../session/onboarding-draft";
import { workspaceInPath } from "../workspace/workspace-location";
import type { AccountSecurityDto, AuthMeDto, AuthStartDto, ChangePasswordDto, ChangePasswordInput, GoogleLinkClaimDto, GoogleUnlinkDto, MemberRoleChangedDto, OrganizationMemberDto, OrganizationPermissionPolicyInput, OrganizationPermissionPolicyView, RevokeSessionsDto } from "@openedbot/contracts-api";
import { isUnauthorized, request } from "./http";
import type { MobileConnectTicketDto } from "./types";
import { apiSelf } from "./self";

export const accountApi = {
  accountDeletion: () => request<AccountDeletionStateDto>("/api/account/deletion", undefined, { skipOrganizationHeader: true }),
  scheduleAccountDeletion: (confirmation: string, organizationIds: string[], expectedGraceDays?: number) =>
    request<{ scheduled: boolean; deletion: AccountDeletionDto }>("/api/account/deletion", {
      method: "POST", body: JSON.stringify({ confirmation, organizationIds, expectedGraceDays }),
    }, { skipOrganizationHeader: true }),
  cancelAccountDeletion: () => request<{ cancelled: boolean; deletion: AccountDeletionDto | null }>("/api/account/deletion/cancel", {
    method: "POST", body: JSON.stringify({}),
  }, { skipOrganizationHeader: true }),
  /** Cloud session and current organization. */
  authMe: async () => {
    const result = await request<AuthMeDto>("/api/auth/me", undefined, { skipOrganizationHeader: !workspaceInPath(globalThis.window?.location.pathname ?? "") });
    const impersonation = result.impersonation ?? null;
    // Native shell: no CSRF cookie, the bearer carries the identity. The mark
    // holds its place so the organization and the person are read as those of
    // a web session, on every route and not only `/compact`.
    const csrfToken = nativeBridge() ? NATIVE_SESSION_MARK : readWebCsrfToken();
    if (csrfToken) {
      syncCloudSession({ organizationId: result.organization?.id ?? "", csrfToken, userId: result.user.id });
    }
    return {
      kind: "session" as const,
      sessionId: "web",
      user: result.user,
      organization: result.organization ?? { id: "", slug: "", name: "" },
      session: {
        role: result.role,
        canWrite: result.role !== "member" && impersonation === null,
        impersonation,
      },
      // Strictly `=== true`: a cloud API from before the flag says nothing,
      // and an absent field must not lock a session into the security
      // screen.
      mustChangePassword: result.mustChangePassword === true,
      // The non-core entitlements (`<plug-in>.<feature>`): the pro console
      // screens show only for those held (`src/pro-console/registry.ts`).
      // Absent reads as none.
      ...(result.entitlements ? { entitlements: result.entitlements } : {}),
    };
  },
  /**
   * The route guard's two reads (`lib/session/auth-status.ts`) in one: is SSO
   * offered, and what is this window authenticated as.
   *
   * The order changed with the move: the ISSUER says who we are, and the
   * cloud API says whether we get in. A window with no refresh token asks
   * no one: it holds its own token, or nothing.
   */
  authStatus: async (): Promise<AuthStatus> => {
    try {
      const me = await apiSelf().authMe();
      if (me.kind !== "session") {
        return { kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: "AUTH_REQUIRED", mustChangePassword: false };
      }
      return {
        kind: "session",
        ssoEnabled: true,
        user: me.user,
        sessionId: me.sessionId,
        reason: null,
        mustChangePassword: me.mustChangePassword === true,
      };
    } catch (error) {
      if (isUnauthorized(error)) {
        return { kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: error.code ?? null, mustChangePassword: false };
      }
      throw error;
    }
  },
  organizationMembers: (_orgId?: string) =>
    request<{ members: OrganizationMemberDto[] }>("/api/organization/members"),
  /** The response returns only the id and the role: the list is reread afterwards. */
  setOrgMemberRole: (orgIdOrUserId: string, userIdOrRole: string, role?: string) =>
    request<MemberRoleChangedDto>(`/api/organization/members/${role ? userIdOrRole : orgIdOrUserId}`, { method: "PATCH", body: JSON.stringify({ role: role ?? userIdOrRole }) }),
  removeOrgMember: (orgIdOrUserId: string, userId?: string) =>
    request<void>(`/api/organization/members/${userId ?? orgIdOrUserId}`, { method: "DELETE" }),
  /** PERM2-8: every member reads it; owners and admins write it. */
  organizationPermissionPolicy: () =>
    request<OrganizationPermissionPolicyView>("/api/organization/permissions"),
  saveOrganizationPermissionPolicy: (input: OrganizationPermissionPolicyInput) =>
    request<OrganizationPermissionPolicyView>("/api/organization/permissions", { method: "PUT", body: JSON.stringify(input) }),
  /**
   * The local session is forgotten only once revocation is confirmed: a
   * failure leaves the cookie valid, and forgetting it here would look like
   * a sign-out. A 401 has already cleared the window in `request`.
   */
  logout: async () => {
    await request<void>("/api/auth/logout", { method: "POST" });
    clearOnboardingDraft();
    clearCloudSession();
  },
  /** « Sécurité du compte » screen: its sign-in method and its web sessions. */
  accountSecurity: () => request<AccountSecurityDto>("/api/account/security"),
  revokeSession: (sessionId: string) =>
    request<void>(`/api/account/security/sessions/${sessionId}`, { method: "DELETE" }),
  revokeOtherSessions: () =>
    request<RevokeSessionsDto>("/api/account/security/sessions/revoke-others", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /** Mobile Connect: a disposable ticket (10 min) and the link to show as a QR code to the iPhone app. */
  mobileConnectTicket: () =>
    request<MobileConnectTicketDto>("/api/auth/mobile-connect/tickets", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  changePassword: (input: ChangePasswordInput) =>
    request<ChangePasswordDto>("/api/account/security/password", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Link Google from « Mon compte »: the Google URL opens outside the window, then the page polls `googleLinkClaim`. */
  googleLinkStart: () =>
    request<AuthStartDto>("/api/account/security/google/link/start", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  googleLinkClaim: (attemptId: string) =>
    request<GoogleLinkClaimDto>("/api/account/security/google/link/claim", {
      method: "POST",
      body: JSON.stringify({ attemptId }),
    }),
  googleUnlink: (currentPassword: string) =>
    request<GoogleUnlinkDto>("/api/account/security/google/unlink", {
      method: "POST",
      body: JSON.stringify({ currentPassword }),
    }),
};
