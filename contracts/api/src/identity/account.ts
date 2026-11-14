import type { AuthFailureCode } from "./auth";

/** Screen « Sécurité du compte »: `/api/account/security`. */
export type AccountAuthMethodDto = { email: string; password: boolean; google: boolean };

type AccountSessionKind = "web" | "native";

export type AccountSessionDto = {
  id: string;
  kind: AccountSessionKind;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  userAgent: string | null;
  ip: string | null;
};

/**
 * `mustChangePassword`: the account was created by the team with a temporary
 * password (`users.must_change_password`), and the application does not open
 * until it has been replaced. Only `POST /api/account/security/password`
 * lowers this flag.
 */
export type AccountSecurityDto = {
  method: AccountAuthMethodDto;
  sessions: AccountSessionDto[];
  mustChangePassword: boolean;
};

export type ChangePasswordInput = { currentPassword: string; newPassword: string };

export type ChangePasswordDto = { revokedOtherSessions: number };

/** `POST /api/account/security/google/link/claim`: the outcome of a Google link started from « Mon compte ». */
export type GoogleLinkClaimDto =
  | { status: "pending" }
  | { status: "done" }
  | { status: "failed"; code: AuthFailureCode };

/** `POST /api/account/security/google/unlink`: unlinking Google revokes the other sessions. */
export type GoogleUnlinkDto = { revokedOtherSessions: number };

export type RevokeSessionsDto = { revoked: number };

export type AccountDeletionBlocker = "transfer_required" | "active_subscription" | "tenant_deletion_pending";
export type AccountDeletionDto = {
  reason: string;
  requestedAt: string;
  purgeAfter: string | null;
  inProgress: boolean;
};
export type AccountDeletionStateDto = {
  /** Effective server policy; absent on older APIs, never assume a default. */
  graceDays?: number;
  eligible: boolean;
  blocker: AccountDeletionBlocker | null;
  deletion: AccountDeletionDto | null;
  organizations: Array<{ id: string; name: string; action: "delete" | "leave" }>;
};
