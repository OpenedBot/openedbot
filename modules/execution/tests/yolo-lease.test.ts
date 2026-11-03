import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { YOLO_MAX_SECONDS, YOLO_THREAD_DEFAULT_SECONDS } from "@openedbot/contracts-api";
import { YOLO_LEASE_SIGNING_PREFIX, type YoloLeaseV1 } from "@openedbot/contracts-connector";
import {
  canonicalYoloLease,
  signYoloLease,
  validateYoloLease,
  validateYoloLeaseShape,
  verifyYoloLease,
  verifyYoloLeaseSignature,
  YOLO_CLOCK_SKEW_SECONDS,
  yoloLeaseKeyId,
  yoloLeaseMessage,
  yoloSigningKeyFromSeed,
  type YoloPinnedKey,
} from "../src/domain/yolo-lease";

// Twin of edge-setup `test/golden/yolo-lease/lease-v1.json`: the Go host will
// verify the same bytes. The seed in it is a PUBLIC TEST SEED, never a key.
type Vector = {
  signingPrefix: string;
  testSeedHex: string;
  publicKey: string;
  keyId: string;
  pinnedKeys: YoloPinnedKey[];
  runtimeId: string;
  now: number;
  lease: YoloLeaseV1;
  canonical: string;
  signature: string;
  invalid: Array<{ name: string; lease: unknown; keyId: string; signature: string; now: number; issue: string }>;
};
const vector = JSON.parse(readFileSync(new URL("./fixtures/yolo-lease/lease-v1.json", import.meta.url), "utf8")) as Vector;
const key = yoloSigningKeyFromSeed(Buffer.from(vector.testSeedHex, "hex"));
const context = { now: vector.now, runtimeId: vector.runtimeId, pinnedKeys: vector.pinnedKeys };

