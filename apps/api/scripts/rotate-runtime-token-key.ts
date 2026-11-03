import "@openedbot/platform-config/legacy-env-guard"; // first: refuses a retired OHB_* variable before any module reads the environment
import { SQL } from "bun";
import { decryptSecretFromKeyring, encryptSecret } from "@openedbot/hermes/secrets";
import { readApiConfig } from "../src/infrastructure/config";

/** Une ligne `reachability = 'direct'` : ses colonnes token_* sont non nulles par contrainte. */
type StoredRuntimeToken = {
  id: string;
  tokenCiphertext: string;
  tokenNonce: string;
  tokenTag: string;
  tokenKeyId: string | null;
};

const config = readApiConfig();
const databaseUrl = process.env.WORKER_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("WORKER_DATABASE_URL is required to rotate runtime tokens.");
const db = new SQL(databaseUrl);

try {
  const rotated = await db.begin(async (tx) => {
    const runtimes = await tx<StoredRuntimeToken[]>`
      select id, token_ciphertext as "tokenCiphertext", token_nonce as "tokenNonce",
             token_tag as "tokenTag", token_key_id as "tokenKeyId"
        from runtimes
       -- Un runtime joint par le connecteur ne porte aucun bearer : rien à
       -- ré-encrypter, et ses colonnes token_* sont NULL par contrainte.
       where revoked_at is null and reachability = 'direct'
       for update
    `;
    let count = 0;
    for (const runtime of runtimes) {
      const decrypted = decryptSecretFromKeyring(
        {
          ciphertext: runtime.tokenCiphertext,
          nonce: runtime.tokenNonce,
          tag: runtime.tokenTag,
        },
        runtime.tokenKeyId,
        config.tokenEncryption,
      );
      if (!decrypted.needsRotation && runtime.tokenKeyId === config.tokenEncryption.current.id) continue;

      const encrypted = encryptSecret(decrypted.value, config.tokenEncryption.current.value);
      await tx`
        update runtimes
           set token_ciphertext = ${encrypted.ciphertext}, token_nonce = ${encrypted.nonce},
               token_tag = ${encrypted.tag}, token_key_id = ${config.tokenEncryption.current.id},
               updated_at = now()
         where id = ${runtime.id}
      `;
      count += 1;
    }
    return count;
  });
  console.info(JSON.stringify({ event: "runtime_tokens.rotated", rotated }));
} finally {
  await db.close();
}
