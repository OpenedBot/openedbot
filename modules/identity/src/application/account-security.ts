import type { AccountSecurityDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { passwordProblem } from "../domain/password";
import { readAccountSecurity, readPasswordHash, replacePasswordRevokingOtherSessions } from "../sql/accounts";
import { listUserSessions, revokeOtherUserSessions, revokeUserSession } from "../sql/sessions";

/**
 * Écran « Sécurité du compte » : ses propres sessions et sa méthode de
 * connexion. La porte RLS de `sessions` ouverte par la migration 0019 est
 * `app.authenticating_user_id`, pas `app.organization_id` : le mot de passe
 * et les sessions sont une propriété de l'utilisateur, pas de l'organisation
 * courante. `users` n'a pas de RLS : sa lecture ne passe par aucun wrapper.
 */
export async function readAccountSecurityView(
  db: Db,
  input: { userId: string; currentSessionId: string },
): Promise<AccountSecurityDto> {
  const user = await readAccountSecurity(db, input.userId);
  if (!user) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "Ce compte n’existe plus.");
  const sessions = await listUserSessions(db, input.userId);
  return {
    method: { email: user.email, password: user.hasPassword, google: user.hasGoogle },
    mustChangePassword: user.mustChangePassword,
    sessions: sessions.map((row) => ({
      id: row.id,
      kind: row.kind,
      current: row.id === input.currentSessionId,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedReason: row.revokedReason,
      userAgent: row.userAgent,
      ip: row.ip,
    })),
  };
}

export async function revokeOwnSession(
  db: Db,
  input: { userId: string; currentSessionId: string; sessionId: string },
): Promise<void> {
  if (input.sessionId === input.currentSessionId) {
    throw new HttpError(409, "SESSION_IS_CURRENT", "Utilisez « Se déconnecter » pour la session courante.");
  }
  // Inconnue, déjà révoquée ou appartenant à un autre utilisateur :
  // volontairement indistinguable, les trois répondent 404.
  if (!await revokeUserSession(db, input.userId, input.sessionId)) {
    throw new HttpError(404, "SESSION_NOT_FOUND", "Cette session n’existe pas.");
  }
}

export function revokeOtherOwnSessions(
  db: Db,
  input: { userId: string; currentSessionId: string },
): Promise<number> {
  return revokeOtherUserSessions(db, input.userId, input.currentSessionId);
}

/** Vérifie l'ancien mot de passe, valide le nouveau, puis le remplace et révoque les autres sessions. Rend leur nombre. */
export async function changeOwnPassword(db: Db, input: {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<number> {
  const passwordHash = await readPasswordHash(db, input.userId);
  if (!passwordHash) {
    throw new HttpError(409, "PASSWORD_NOT_SET", "Ce compte se connecte uniquement par Google.");
  }
  if (!(await Bun.password.verify(input.currentPassword, passwordHash))) {
    throw new HttpError(401, "CREDENTIALS_INVALID", "Le mot de passe actuel est invalide.");
  }

  const problem = passwordProblem(input.newPassword, input.currentPassword);
  if (problem === "unchanged") {
    throw new HttpError(400, "PASSWORD_UNCHANGED", "Le nouveau mot de passe doit différer de l’actuel.");
  }
  // Tout ce qui n'est pas `unchanged` est un défaut de FORME. Le test nommait
  // les deux verdicts de longueur, si bien qu'une règle ajoutée à
  // `passwordProblem` (majuscule, caractère spécial) serait passée au travers
  // et l'API aurait accepté ce que le client refusait déjà.
  if (problem !== null) {
    throw new HttpError(
      400,
      "PASSWORD_TOO_WEAK",
      "Le nouveau mot de passe doit faire 12 caractères, avec une majuscule et un caractère spécial.",
    );
  }

  const nextHash = await Bun.password.hash(input.newPassword, { algorithm: "argon2id" });
  return replacePasswordRevokingOtherSessions(db, input.userId, nextHash, input.currentSessionId);
}
