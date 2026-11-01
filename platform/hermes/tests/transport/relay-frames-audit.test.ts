import { describe, expect, test } from "bun:test";
import { decodeTextFrame, encodeTextFrame, RelayFrameError } from "@openedbot/contracts-connector";

/**
 * Les trames ajoutées par OHB-53 (audit scellé) et OHB-54 (preuve de
 * possession) : mêmes règles que `DecodeText` côté Go. Les vecteurs partagés
 * `relay-frames.vectors.json` ne sont pas réécrits ici (ils sont la copie
 * octet pour octet du golden Go) ; ces cas vivent à côté.
 */
const key32 = Buffer.alloc(32, 7).toString("base64");
const sig64 = Buffer.alloc(64, 9).toString("base64");
const tail = "a".repeat(64);
const runtimeId = "8f3b2c1d-1111-4222-8333-444455556666";

describe("trames audit.* et link.challenge / link.proof", () => {
  test("hello accepte une devicePublicKey de 32 octets et refuse une autre taille", () => {
    const frame = decodeTextFrame(JSON.stringify({ t: "hello", protocol: 1, devicePublicKey: key32 }));
    expect(frame).toEqual({ t: "hello", protocol: 1, devicePublicKey: key32 });
    expect(() => decodeTextFrame(JSON.stringify({ t: "hello", protocol: 1, devicePublicKey: "c2hvcnQ=" }))).toThrow(RelayFrameError);
  });

  test("link.challenge exige un nonce de 32 octets ; link.proof une signature de 64 octets", () => {
    expect(decodeTextFrame(encodeTextFrame({ t: "link.challenge", nonce: key32 }))).toEqual({ t: "link.challenge", nonce: key32 });
    expect(decodeTextFrame(encodeTextFrame({ t: "link.proof", signature: sig64 }))).toEqual({ t: "link.proof", signature: sig64 });
    expect(() => decodeTextFrame(JSON.stringify({ t: "link.challenge", nonce: "abc" }))).toThrow(RelayFrameError);
    expect(() => decodeTextFrame(JSON.stringify({ t: "link.proof", signature: key32 }))).toThrow(RelayFrameError);
  });

  test("audit.key : runtimeId, keyId borné, clé de 32 octets, au plus deux previous", () => {
    const frame = decodeTextFrame(encodeTextFrame({ t: "audit.key", runtimeId, keyId: "k-1", key: key32, previous: [{ keyId: "k-0", key: key32 }] }));
    expect(frame).toEqual({ t: "audit.key", runtimeId, keyId: "k-1", key: key32, previous: [{ keyId: "k-0", key: key32 }] });
    expect(() => decodeTextFrame(JSON.stringify({ t: "audit.key", runtimeId, keyId: "bad key", key: key32 }))).toThrow(RelayFrameError);
    expect(() => decodeTextFrame(JSON.stringify({ t: "audit.key", runtimeId, keyId: "k", key: "c2hvcnQ=" }))).toThrow(RelayFrameError);
    const three = [{ keyId: "a", key: key32 }, { keyId: "b", key: key32 }, { keyId: "c", key: key32 }];
    expect(() => decodeTextFrame(JSON.stringify({ t: "audit.key", runtimeId, keyId: "k", key: key32, previous: three }))).toThrow(/more than 2/);
  });

  test("audit.anchor : compteurs absents valent zéro (omitempty côté Go), tail hexadécimal exigé", () => {
    expect(decodeTextFrame(JSON.stringify({ t: "audit.anchor", runtimeId, keyId: "k-1", tail })))
      .toEqual({ t: "audit.anchor", runtimeId, keyId: "k-1", writeSeq: 0, count: 0, dropped: 0, tail });
    expect(decodeTextFrame(JSON.stringify({ t: "audit.anchor", runtimeId, keyId: "k-1", writeSeq: 3, count: 2, tail })))
      .toMatchObject({ writeSeq: 3, count: 2, dropped: 0 });
    expect(() => decodeTextFrame(JSON.stringify({ t: "audit.anchor", runtimeId, keyId: "k-1", tail: "zz" }))).toThrow(RelayFrameError);
    expect(() => decodeTextFrame(JSON.stringify({ t: "audit.anchor", runtimeId, keyId: "k-1", writeSeq: -1, tail }))).toThrow(RelayFrameError);
  });
});