describe("YOLO lease: the shared v1 vector", () => {
  test("the test seed gives the vector's key and key id", () => {
    expect(key.publicKey).toBe(vector.publicKey);
    expect(key.keyId).toBe(vector.keyId);
    expect(yoloLeaseKeyId(vector.publicKey)).toBe(vector.keyId);
    expect(vector.keyId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("canonical form, signed message and signature are reproduced byte for byte", () => {
    expect(vector.signingPrefix).toBe(YOLO_LEASE_SIGNING_PREFIX);
    expect(Buffer.from(canonicalYoloLease(vector.lease)).toString("utf8")).toBe(vector.canonical);
    expect(Buffer.from(yoloLeaseMessage(vector.lease)).toString("utf8")).toBe(`${vector.signingPrefix}${vector.canonical}`);
    expect(signYoloLease(vector.lease, key)).toEqual({ keyId: vector.keyId, signature: vector.signature });
  });

  test("the vector's lease verifies", () => {
    expect(verifyYoloLease({ lease: vector.lease, keyId: vector.keyId, signature: vector.signature }, context))
      .toEqual({ ok: true, lease: vector.lease });
  });

  for (const entry of vector.invalid) {
    test(`refused: ${entry.name} (${entry.issue})`, () => {
      expect(verifyYoloLease(entry, { ...context, now: entry.now })).toEqual({ ok: false, issue: entry.issue as never });
    });
  }

  test("a property outside v1 on the object in memory is not signed", () => {
    const extended = { ...vector.lease, note: "not signed" } as YoloLeaseV1;
    expect(signYoloLease(extended, key).signature).toBe(vector.signature);
  });
});

describe("YOLO lease: validation", () => {
  const lease = vector.lease;
  const at = (now: number, extra: Partial<Parameters<typeof validateYoloLease>[1]> = {}) =>
    validateYoloLease(lease, { now, runtimeId: vector.runtimeId, ...extra });

  test("the limits are 4 hours by default for a thread, 24 hours at most", () => {
    expect(YOLO_THREAD_DEFAULT_SECONDS).toBe(4 * 3600);
    expect(YOLO_MAX_SECONDS).toBe(24 * 3600);
    expect(validateYoloLeaseShape({ ...lease, expiresAt: lease.issuedAt + YOLO_MAX_SECONDS })).toEqual({ ok: true });
    expect(validateYoloLeaseShape({ ...lease, expiresAt: lease.issuedAt + YOLO_MAX_SECONDS + 1 })).toEqual({ ok: false, issue: "duration_exceeded" });
  });

  test.each([
    ["thread with a profile and a session", { scope: "thread" }, true],
    ["thread without a profile", { scope: "thread", profile: null }, false],
    ["bot with a profile, no session", { scope: "bot", sessionKey: null }, true],
    ["bot with a session", { scope: "bot" }, false],
    ["runtime with neither", { scope: "runtime", profile: null, sessionKey: null }, true],
    ["runtime naming a profile", { scope: "runtime", sessionKey: null }, false],
  ] as const)("scope: %s", (_name, change, ok) => {
    expect(validateYoloLeaseShape({ ...lease, ...change } as YoloLeaseV1)).toEqual(ok ? { ok: true } : { ok: false, issue: "scope_mismatch" });
  });

  test("the window is ordered: issuedAt <= notBefore < expiresAt", () => {
    expect(validateYoloLeaseShape({ ...lease, notBefore: lease.issuedAt - 1 })).toEqual({ ok: false, issue: "window_invalid" });
    expect(validateYoloLeaseShape({ ...lease, expiresAt: lease.notBefore })).toEqual({ ok: false, issue: "window_invalid" });
  });

  test("protections must be known and complete; deny commands well formed", () => {
    expect(validateYoloLeaseShape({ ...lease, protect: [...lease.protect, "browser_cookies"] })).toEqual({ ok: false, issue: "protect_unknown" });
    expect(validateYoloLeaseShape({ ...lease, protect: ["ssh"] })).toEqual({ ok: false, issue: "protect_incomplete" });
    expect(validateYoloLeaseShape({ ...lease, deny: { ...lease.deny, commands: ["sudo rm"] } })).toEqual({ ok: false, issue: "deny_invalid" });
  });

  test("the clock: skew tolerated before notBefore, never after expiresAt", () => {
    expect(at(lease.notBefore - YOLO_CLOCK_SKEW_SECONDS)).toEqual({ ok: true });
    expect(at(lease.notBefore - YOLO_CLOCK_SKEW_SECONDS - 1)).toEqual({ ok: false, issue: "not_yet_valid" });
    expect(at(lease.expiresAt - 1)).toEqual({ ok: true });
    expect(at(lease.expiresAt)).toEqual({ ok: false, issue: "expired" });
  });

  test("another runtime, a tombstone or a local kill refuse the lease", () => {
    expect(validateYoloLease(lease, { now: vector.now, runtimeId: "other" })).toEqual({ ok: false, issue: "runtime_mismatch" });
    expect(at(vector.now, { revokedLeaseIds: new Set([lease.leaseId]) })).toEqual({ ok: false, issue: "revoked" });
    expect(at(vector.now, { killedAt: lease.issuedAt })).toEqual({ ok: false, issue: "killed" });
    expect(at(vector.now, { killedAt: lease.issuedAt - 1 })).toEqual({ ok: true });
    expect(at(vector.now, { killedAt: null })).toEqual({ ok: true });
  });

  test("a pin whose id does not match its key pins nothing", () => {
    const other = yoloSigningKeyFromSeed(new Uint8Array(32).fill(0x55));
    const forged = [{ keyId: vector.keyId, publicKey: other.publicKey }];
    expect(verifyYoloLeaseSignature(lease, vector.keyId, signYoloLease(lease, other).signature, forged)).toEqual({ ok: false, issue: "key_unknown" });
    expect(verifyYoloLeaseSignature(lease, vector.keyId, "AAAA", vector.pinnedKeys)).toEqual({ ok: false, issue: "signature_invalid" });
  });

  test("a seed is 32 bytes", () => {
    expect(() => yoloSigningKeyFromSeed(new Uint8Array(31))).toThrow();
  });
});
