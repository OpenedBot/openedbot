/**
 * Checks a Tauri update signature (`.sig`) against the update public key,
 * without the minisign tool: the release assembler (`release.ts`) refuses an
 * artifact signed by another key, and the tag workflow
 * (`.github/workflows/desktop-release.yml`) checks the files it mirrors with
 * the same code.
 *
 * Tauri writes both files as base64 of the minisign text format:
 *
 *   public key:  untrusted comment: …
 *                base64("Ed" + key id (8 bytes) + Ed25519 public key (32 bytes))
 *   signature:   untrusted comment: …
 *                base64(algorithm (2 bytes) + key id (8) + signature (64))
 *                trusted comment: …
 *                base64(signature (64) of the signature above + the trusted comment)
 *
 * The algorithm is "ED" (the file's BLAKE2b-512 is signed) or the legacy
 * "Ed" (the file itself). Both signatures must hold.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** The DER prefix that turns a raw Ed25519 public key into an SPKI one. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type UpdatePublicKey = { keyId: string; key: KeyObject };

/** The text inside a Tauri key or signature file (base64 of the minisign text). */
function minisignText(base64: string, what: string): string[] {
  const text = Buffer.from(base64.trim(), "base64").toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error(`${what} is not a minisign file`);
  return lines;
}

function decodeExact(base64: string, length: number, what: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== length) throw new Error(`${what}: ${bytes.length} bytes, want ${length}`);
  return bytes;
}

/** Reads the public key (`updater.pub`, the content of `tauri signer generate`'s `.pub`). */
export function parsePublicKey(base64: string): UpdatePublicKey {
  const lines = minisignText(base64, "the update public key");
  const raw = decodeExact(lines[1] ?? "", 42, "the update public key");
  if (raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("the update public key is not an Ed25519 minisign key");
  return {
    keyId: raw.subarray(2, 10).toString("hex"),
    key: createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]), format: "der", type: "spki" }),
  };
}

/**
 * Throws unless `signature` (the content of a `.sig`) signs `content` with
 * `publicKey`. Returns the trusted comment (Tauri puts the timestamp and the
 * file name there).
 */
export function verifySignature(content: Uint8Array, signature: string, publicKey: UpdatePublicKey): string {
  const lines = minisignText(signature, "the signature");
  const raw = decodeExact(lines[1] ?? "", 74, "the signature");
  const algorithm = raw.subarray(0, 2).toString("latin1");
  const keyId = raw.subarray(2, 10).toString("hex");
  const signed = raw.subarray(10);
  if (keyId !== publicKey.keyId) throw new Error(`signed by key ${keyId.toUpperCase()}, not by the update key ${publicKey.keyId.toUpperCase()}`);
  const message = algorithm === "ED" ? createHash("blake2b512").update(content).digest() : algorithm === "Ed" ? Buffer.from(content) : null;
  if (!message) throw new Error(`unknown signature algorithm ${JSON.stringify(algorithm)}`);
  if (!verify(null, message, publicKey.key, signed)) throw new Error("the signature does not match the file");
  const trusted = lines[2] ?? "";
  if (!trusted.startsWith("trusted comment: ")) throw new Error("the signature has no trusted comment");
  const comment = trusted.slice("trusted comment: ".length);
  const global = decodeExact(lines[3] ?? "", 64, "the trusted comment's signature");
  if (!verify(null, Buffer.concat([signed, Buffer.from(comment, "utf8")]), publicKey.key, global)) throw new Error("the trusted comment's signature does not match");
  return comment;
}

/** `verifySignature` on files: `<file>` and `<file>.sig`. */
export function verifySignedFile(file: string, publicKey: UpdatePublicKey): string {
  return verifySignature(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), publicKey);
}
