import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CREATION_AUDIT_TAG_SIZE,
  CreationAuditError,
  deriveCreationAuditKey,
  openCreationAudit,
  parseCreationAuditHeader,
  sealCreationAudit,
  type CreationAuditSnapshot,
} from "../../src/creation-audit/format";
import { canonicalJson, canonicalJsonString } from "../../src/creation-audit/canonical";
import { auditGenesis, chainNext, verifyChain } from "../../src/creation-audit/chain";

/**
 * Les vecteurs sont écrits par `edge-setup`
 * (`internal/connector/testdata/creation-audit-v2.*`, test
 * `TestCreationAuditVectorMatchesTestdata`) et recopiés ici tels quels : le
 * fichier scellé, la clé maîtresse en hexadécimal et le clair attendu.
 */
const fixture = (name: string) => new URL(`../fixtures/creation-audit/creation-audit-v2.${name}`, import.meta.url);
const sealed = new Uint8Array(readFileSync(fixture("bin")));
const master = new Uint8Array(Buffer.from(readFileSync(fixture("key.txt"), "utf8").trim(), "hex"));
const expected = JSON.parse(readFileSync(fixture("json"), "utf8")) as CreationAuditSnapshot;
const keyFor = (keyId: string) => (keyId === "key-vector" ? master : null);

