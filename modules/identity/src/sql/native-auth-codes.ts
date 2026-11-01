import type { Db } from "@openedbot/platform-db";
import { withCredential, withTenant } from "@openedbot/platform-db";

/** Un code d'autorisation natif vit cinq minutes : le temps d'aller chercher le jeton, pas davantage. */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1_000;

export type NativeAuthCodeInsert = {
  organizationId: string;
  userId: string;
  codeHash: string;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
};

export type NativeAuthCodeRow = {
  id: string;
  organizationId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
};

export async function insertNativeAuthCode(db: Db, code: NativeAuthCodeInsert): Promise<void> {
  await withTenant(db, code.organizationId, async (tx) => {
    await tx`
      insert into native_auth_codes (
        id, organization_id, user_id, code_hash, code_challenge, redirect_uri, client_id, expires_at
      ) values (
        ${crypto.randomUUID()}, ${code.organizationId}, ${code.userId}, ${code.codeHash},
        ${code.codeChallenge}, ${code.redirectUri}, ${code.clientId}, ${new Date(Date.now() + AUTH_CODE_TTL_MS)}
      )
    `;
  });
}

/**
 * Cherche le code, verrouille sa ligne, laisse l'appelant le juger (URI de
 * retour, vérificateur PKCE) et ne le marque consommé que s'il est accepté :
 * un échange refusé n'épuise pas un code légitime.
 */
export async function consumeNativeAuthCode(
  db: Db,
  codeHash: string,
  accepts: (found: NativeAuthCodeRow) => Promise<boolean>,
): Promise<NativeAuthCodeRow | null> {
  return withCredential(db, codeHash, async (tx) => {
    const rows = await tx<NativeAuthCodeRow[]>`
      select id, organization_id as "organizationId", user_id as "userId",
             code_challenge as "codeChallenge", redirect_uri as "redirectUri"
        from native_auth_codes
       where code_hash = ${codeHash} and consumed_at is null and expires_at > now()
       for update
    `;
    const found = rows[0];
    if (!found) return null;
    if (!await accepts(found)) return null;
    await tx`update native_auth_codes set consumed_at = now() where id = ${found.id}`;
    return found;
  });
}
