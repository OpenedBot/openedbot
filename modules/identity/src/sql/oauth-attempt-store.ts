import type { AuthClaimDto, AuthFailureCode } from "@openedbot/contracts-api";
import type { SecretKeyring } from "@openedbot/hermes/secrets";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withOauthLookup } from "@openedbot/platform-db";
import { decryptSecretFromKeyring, encryptSecret } from "@openedbot/hermes/secrets";
import { hashCredential, pkceChallenge } from "@openedbot/platform-db/credential";

export type NativeOptions = { codeChallenge: string; redirectUri: string; clientId: string };
/**
 * Une tentative de LIAISON, lancée depuis « Mon compte » par un utilisateur
 * déjà connecté : elle n'ouvre aucune session, et seul cet utilisateur la réclame.
 */
export type LinkOptions = { userId: string };
export type NativeGoogleCompletion = {
  userId: string;
  organizationId: string;
  user: { email: string; displayName: string | null };
};

type AttemptPayload = {
  attemptId: string;
  nonce: string;
  verifier: string;
  native: NativeOptions | null;
  /** Absent des tentatives écrites avant la liaison explicite : lu comme `null`. */
  link?: LinkOptions | null;
  user?: { email: string; displayName: string | null };
  completion?: NativeGoogleCompletion;
};

type AttemptRow = {
  attemptHash: string;
  stateHash: string;
  payloadCiphertext: string;
  payloadNonce: string;
  payloadTag: string;
  payloadKeyId: string;
  returnTo: string | null;
  status: "pending" | "exchanging" | "done_web" | "done_native" | "done_link" | "failed";
  failureCode: AuthFailureCode | null;
  expiresAt: Date;
};

export type CallbackAttempt = {
  attemptId: string;
  nonce: string;
  verifier: string;
  native: NativeOptions | null;
  link: LinkOptions | null;
  returnTo: string | null;
};

export type BeginCallbackResult =
  | { ok: true; attempt: CallbackAttempt }
  | { ok: false; returnTo: string | null };

export type NativeClaimResult =
  | { status: "pending" }
  | { status: "done"; completion: NativeGoogleCompletion; native: NativeOptions }
  | { status: "failed"; code: AuthFailureCode };

export type LinkClaimResult =
  | { status: "pending" }
  | { status: "done" }
  | { status: "failed"; code: AuthFailureCode };

export interface OAuthAttemptStore {
  create(input: {
    attemptId: string;
    state: string;
    nonce: string;
    verifier: string;
    returnTo: string | null;
    native: NativeOptions | null;
    link?: LinkOptions | null;
    expiresAt: Date;
  }): Promise<void>;
  beginCallback(state: string): Promise<BeginCallbackResult>;
  completeWeb(attemptId: string, user: { email: string; displayName: string | null }): Promise<void>;
  completeNative(attemptId: string, completion: NativeGoogleCompletion): Promise<void>;
  completeLink(attemptId: string): Promise<void>;
  fail(attemptId: string, code: AuthFailureCode): Promise<void>;
  claimWeb(attemptId: string): Promise<AuthClaimDto>;
  claimNative(attemptId: string, verifier: string, redirectUri: string): Promise<NativeClaimResult>;
  claimLink(attemptId: string, userId: string): Promise<LinkClaimResult>;
}

export class OAuthAttemptTransitionError extends Error {
  constructor() {
    super("The OAuth attempt is no longer exchangeable.");
    this.name = "OAuthAttemptTransitionError";
  }
}

