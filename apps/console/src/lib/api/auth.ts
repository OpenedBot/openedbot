import { readCloudSession, saveCloudSession } from "../session/cloud-session";
import { readInitialLocale } from "@openedbot/browser-i18n";
import type { AccountWorkspacesDto, AuthClaimDto, AuthProvidersDto, AuthStartDto, AuthUserDto, CreatedOrganizationDto, CreateOrganizationInput, EmailLoginCodeDto, EmailLoginDto, PasswordLoginCodeRequiredDto } from "@openedbot/contracts-api";
import { primeWorkspaceDirectory, request, sharedRead } from "./http";
import { apiSelf } from "./self";

export const authApi = {
  authProviders: () => request<AuthProvidersDto>("/api/auth/providers"),
  authStart: (returnTo?: string) => {
    return request<AuthStartDto>("/api/auth/google/start", {
      method: "POST",
      body: JSON.stringify({ returnTo: returnTo ?? null }),
    });
  },
  authEmailCode: (email: string, locale: string) => request<EmailLoginCodeDto>("/api/auth/login/code", {
    method: "POST", body: JSON.stringify({ email, locale }),
  }, { skipOrganizationHeader: true }),
  /**
   * `beforeSession` runs once the code is accepted and before the session is
   * saved, which is what makes the root guard leave `/login`: the screen holds
   * its success state for that long.
   */
  authEmailLogin: async (email: string, code: string, beforeSession?: () => Promise<void>) => {
    const result = await request<EmailLoginDto>("/api/auth/login/code/verify", {
      method: "POST", body: JSON.stringify({ email, code }),
    }, { skipOrganizationHeader: true });
    await Promise.all([primeWorkspaceDirectory(), beforeSession?.()]);
    saveCloudSession({ organizationId: result.organizationId ?? "", csrfToken: result.csrfToken, userId: result.user.id });
    return result;
  },
  /** Password sign-in against the central SaaS API. */
  authPasswordLogin: async (
    email: string,
    password: string,
    emailCode?: string,
  ): Promise<PasswordLoginCodeRequiredDto | { status: "signed_in"; token: string; user: AuthUserDto }> => {
    const result = await request<PasswordLoginCodeRequiredDto | {
      status?: undefined;
      csrfToken: string;
      organizationId: string | null;
      user: { id: string; email: string; displayName?: string | null };
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, emailCode, locale: readInitialLocale() }),
    });
    if (result.status === "code_required") return result;
    // The slug directory is filled BEFORE the session is announced: the router
    // navigation it wakes up writes `/o/<slug>/`, never the legacy `/o/<uuid>/`.
    await primeWorkspaceDirectory();
    saveCloudSession({ organizationId: result.organizationId ?? "", csrfToken: result.csrfToken, userId: result.user.id });
    return {
      status: "signed_in",
      token: result.csrfToken,
      user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName ?? null },
    };
  },
  /** Fetches the result of a Google attempt on the SaaS API side. */
  authClaim: (attemptId: string) =>
    request<AuthClaimDto>("/api/auth/attempts/claim", {
      method: "POST",
      body: JSON.stringify({ attemptId }),
    }),
  accountWorkspaces: () => request<AccountWorkspacesDto>("/api/account/workspaces", undefined, { skipOrganizationHeader: true }),
  /** The guards of one navigation and the frame mounting with them share a single read (1 s). */
  accountWorkspacesForNavigation: () =>
    sharedRead(`workspaces:${readCloudSession()?.userId ?? ""}`, () => apiSelf().accountWorkspaces(), 1_000),
  primeWorkspaceDirectory: () => primeWorkspaceDirectory(),
  /** The account's own organization, created by the welcome flow. */
  createOrganization: (input: CreateOrganizationInput) => request<CreatedOrganizationDto>("/api/account/organizations", {
    method: "POST", body: JSON.stringify(input),
  }, { skipOrganizationHeader: true }),
};
