import { randomBytes } from "node:crypto";
import type {
  RelayAuditAnchorFrame,
  RelayAuditKeyFrame,
  RelayAuditKeyRef,
} from "@openedbot/contracts-connector";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { decryptSecretFromKeyring, encryptSecret, SecretDecryptionError, type SecretKeyring } from "@openedbot/hermes/secrets";
import type { TransactionDb } from "@openedbot/platform-db";

/**
 * Les clés maîtresses de l'audit de création (OHB-53 côté hôte).
 *
 * Une clé par runtime, tirée par l'API, chiffrée par le keyring des bearers
 * (`RUNTIME_TOKEN_ENCRYPTION_KEY`) et remise au connecteur à chaque session
 * par `audit.key`. Elle n'est jamais écrite sur le VPS : un `sudo cat` y
 * trouve un fichier scellé et rien pour l'ouvrir. La rotation crée une
 * nouvelle ligne, retire l'ancienne (`retired_at`) et la pousse encore dans
 * `previous` jusqu'à ce qu'une ancre sous le nouveau `keyId` prouve que
 * l'hôte a rescellé ; une clé retirée n'est jamais purgée tant que le
 * runtime existe, pour ouvrir les exports scellés sous elle.
 */
export const AUDIT_MASTER_KEY_BYTES = 32;
/** `audit.key` remet la clé courante et au plus deux clés retirées non encore rescellées. */
export const AUDIT_PREVIOUS_KEYS_LIMIT = 2;

export type AuditKeyRow = {
  keyId: string;
  ciphertext: string;
  nonce: string;
  tag: string;
  keyEncryptionKeyId: string;
  createdAt: Date | string;
  retiredAt: Date | string | null;
};

export type AuditKeyMaterial = { keyId: string; key: Uint8Array; retired: boolean };

export function readAuditKeyRows(tx: TransactionDb, organizationId: string, runtimeId: string) {
  return tx<AuditKeyRow[]>`
    select key_id as "keyId", ciphertext, nonce, tag, key_encryption_key_id as "keyEncryptionKeyId",
           created_at as "createdAt", retired_at as "retiredAt"
      from runtime_audit_keys
     where organization_id = ${organizationId} and runtime_id = ${runtimeId}
     order by created_at desc
  `;
}

/** Déchiffre une ligne avec le keyring ; une clé de keyring absente est une panne franche, pas un silence. */
export function decryptAuditKey(row: AuditKeyRow, keyring: SecretKeyring): AuditKeyMaterial {
  const decrypted = decryptSecretFromKeyring(
    { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag },
    row.keyEncryptionKeyId,
    keyring,
  );
  const key = Buffer.from(decrypted.value, "base64");
  if (key.byteLength !== AUDIT_MASTER_KEY_BYTES) throw new SecretDecryptionError(`The audit key ${row.keyId} is not ${AUDIT_MASTER_KEY_BYTES} bytes.`);
  return { keyId: row.keyId, key: new Uint8Array(key), retired: row.retiredAt !== null };
}

async function insertAuditKey(tx: TransactionDb, organizationId: string, runtimeId: string, keyring: SecretKeyring): Promise<AuditKeyMaterial> {
  const key = randomBytes(AUDIT_MASTER_KEY_BYTES);
  const keyId = crypto.randomUUID();
  const encrypted = encryptSecret(key.toString("base64"), keyring.current.value);
  await tx`
    insert into runtime_audit_keys (organization_id, runtime_id, key_id, ciphertext, nonce, tag, key_encryption_key_id)
    values (${organizationId}, ${runtimeId}, ${keyId}, ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.tag}, ${keyring.current.id})
  `;
  return { keyId, key: new Uint8Array(key), retired: false };
}

/**
 * La clé courante du runtime, créée si elle n'existe pas, et les clés
 * retirées encore à remettre (les plus récentes d'abord, bornées). Appelée
 * sous la porte du credential du lien au `bind`, ou sous la porte tenant.
 */
export async function ensureAuditKey(
  tx: TransactionDb,
  organizationId: string,
  runtimeId: string,
  keyring: SecretKeyring,
): Promise<{ current: AuditKeyMaterial; previous: AuditKeyMaterial[] }> {
  const rows = await readAuditKeyRows(tx, organizationId, runtimeId);
  const currentRow = rows.find((row) => row.retiredAt === null);
  const current = currentRow ? decryptAuditKey(currentRow, keyring) : await insertAuditKey(tx, organizationId, runtimeId, keyring);
  const previous = rows
    .filter((row) => row.retiredAt !== null)
    .slice(0, AUDIT_PREVIOUS_KEYS_LIMIT)
    .map((row) => decryptAuditKey(row, keyring));
  return { current, previous };
}

/**
 * Retire la clé courante et en crée une nouvelle ; rend la trame à pousser sur le lien.
 *
 * Le snapshot de l'hôte est scellé sous la clé de sa dernière ancre, ou sous
 * une clé plus récente qu'il a reçue depuis. `audit.key` n'en remet que deux
 * retirées (borne du protocole) : une rotation qui en rendrait davantage
 * nécessaires laisserait un hôte longtemps déconnecté face à une clé inconnue,
 * audit désarmé. Elle est refusée tant qu'une ancre ne prouve pas le rescellement.
 */
