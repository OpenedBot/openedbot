import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePublicKey, verifySignature } from "./minisign";
import { testKey } from "./test-signing";

const content = new TextEncoder().encode("an update artifact");

describe("update signatures (minisign, as tauri signer writes them)", () => {
  test("a prehashed signature (ED) and a legacy one (Ed) both verify, and give the trusted comment", () => {
    const key = testKey();
    const publicKey = parsePublicKey(key.publicKeyFile);
    expect(verifySignature(content, key.sign(content, { version: "1.1.0" }), publicKey)).toContain("version:1.1.0");
    expect(verifySignature(content, key.sign(content, { algorithm: "Ed" }), publicKey)).toContain("timestamp:");
  });

  test("another file, another key, or a forged trusted comment is refused", () => {
    const key = testKey();
    const publicKey = parsePublicKey(key.publicKeyFile);
    const signature = key.sign(content);
    expect(() => verifySignature(new TextEncoder().encode("another file"), signature, publicKey)).toThrow(/does not match the file/);
    expect(() => verifySignature(content, testKey().sign(content), publicKey)).toThrow(/not by the update key/);
    // Same signature line, another trusted comment: the global signature no longer holds.
    const lines = Buffer.from(signature, "base64").toString("utf8").split("\n");
    lines[2] = "trusted comment: timestamp:1\tfile:artifact\tversion:9.9.9";
    expect(() => verifySignature(content, Buffer.from(lines.join("\n")).toString("base64"), publicKey)).toThrow(/trusted comment's signature/);
  });

  test("garbage is a named error, not a pass", () => {
    const publicKey = parsePublicKey(testKey().publicKeyFile);
    expect(() => verifySignature(content, "bm90IGEgc2lnbmF0dXJl", publicKey)).toThrow(/not a minisign file/);
    expect(() => parsePublicKey("bm90IGEga2V5")).toThrow(/not a minisign file/);
  });

  test("the committed update key is a minisign Ed25519 public key", () => {
    const key = parsePublicKey(readFileSync(path.resolve(import.meta.dir, "../updater.pub"), "utf8"));
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
  });
});
