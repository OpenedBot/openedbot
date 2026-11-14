/**
 * For the tests only: a throwaway update key and signatures in the format
 * `tauri signer` writes (base64 of the minisign text), so `minisign.ts` and
 * `release.ts` are checked without the real key or the Tauri CLI.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export type TestKey = { publicKeyFile: string; sign(content: Uint8Array, options?: { version?: string; algorithm?: "ED" | "Ed"; comment?: string }): string };

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");

export function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = Buffer.from(createHash("sha256").update(raw).digest().subarray(0, 8));
  const publicText = `untrusted comment: minisign public key: ${Buffer.from(keyId).reverse().toString("hex").toUpperCase()}\n${b64(Buffer.concat([Buffer.from("Ed"), keyId, raw]))}\n`;
  return {
    publicKeyFile: b64(publicText),
    sign: (content, options = {}) => signWith(privateKey, keyId, content, options),
  };
}

function signWith(privateKey: KeyObject, keyId: Buffer, content: Uint8Array, options: { version?: string; algorithm?: "ED" | "Ed"; comment?: string }): string {
  const algorithm = options.algorithm ?? "ED";
  const message = algorithm === "ED" ? createHash("blake2b512").update(content).digest() : Buffer.from(content);
  const signature = sign(null, message, privateKey);
  const comment = options.comment ?? `timestamp:1762430400\tfile:artifact${options.version ? `\tversion:${options.version}` : ""}`;
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const text = `untrusted comment: signature from tauri secret key\n${b64(Buffer.concat([Buffer.from(algorithm), keyId, signature]))}\ntrusted comment: ${comment}\n${b64(global)}\n`;
  return b64(text);
}