export async function rotateAuditKey(
  tx: TransactionDb,
  organizationId: string,
  runtimeId: string,
  keyring: SecretKeyring,
): Promise<{ current: AuditKeyMaterial; previous: AuditKeyMaterial[] }> {
  const rows = await readAuditKeyRows(tx, organizationId, runtimeId);
  const anchor = await readAuditAnchor(tx, organizationId, runtimeId);
  // Lignes de la plus récente à la plus ancienne : toutes celles depuis la clé
  // ancrée (elle comprise) deviennent retirées-nécessaires ; sans ancre connue, toutes.
  const anchoredIndex = anchor ? rows.findIndex((row) => row.keyId === anchor.keyId) : -1;
  const neededAfterRotation = anchoredIndex >= 0 ? anchoredIndex + 1 : rows.length;
  if (neededAfterRotation > AUDIT_PREVIOUS_KEYS_LIMIT) {
    throw new HttpError(
      409,
      "AUDIT_KEY_RESEAL_PENDING",
      "L’hôte n’a pas encore rescellé son audit sous les clés précédentes : reconnectez-le avant une nouvelle rotation.",
    );
  }
  await tx`
    update runtime_audit_keys set retired_at = now()
     where organization_id = ${organizationId} and runtime_id = ${runtimeId} and retired_at is null
  `;
  return ensureAuditKey(tx, organizationId, runtimeId, keyring);
}

/** La trame `audit.key` d'un jeu de clés. La clé part en base64 ; jamais journalisée. */
export function auditKeyFrame(runtimeId: string, keys: { current: AuditKeyMaterial; previous: AuditKeyMaterial[] }): RelayAuditKeyFrame {
  const previous: RelayAuditKeyRef[] = keys.previous.map((entry) => ({ keyId: entry.keyId, key: Buffer.from(entry.key).toString("base64") }));
  return {
    t: "audit.key",
    runtimeId,
    keyId: keys.current.keyId,
    key: Buffer.from(keys.current.key).toString("base64"),
    ...(previous.length > 0 ? { previous } : {}),
  };
}

export type AuditAnchorRow = {
  keyId: string;
  writeSeq: number;
  eventCount: number;
  dropped: number;
  tail: string;
  receivedAt: Date | string;
};

export async function readAuditAnchor(tx: TransactionDb, organizationId: string, runtimeId: string): Promise<AuditAnchorRow | null> {
  const rows = await tx<Array<{ keyId: string; writeSeq: string | number; eventCount: number; dropped: string | number; tail: string; receivedAt: Date | string }>>`
    select key_id as "keyId", write_seq as "writeSeq", event_count as "eventCount", dropped, tail, received_at as "receivedAt"
      from runtime_audit_anchors
     where organization_id = ${organizationId} and runtime_id = ${runtimeId}
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { ...row, writeSeq: Number(row.writeSeq), dropped: Number(row.dropped) };
}

export type AnchorWrite = "recorded" | "regressed" | "conflicting" | "unknown_key";

/**
 * Enregistre la dernière ancre d'un runtime. Un `writeSeq` en recul n'écrase
 * jamais l'ancre courante : c'est un hôte qui rejoue une position ancienne
 * (fichier restauré, ou deux copies du même runtime) et cela se journalise.
 * Au même `writeSeq`, seul un doublon strict est idempotent : un contenu
 * différent (`conflicting`) est refusé, sinon l'ancre courante divergerait du
 * maillon déjà chaîné sous cette position. Une clé inconnue est refusée :
 * l'hôte ne peut ancrer que sous une clé que l'API lui a remise.
 */
export async function recordAuditAnchor(
  tx: TransactionDb,
  organizationId: string,
  runtimeId: string,
  frame: RelayAuditAnchorFrame,
): Promise<AnchorWrite> {
  const known = await tx<Array<{ keyId: string }>>`
    select key_id as "keyId" from runtime_audit_keys
     where organization_id = ${organizationId} and runtime_id = ${runtimeId} and key_id = ${frame.keyId}
     limit 1
  `;
  if (!known.length) return "unknown_key";
  const written = await tx<Array<{ runtimeId: string }>>`
    insert into runtime_audit_anchors (runtime_id, organization_id, key_id, write_seq, event_count, dropped, tail, received_at)
    values (${runtimeId}, ${organizationId}, ${frame.keyId}, ${frame.writeSeq}, ${frame.count}, ${frame.dropped}, ${frame.tail}, now())
    on conflict (runtime_id) do update
      set key_id = excluded.key_id, write_seq = excluded.write_seq, event_count = excluded.event_count,
          dropped = excluded.dropped, tail = excluded.tail, received_at = now()
      where runtime_audit_anchors.write_seq < excluded.write_seq
         or (runtime_audit_anchors.write_seq = excluded.write_seq
             and runtime_audit_anchors.key_id = excluded.key_id
             and runtime_audit_anchors.event_count = excluded.event_count
             and runtime_audit_anchors.dropped = excluded.dropped
             and runtime_audit_anchors.tail = excluded.tail)
    returning runtime_id as "runtimeId"
  `;
  if (written.length) return "recorded";
  const current = await readAuditAnchor(tx, organizationId, runtimeId);
  return current?.writeSeq === frame.writeSeq ? "conflicting" : "regressed";
}