export function createPostgresOAuthAttemptStore(db: Db, keyring: SecretKeyring): OAuthAttemptStore {
  const encryptPayload = (payload: AttemptPayload) => {
    const encrypted = encryptSecret(JSON.stringify(payload), keyring.current.value);
    return { ...encrypted, keyId: keyring.current.id };
  };

  const decryptPayload = (row: AttemptRow): AttemptPayload => {
    const decrypted = decryptSecretFromKeyring(
      { ciphertext: row.payloadCiphertext, nonce: row.payloadNonce, tag: row.payloadTag },
      row.payloadKeyId,
      keyring,
    );
    return JSON.parse(decrypted.value) as AttemptPayload;
  };

  async function lookupByAttempt<T>(attemptId: string, callback: (tx: TransactionDb, hash: string) => Promise<T>): Promise<T> {
    const hash = hashCredential(attemptId);
    return withOauthLookup(db, hash, (tx) => callback(tx, hash));
  }

  async function writeOutcome(
    attemptId: string,
    status: AttemptRow["status"],
    mutate: (payload: AttemptPayload) => AttemptPayload,
    failureCode: AuthFailureCode | null = null,
    allowedStatuses: AttemptRow["status"][] = ["exchanging"],
  ): Promise<boolean> {
    return lookupByAttempt(attemptId, async (tx, attemptHash) => {
      const rows = await tx<AttemptRow[]>`
        select attempt_hash as "attemptHash", state_hash as "stateHash",
               payload_ciphertext as "payloadCiphertext", payload_nonce as "payloadNonce",
               payload_tag as "payloadTag", payload_key_id as "payloadKeyId",
               return_to as "returnTo", status, failure_code as "failureCode", expires_at as "expiresAt"
          from oauth_attempts
         where attempt_hash = ${attemptHash}
         for update
      `;
      const row = rows[0];
      if (!row || !allowedStatuses.includes(row.status)) return false;
      const encrypted = encryptPayload(mutate(decryptPayload(row)));
      await tx`
        update oauth_attempts
           set status = ${status}, failure_code = ${failureCode},
               payload_ciphertext = ${encrypted.ciphertext}, payload_nonce = ${encrypted.nonce},
               payload_tag = ${encrypted.tag}, payload_key_id = ${encrypted.keyId}, updated_at = now()
         where attempt_hash = ${attemptHash}
      `;
      return true;
    });
  }

  return {
    async create(input) {
      const attemptHash = hashCredential(input.attemptId);
      const stateHash = hashCredential(input.state);
      const encrypted = encryptPayload({
        attemptId: input.attemptId,
        nonce: input.nonce,
        verifier: input.verifier,
        native: input.native,
        link: input.link ?? null,
      });
      await withOauthLookup(db, attemptHash, async (tx) => {
        await tx`select purge_expired_oauth_attempts()`;
        await tx`
          insert into oauth_attempts (
            attempt_hash, state_hash, payload_ciphertext, payload_nonce, payload_tag,
            payload_key_id, return_to, expires_at
          ) values (
            ${attemptHash}, ${stateHash}, ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.tag},
            ${encrypted.keyId}, ${input.returnTo}, ${input.expiresAt}
          )
        `;
      });
    },

    async beginCallback(state) {
      const stateHash = hashCredential(state);
      return withOauthLookup(db, stateHash, async (tx): Promise<BeginCallbackResult> => {
        const rows = await tx<AttemptRow[]>`
          update oauth_attempts
             set status = 'exchanging',
                 -- Une callback commencée garde cinq minutes pour les appels
                 -- Google/DB et le claim du client, même si les dix minutes
                 -- initiales expirent pendant cet échange.
                 expires_at = greatest(expires_at, now() + interval '5 minutes'),
                 updated_at = now()
           where state_hash = ${stateHash} and status = 'pending' and expires_at > now()
          returning attempt_hash as "attemptHash", state_hash as "stateHash",
                    payload_ciphertext as "payloadCiphertext", payload_nonce as "payloadNonce",
                    payload_tag as "payloadTag", payload_key_id as "payloadKeyId",
                    return_to as "returnTo", status, failure_code as "failureCode", expires_at as "expiresAt"
        `;
        const row = rows[0];
        if (!row) {
          const known = await tx<Array<{ returnTo: string | null }>>`
            select return_to as "returnTo" from oauth_attempts where state_hash = ${stateHash}
          `;
          return { ok: false, returnTo: known[0]?.returnTo ?? null };
        }
        try {
          const payload = decryptPayload(row);
          return {
            ok: true,
            attempt: {
              attemptId: payload.attemptId,
              nonce: payload.nonce,
              verifier: payload.verifier,
              native: payload.native,
              link: payload.link ?? null,
              returnTo: row.returnTo,
            },
          };
        } catch {
          await tx`
            update oauth_attempts set status = 'failed', failure_code = 'AUTH_STATE_INVALID', updated_at = now()
             where state_hash = ${stateHash}
          `;
          return { ok: false, returnTo: row.returnTo };
        }
      });
    },

    async completeWeb(attemptId, user) {
      if (!await writeOutcome(attemptId, "done_web", (payload) => ({ ...payload, user }))) {
        throw new OAuthAttemptTransitionError();
      }
    },
    async completeNative(attemptId, completion) {
      if (!await writeOutcome(attemptId, "done_native", (payload) => ({ ...payload, completion }))) {
        throw new OAuthAttemptTransitionError();
      }
    },
    async completeLink(attemptId) {
      if (!await writeOutcome(attemptId, "done_link", (payload) => payload)) {
        throw new OAuthAttemptTransitionError();
      }
    },
    async fail(attemptId, code) {
      await writeOutcome(
        attemptId,
        "failed",
        (payload) => payload,
        code,
        ["exchanging", "done_web", "done_native", "done_link"],
      );
    },

    async claimLink(attemptId, userId) {
      return lookupByAttempt(attemptId, async (tx, attemptHash): Promise<LinkClaimResult> => {
        const rows = await tx<AttemptRow[]>`
          select attempt_hash as "attemptHash", state_hash as "stateHash",
                 payload_ciphertext as "payloadCiphertext", payload_nonce as "payloadNonce",
                 payload_tag as "payloadTag", payload_key_id as "payloadKeyId",
                 return_to as "returnTo", status, failure_code as "failureCode", expires_at as "expiresAt"
            from oauth_attempts where attempt_hash = ${attemptHash} for update
        `;
        const row = rows[0];
        if (!row || row.expiresAt.getTime() <= Date.now()) {
          if (row) await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
          return { status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" };
        }
        let payload: AttemptPayload;
        try {
          payload = decryptPayload(row);
        } catch {
          await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
          return { status: "failed", code: "AUTH_STATE_INVALID" };
        }
        // La tentative d'un autre utilisateur, ou une connexion ordinaire :
        // indistinguable d'une inconnue, et laissée intacte pour son titulaire.
        if (!payload.link || payload.link.userId !== userId) {
          return { status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" };
        }
        if (row.status === "pending" || row.status === "exchanging") return { status: "pending" };
        await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
        if (row.status === "failed") return { status: "failed", code: row.failureCode ?? "AUTH_EXCHANGE_FAILED" };
        if (row.status !== "done_link") return { status: "failed", code: "AUTH_STATE_INVALID" };
        return { status: "done" };
      });
    },

    async claimWeb(attemptId) {
      return lookupByAttempt(attemptId, async (tx, attemptHash): Promise<AuthClaimDto> => {
        const rows = await tx<AttemptRow[]>`
          select attempt_hash as "attemptHash", state_hash as "stateHash",
                 payload_ciphertext as "payloadCiphertext", payload_nonce as "payloadNonce",
                 payload_tag as "payloadTag", payload_key_id as "payloadKeyId",
                 return_to as "returnTo", status, failure_code as "failureCode", expires_at as "expiresAt"
            from oauth_attempts where attempt_hash = ${attemptHash} for update
        `;
        const row = rows[0];
        if (!row || row.expiresAt.getTime() <= Date.now()) {
          if (row) await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
          return { status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" };
        }
        if (row.status === "pending" || row.status === "exchanging") return { status: "pending" };
        await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
        if (row.status === "failed") return { status: "failed", code: row.failureCode ?? "AUTH_EXCHANGE_FAILED" };
        if (row.status !== "done_web") return { status: "failed", code: "AUTH_STATE_INVALID" };
        try {
          const payload = decryptPayload(row);
          return payload.user
            ? { status: "done", user: payload.user }
            : { status: "failed", code: "AUTH_STATE_INVALID" };
        } catch {
          return { status: "failed", code: "AUTH_STATE_INVALID" };
        }
      });
    },

    async claimNative(attemptId, verifier, redirectUri) {
      return lookupByAttempt(attemptId, async (tx, attemptHash): Promise<NativeClaimResult> => {
        const rows = await tx<AttemptRow[]>`
          select attempt_hash as "attemptHash", state_hash as "stateHash",
                 payload_ciphertext as "payloadCiphertext", payload_nonce as "payloadNonce",
                 payload_tag as "payloadTag", payload_key_id as "payloadKeyId",
                 return_to as "returnTo", status, failure_code as "failureCode", expires_at as "expiresAt"
            from oauth_attempts where attempt_hash = ${attemptHash} for update
        `;
        const row = rows[0];
        if (!row || row.expiresAt.getTime() <= Date.now()) {
          if (row) await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
          return { status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" };
        }
        let payload: AttemptPayload;
        try {
          payload = decryptPayload(row);
        } catch {
          await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
          return { status: "failed", code: "AUTH_STATE_INVALID" };
        }
        if (!payload.native || payload.native.redirectUri !== redirectUri ||
            (await pkceChallenge(verifier)) !== payload.native.codeChallenge) {
          return { status: "failed", code: "AUTH_STATE_INVALID" };
        }
        if (row.status === "pending" || row.status === "exchanging") return { status: "pending" };
        await tx`delete from oauth_attempts where attempt_hash = ${attemptHash}`;
        if (row.status === "failed") return { status: "failed", code: row.failureCode ?? "AUTH_EXCHANGE_FAILED" };
        if (row.status !== "done_native" || !payload.completion) {
          return { status: "failed", code: "AUTH_STATE_INVALID" };
        }
        return { status: "done", completion: payload.completion, native: payload.native };
      });
    },
  };
}