describe("audit de création scellé : vecteurs partagés avec edge-setup", () => {
  test("l'en-tête clair se lit sans clé et nomme la clé et le runtime", () => {
    const { header, nonceAt } = parseCreationAuditHeader(sealed);
    expect(header).toEqual({ keyId: "key-vector", runtimeId: "runtime-vector", schemaVersion: 2, writeSeq: 3 });
    expect(nonceAt).toBe(12 + canonicalJson(header).byteLength);
  });

  test("le fichier s'ouvre avec la clé maîtresse et rend exactement le clair attendu", () => {
    const opened = openCreationAudit(sealed, keyFor);
    expect(opened.snapshot).toEqual(expected);
    expect(opened.snapshot.count).toBe(2);
    expect(opened.snapshot.writeSeq).toBe(3);
    expect(opened.snapshot.events[1]!.remoteId).toBe("remote-vector");
    expect(opened.chain.ok).toBe(true);
  });

  test("le JSON canonique reproduit octet pour octet celui de Go", () => {
    const { header, nonceAt } = parseCreationAuditHeader(sealed);
    expect(Buffer.from(canonicalJson(header))).toEqual(Buffer.from(sealed.subarray(12, nonceAt)));
    // Le clair attendu est lui-même canonique : le réencoder ne change rien.
    expect(canonicalJsonString(expected)).toBe(readFileSync(fixture("json"), "utf8").trim());
  });

  test("la chaîne recalculée depuis base tombe sur tail ; un réordonnancement la casse", () => {
    expect(verifyChain(expected)).toEqual({ ok: true, tail: expected.tail });
    const reordered = { ...expected, events: [...expected.events].reverse() };
    expect(verifyChain(reordered)).toMatchObject({ ok: false, reason: "tail" });
    const truncated = { ...expected, events: expected.events.slice(0, 1) };
    expect(verifyChain(truncated)).toMatchObject({ ok: false, reason: "count" });
    expect(verifyChain({ ...truncated, count: 1 })).toMatchObject({ ok: false, reason: "tail" });
  });

  test("genesis et h_i suivent la définition du contrat", () => {
    const genesis = auditGenesis("runtime-vector");
    expect(genesis).toBe(expected.base);
    const h1 = chainNext(genesis, expected.events[0]!);
    const h2 = chainNext(h1, expected.events[1]!);
    expect(h2).toBe(expected.tail);
  });

  test("un tag altéré est AUDIT_AUTH_FAILED, jamais un clair partiel", () => {
    const tampered = new Uint8Array(sealed);
    const last = tampered.byteLength - 1;
    tampered[last] = tampered[last]! ^ 0x01;
    expect(() => openCreationAudit(tampered, keyFor)).toThrow(expect.objectContaining({ code: "AUDIT_AUTH_FAILED" }));
  });

  test("un en-tête retouché échoue aussi : il est couvert par le tag", () => {
    const { nonceAt } = parseCreationAuditHeader(sealed);
    const forged = new Uint8Array(sealed);
    // writeSeq 3 → 4 dans l'en-tête clair, sans toucher au chiffré.
    const index = Buffer.from(forged.subarray(12, nonceAt)).indexOf('"writeSeq":3') + 12 + '"writeSeq":'.length;
    forged[index] = "4".charCodeAt(0);
    expect(parseCreationAuditHeader(forged).header.writeSeq).toBe(4);
    expect(() => openCreationAudit(forged, keyFor)).toThrow(expect.objectContaining({ code: "AUDIT_AUTH_FAILED" }));
  });

  test("une clé inconnue est AUDIT_KEY_UNKNOWN avant tout déchiffrement", () => {
    expect(() => openCreationAudit(sealed, () => null)).toThrow(expect.objectContaining({ code: "AUDIT_KEY_UNKNOWN" }));
  });

  test("un snapshot.json v1 en clair est AUDIT_PLAINTEXT_EXPORT, avec le message opérateur", () => {
    const v1 = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, runtimeId: "runtime-vector", events: [] }));
    let error: unknown;
    try { parseCreationAuditHeader(v1); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CreationAuditError);
    expect((error as CreationAuditError).code).toBe("AUDIT_PLAINTEXT_EXPORT");
    expect((error as CreationAuditError).message).toContain("mettez à jour edge-setup");
  });

  test("un magic, une version ou une suite inconnus sont AUDIT_FORMAT_INVALID", () => {
    expect(() => parseCreationAuditHeader(new TextEncoder().encode("OHBAUDT1garbage-garbage"))).toThrow(expect.objectContaining({ code: "AUDIT_FORMAT_INVALID" }));
    const suite2 = new Uint8Array(sealed);
    suite2[9] = 0x02;
    expect(() => parseCreationAuditHeader(suite2)).toThrow(expect.objectContaining({ code: "AUDIT_FORMAT_INVALID" }));
  });

  test("sceller puis ouvrir est l'identité, et un writeSeq d'en-tête différent du clair est AUDIT_SEQ_MISMATCH", () => {
    const header = { keyId: "key-vector", runtimeId: "runtime-vector", schemaVersion: 2, writeSeq: 3 };
    const resealed = sealCreationAudit(header, expected, master);
    expect(openCreationAudit(resealed, keyFor).snapshot).toEqual(expected);
    const mismatch = sealCreationAudit({ ...header, writeSeq: 4 }, expected, master);
    expect(() => openCreationAudit(mismatch, keyFor)).toThrow(expect.objectContaining({ code: "AUDIT_SEQ_MISMATCH" }));
    expect(resealed.byteLength).toBe(sealed.byteLength);
    expect(resealed.byteLength - CREATION_AUDIT_TAG_SIZE).toBeGreaterThan(0);
  });

  test("une chaîne rompue dans le clair est AUDIT_CHAIN_BROKEN", () => {
    const broken = sealCreationAudit(
      { keyId: "key-vector", runtimeId: "runtime-vector", schemaVersion: 2, writeSeq: 3 },
      { ...expected, tail: expected.base },
      master,
    );
    expect(() => openCreationAudit(broken, keyFor)).toThrow(expect.objectContaining({ code: "AUDIT_CHAIN_BROKEN" }));
  });

  test("la dérivation HKDF dépend du runtime : une autre salt donne une autre clé", () => {
    const a = deriveCreationAuditKey(master, "runtime-vector");
    const b = deriveCreationAuditKey(master, "runtime-other");
    expect(a.byteLength).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(() => deriveCreationAuditKey(master.subarray(0, 16), "runtime-vector")).toThrow(/32 bytes/);
  });
});
