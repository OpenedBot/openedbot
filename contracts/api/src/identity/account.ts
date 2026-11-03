import type { AuthFailureCode } from "./auth";

/** Écran « Sécurité du compte » : `/api/account/security`. */
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
 * `mustChangePassword` : le compte a été créé par l'équipe avec un mot de passe
 * temporaire (`users.must_change_password`), et l'application ne s'ouvre pas
 * tant qu'il n'a pas été remplacé. Seul `POST /api/account/security/password`
 * baisse ce drapeau.
 */
export type AccountSecurityDto = {
  method: AccountAuthMethodDto;
  sessions: AccountSessionDto[];
  mustChangePassword: boolean;
};

export type ChangePasswordInput = { currentPassword: string; newPassword: string };

export type ChangePasswordDto = { revokedOtherSessions: number };

/** `POST /api/account/security/google/link/claim` : l’issue d’une liaison Google lancée depuis « Mon compte ». */
export type GoogleLinkClaimDto =
  | { status: "pending" }
  | { status: "done" }
  | { status: "failed"; code: AuthFailureCode };

/** `POST /api/account/security/google/unlink` : délier Google révoque les autres sessions. */
export type GoogleUnlinkDto = { revokedOtherSessions: number };

export type RevokeSessionsDto = { revoked: number };
