import type { AuthStatus } from "../session/auth-status";
import { clearCloudSession, readWebCsrfToken, syncCloudSession } from "../session/cloud-session";
import { NATIVE_SESSION_MARK, nativeBridge } from "../platform/native-bridge";
import { clearOnboardingDraft } from "../session/onboarding-draft";
import { workspaceInPath } from "../workspace/workspace-location";
import type { AccountSecurityDto, AuthMeDto, AuthStartDto, ChangePasswordDto, ChangePasswordInput, GoogleLinkClaimDto, GoogleUnlinkDto, MemberRoleChangedDto, OrganizationMemberDto, OrganizationPermissionPolicyInput, OrganizationPermissionPolicyView, RevokeSessionsDto } from "@openedbot/contracts-api";
import { isUnauthorized, request } from "./http";
import type { MobileConnectTicketDto } from "./types";
import { apiSelf } from "./self";

export const accountApi = {
  /** Session cloud et organisation courante. */
  authMe: async () => {
    const result = await request<AuthMeDto>("/api/auth/me", undefined, { skipOrganizationHeader: !workspaceInPath(globalThis.window?.location.pathname ?? "") });
    const impersonation = result.impersonation ?? null;
    // Coque native : pas de cookie CSRF, le bearer porte l'identité. La marque
    // tient sa place pour que l'organisation et la personne soient lues comme
    // celles d'une session web, sur toutes les routes et pas seulement `/compact`.
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
      // `=== true` strictement : un cloud API d'avant le drapeau ne dit rien,
      // et un champ absent ne doit pas enfermer une session dans l'écran de
      // sécurité.
      mustChangePassword: result.mustChangePassword === true,
      // The non-core entitlements (`<plug-in>.<feature>`): the pro console
      // screens show only for those held (`src/pro-console/registry.ts`).
      // Absent reads as none.
      ...(result.entitlements ? { entitlements: result.entitlements } : {}),
    };
  },
  /**
   * Les deux lectures du garde de route (`lib/session/auth-status.ts`) en une : le SSO
   * est-il offert, et par quoi cette fenêtre est-elle authentifiée.
   *
   * L'ordre a changé avec le déménagement : c'est l'ÉMETTEUR qui dit qui on
   * est, et le cloud API qui dit si on entre. Une fenêtre sans jeton de
   * rafraîchissement n'interroge personne: elle tient le jeton propriétaire,
   * ou rien.
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
  /** La réponse ne renvoie que l'identifiant et le rôle : la liste se relit après coup. */
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
   * La session locale ne s'oublie qu'une fois la révocation confirmée : un
   * échec laisse le cookie valide, et l'oublier ici ferait croire à une
   * déconnexion. Un 401 a déjà vidé la fenêtre dans `request`.
   */
  logout: async () => {
    await request<void>("/api/auth/logout", { method: "POST" });
    clearOnboardingDraft();
    clearCloudSession();
  },
  /** Écran « Sécurité du compte » : sa méthode de connexion et ses sessions web. */
  accountSecurity: () => request<AccountSecurityDto>("/api/account/security"),
  revokeSession: (sessionId: string) =>
    request<void>(`/api/account/security/sessions/${sessionId}`, { method: "DELETE" }),
  revokeOtherSessions: () =>
    request<RevokeSessionsDto>("/api/account/security/sessions/revoke-others", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /** Mobile Connect : un ticket jetable (10 min) et le lien à montrer en QR à l'app iPhone. */
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
  /** Lier Google depuis « Mon compte » : l'URL Google s'ouvre hors de la fenêtre, la page sonde ensuite `googleLinkClaim`. */
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
