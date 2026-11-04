import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { hashCredential, pkceChallenge, randomCredential } from "@openedbot/platform-db/credential";
import { recordUserLogin } from "../sql/accounts";
import { consumeNativeAuthCode, insertNativeAuthCode } from "../sql/native-auth-codes";
import { createNativeSession, rotateNativeSession, type SessionDevice } from "../sql/sessions";

/**
 * Émet un code d'autorisation natif (PKCE) pour un compte déjà authentifié.
 * Le code en clair n'existe qu'ici et dans la réponse : la base ne garde que son hachage.
 */
export async function issueNativeAuthCode(db: Db, input: {
  /** `null` : le compte définira son organisation dans l'onboarding du desktop. */
  organizationId: string | null;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
}): Promise<string> {
  const code = randomCredential();
  await insertNativeAuthCode(db, { ...input, codeHash: hashCredential(code) });
  return code;
}

/**
 * Échange un code d'autorisation contre une session native. C'est ICI que
 * l'entrée native est datée, et pas à l'émission du code : le code vient
 * forcément d'une authentification réussie (mot de passe ou Google), et son
 * échange est le moment où la session s'ouvre. Le dater aux deux endroits
 * compterait deux fois la même connexion.
 */
export async function exchangeNativeAuthCode(db: Db, input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** L'appareil qui échange le code, pour l'écran « Sécurité du compte ». */
  device: SessionDevice;
}) {
  const row = await consumeNativeAuthCode(db, hashCredential(input.code), async (found) =>
    found.redirectUri === input.redirectUri && (await pkceChallenge(input.codeVerifier)) === found.codeChallenge);
  if (!row) throw new HttpError(400, "AUTH_CODE_INVALID", "Le code natif est invalide ou expiré.");
  const session = await createNativeSession(db, row.organizationId, row.userId, input.device);
  await recordUserLogin(db, row.userId);
  return session;
}

/**
 * Pas de `recordUserLogin` ici : une rotation prolonge une entrée déjà
 * datée, elle n'en ouvre pas une nouvelle (voir `recordUserLogin`). La
 * rotation entière est une seule transaction (`rotateNativeSession`).
 */
export async function refreshNativeSession(db: Db, refreshToken: string, device: SessionDevice) {
  const session = await rotateNativeSession(db, hashCredential(refreshToken), device);
  if (!session) throw new HttpError(401, "REFRESH_TOKEN_INVALID", "Le refresh token est invalide ou révoqué.");
  return session;
}
