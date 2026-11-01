import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditGenesis, sealCreationAudit, type CreationAuditSnapshot } from "@openedbot/hermes";
import { copySealedExport, EXPORT_MAX_BYTES, inspectSealedExport } from "../../../tests/e2e/runtime-link-export-audit-lib";

/** The operator export never decrypts: it reads the clear header, hashes and
 * copies the bytes; a plaintext v1 snapshot is refused by name. */
const RUNTIME_ID = "8f3b2c1d-1111-4222-8333-444455556666";
function sealed(): Uint8Array {
  const snapshot: CreationAuditSnapshot = { schemaVersion: 2, startedAt: "2026-09-06T12:00:01Z", lastWrittenAt: "2026-09-06T12:00:06Z", runtimeId: RUNTIME_ID,
    writeSeq: 3, count: 0, dropped: 0, base: auditGenesis(RUNTIME_ID), tail: auditGenesis(RUNTIME_ID), events: [] };
  return sealCreationAudit({ keyId: "k-1", runtimeId: RUNTIME_ID, schemaVersion: 2, writeSeq: 3 }, snapshot, new Uint8Array(Buffer.alloc(32, 5)));
}

test("inspection reads the clear header and digest without any key", () => {
  const data = sealed();
  const inspection = inspectSealedExport(data);
  expect(inspection.header).toEqual({ keyId: "k-1", runtimeId: RUNTIME_ID, schemaVersion: 2, writeSeq: 3 });
  expect(inspection.sha256).toBe(new Bun.CryptoHasher("sha256").update(data).digest("hex"));
  expect(inspection.bytes).toBe(data.byteLength);
});

test("a plaintext v1 snapshot.json is refused by name, an oversized or foreign file too", () => {
  expect(() => inspectSealedExport(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, runtimeId: RUNTIME_ID, events: [] })))).toThrow("older than audit v2");
  expect(() => inspectSealedExport(new Uint8Array(EXPORT_MAX_BYTES + 1))).toThrow("bound");
  expect(() => inspectSealedExport(new TextEncoder().encode("not an audit at all"))).toThrow("AUDIT_FORMAT_INVALID");
});

test("the copy is byte-for-byte, private, and never replaces an existing destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ohb-export-audit-"));
  const source = join(dir, "snapshot.bin"), destination = join(dir, "export.bin");
  const data = sealed();
  await writeFile(source, data);
  const inspection = await copySealedExport(source, destination);
  expect(inspection.header.runtimeId).toBe(RUNTIME_ID);
  expect(Buffer.from(await readFile(destination)).equals(data)).toBe(true);
  expect((await stat(destination)).mode & 0o777).toBe(0o600);
  await expect(copySealedExport(source, destination)).rejects.toThrow("EEXIST");
});
