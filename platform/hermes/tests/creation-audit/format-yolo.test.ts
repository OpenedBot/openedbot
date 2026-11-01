import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CREATION_AUDIT_KIND_YOLO,
  openCreationAudit,
  sealCreationAudit,
  type CreationAuditSnapshot,
} from "../../src/creation-audit/format";
import { canonicalJsonString } from "../../src/creation-audit/canonical";
import { verifyChain } from "../../src/creation-audit/chain";

/**
 * Le vecteur des auto-approbations YOLO, écrit par edge-setup
 * (`internal/connector/testdata/creation-audit-v2-yolo.*`, test
 * `TestCreationAuditYoloVectorMatchesTestdata`) et recopié ici tel quel :
 * une création de run puis deux auto-approbations (un outil du plugin, une
 * commande du terminal). Mêmes schemaVersion 2 et chaîne que l'audit de
 * création ; les champs YOLO sont additifs.
 */
const fixture = (name: string) => new URL(`../fixtures/creation-audit/creation-audit-v2-yolo.${name}`, import.meta.url);
const sealed = new Uint8Array(readFileSync(fixture("bin")));
const master = new Uint8Array(Buffer.from(readFileSync(fixture("key.txt"), "utf8").trim(), "hex"));
const expected = JSON.parse(readFileSync(fixture("json"), "utf8")) as CreationAuditSnapshot;
const keyFor = (keyId: string) => (keyId === "key-vector" ? master : null);

describe("audit de création scellé : auto-approbations YOLO", () => {
  test("le fichier s'ouvre, la chaîne tient avec les champs YOLO", () => {
    const opened = openCreationAudit(sealed, keyFor);
    expect(opened.snapshot).toEqual(expected);
    expect(opened.chain.ok).toBe(true);
    expect(canonicalJsonString(expected)).toBe(readFileSync(fixture("json"), "utf8").trim());
  });

  test("chaque auto-approbation nomme son bail, sa porte et le hash des arguments, jamais les arguments", () => {
    const [run, plugin, terminal] = openCreationAudit(sealed, keyFor).snapshot.events;
    expect(run!.kind).toBeUndefined();
    expect(plugin).toMatchObject({ kind: CREATION_AUDIT_KIND_YOLO, phase: "decision", gateKind: "plugin_tool", toolKey: "write_file" });
    expect(terminal).toMatchObject({ kind: CREATION_AUDIT_KIND_YOLO, gateKind: "terminal_danger" });
    expect(terminal!.toolKey).toBeUndefined();
    for (const event of [plugin!, terminal!]) {
      expect(event.leaseId).toBe("5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d01");
      expect(event.argsHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(readFileSync(fixture("json"), "utf8")).not.toContain("notes/todo.md");
  });

  test("un champ YOLO perdu par un décodeur casserait la chaîne : il est conservé", () => {
    const stripped = { ...expected, events: expected.events.map(({ argsHash: _argsHash, ...event }) => event) };
    expect(verifyChain(stripped)).toMatchObject({ ok: false, reason: "tail" });
  });

  test("une auto-approbation sans hash d'arguments est refusée", () => {
    const events = expected.events.map((event) => (event.kind ? { ...event, argsHash: "rm -rf build" } : event));
    const forged = sealCreationAudit({ keyId: "key-vector", runtimeId: "runtime-vector", schemaVersion: 2, writeSeq: expected.writeSeq }, { ...expected, events }, master);
    expect(() => openCreationAudit(forged, keyFor)).toThrow(expect.objectContaining({ code: "AUDIT_FORMAT_INVALID" }));
  });
});
