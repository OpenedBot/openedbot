/** Pure logic of the operator export: read the clear header of a sealed
 * `snapshot.bin`, hash it, copy it byte for byte. Nothing here holds a key or
 * decrypts anything; the verdict comes from openedbot. */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  CREATION_AUDIT_MAX_EXPORT_BYTES,
  CreationAuditError,
  parseCreationAuditHeader,
  type CreationAuditHeader,
} from "../../platform/hermes/src/creation-audit/index";

export const EXPORT_MAX_BYTES = CREATION_AUDIT_MAX_EXPORT_BYTES;
export type SealedExportInspection = { header: CreationAuditHeader; sha256: string; bytes: number };

/** The clear header and digest of a sealed export. A plaintext `snapshot.json`
 * from a connector older than audit v2 is refused by name: it is never evidence. */
export function inspectSealedExport(data: Uint8Array): SealedExportInspection {
  if (data.byteLength > EXPORT_MAX_BYTES) throw new Error(`Audit export exceeds the ${EXPORT_MAX_BYTES}-byte bound`);
  try {
    const { header } = parseCreationAuditHeader(data);
    return { header, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
  } catch (error) {
    if (error instanceof CreationAuditError && error.code === "AUDIT_PLAINTEXT_EXPORT") {
      throw new Error("Plaintext snapshot.json from a connector older than audit v2: upgrade edge-setup and export snapshot.bin; OHB never accepts this file.");
    }
    if (error instanceof CreationAuditError) throw new Error(`Not a sealed creation audit (${error.code}): ${error.message}`);
    throw error;
  }
}

/** Copies the sealed export unchanged into a NEW private file. */
export async function copySealedExport(source: string, destination: string): Promise<SealedExportInspection> {
  if ((await stat(source)).size > EXPORT_MAX_BYTES) throw new Error(`Audit export exceeds the ${EXPORT_MAX_BYTES}-byte bound`);
  const data = new Uint8Array(await readFile(source));
  const inspection = inspectSealedExport(data);
  await writeFile(destination, data, { mode: 0o600, flag: "wx" });
  return inspection;
}
