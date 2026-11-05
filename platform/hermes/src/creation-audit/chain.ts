import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical";

/**
 * La chaîne de hachage de l'audit de création (`docs/CONNECTOR.md`, « Audit
 * de création chiffré ») :
 *
 *   base = SHA-256("openedbot-creation-audit/v2/genesis" || runtimeId)
 *   h_i  = SHA-256(0x01 || canonical(e_i) || h_{i-1})
 *   tail = h_count
 *
 * Quand l'anneau du connecteur déborde, `base` devient le hachage du dernier
 * événement sorti et `dropped` s'incrémente : chaque événement retenu reste
 * prouvable depuis `base`. Un vérificateur recalcule `tail` depuis `base` ;
 * un désaccord est une troncature, un réordonnancement ou une invention.
 */
export const CREATION_AUDIT_GENESIS_PREFIX = "openedbot-creation-audit/v2/genesis";

const HASH_HEX = /^[0-9a-f]{64}$/;

export function auditGenesis(runtimeId: string): string {
  return createHash("sha256").update(CREATION_AUDIT_GENESIS_PREFIX + runtimeId).digest("hex");
}

export function chainNext(previousHex: string, event: unknown): string {
  if (!HASH_HEX.test(previousHex)) throw new Error(`chain hash ${previousHex} is not a hex SHA-256`);
  return createHash("sha256")
    .update(Uint8Array.of(0x01))
    .update(canonicalJson(event))
    .update(Buffer.from(previousHex, "hex"))
    .digest("hex");
}

export type ChainVerdict =
  | { ok: true; tail: string }
  | { ok: false; reason: "base" | "tail" | "count"; computed: string };

/**
 * Recalcule la chaîne depuis `base` sur `events` et la compare au `tail`
 * déclaré. `count` doit valoir le nombre d'événements retenus : un compteur
 * qui ment est refusé avant même de hacher.
 */
export function verifyChain(input: { base: string; tail: string; count: number; events: readonly unknown[] }): ChainVerdict {
  if (!HASH_HEX.test(input.base)) return { ok: false, reason: "base", computed: "" };
  if (input.count !== input.events.length) return { ok: false, reason: "count", computed: String(input.events.length) };
  let current = input.base;
  for (const event of input.events) current = chainNext(current, event);
  if (current !== input.tail) return { ok: false, reason: "tail", computed: current };
  return { ok: true, tail: current };
}
