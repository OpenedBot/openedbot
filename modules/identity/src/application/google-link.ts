import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import {
  clearGoogleSubjectRevokingOtherSessions,
  findUserIdByGoogleSubject,
  readGoogleLink,
  writeGoogleSubject,
} from "../sql/accounts";
import type { GoogleIdentity } from "./google-auth";
import { verifyPassword } from "./password-hash";

/**
 * Lier et délier Google depuis « Mon compte ».
 *
 * Lier : l'utilisateur est DÉJÀ connecté (la tentative OAuth porte son id) ;
 * Google ne fait que prouver qu'il tient aussi ce compte Google. L'adresse
 * Google vérifiée doit être celle du compte : un compte Google d'une autre
 * adresse ouvrirait une seconde porte qu'aucun écran ne montre.
 *
 * Délier : seulement s'il reste un mot de passe, sinon le compte n'aurait
 * plus aucune entrée. Le mot de passe actuel est exigé, comme pour le changer.
 */
export async function linkGoogleIdentity(db: Db, userId: string, identity: GoogleIdentity): Promise<void> {
  const account = await readGoogleLink(db, userId);
  if (!account) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "Ce compte n’existe plus.");
  if (account.email.toLowerCase() !== identity.email.toLowerCase()) {
    throw new HttpError(409, "GOOGLE_EMAIL_MISMATCH", "Ce compte Google n’a pas l’adresse de votre compte openedbot.");
  }
  const owner = await findUserIdByGoogleSubject(db, identity.subject);
  if ((owner && owner !== userId) || !await writeGoogleSubject(db, userId, identity.subject)) {
    throw new HttpError(409, "GOOGLE_ALREADY_LINKED", "Ce compte Google est déjà lié à un autre compte openedbot.");
  }
}

/** Délie Google et révoque les autres sessions. Rend leur nombre. */
export async function unlinkGoogle(db: Db, input: {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
}): Promise<number> {
  const account = await readGoogleLink(db, input.userId);
  if (!account) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "Ce compte n’existe plus.");
  if (!account.googleSubject) throw new HttpError(409, "GOOGLE_NOT_LINKED", "Google n’est pas lié à ce compte.");
  if (!account.passwordHash) {
    throw new HttpError(
      409,
      "GOOGLE_UNLINK_NEEDS_PASSWORD",
      "Définissez un mot de passe avant de délier Google : ce serait la seule entrée du compte.",
    );
  }
  if (!(await verifyPassword(input.currentPassword, account.passwordHash))) {
    throw new HttpError(401, "CREDENTIALS_INVALID", "Le mot de passe actuel est invalide.");
  }
  return clearGoogleSubjectRevokingOtherSessions(db, input.userId, input.currentSessionId);
}
