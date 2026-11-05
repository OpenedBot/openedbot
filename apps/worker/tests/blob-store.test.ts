import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deleteBlob } from "../src/infrastructure/blob-store";

const temporaryRoots: string[] = [];
const objectKey = "org/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
/** La seconde forme de clé : une capture d'un fil de support, hors tenant. */
const supportKey = "support/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444";

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("worker blob store", () => {
  test("deletes a valid file object idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "openedbot-worker-blob-"));
    temporaryRoots.push(root);
    const filePath = join(root, objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, "payload");

    await deleteBlob({ blob: { driver: "file", root } }, objectKey);
    expect(await Bun.file(filePath).exists()).toBe(false);

    await deleteBlob({ blob: { driver: "file", root } }, objectKey);
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  test("deletes a support desk screenshot, which has no organization", async () => {
    // Le guichet n'a pas d'organisation : sa clé ne peut pas emprunter le
    // préfixe `org/`. Le garde a refusé cette forme dans sa première version,
    // et la file de suppression réessayait indéfiniment une ligne que rien ne
    // pouvait satisfaire : des octets payés pour toujours.
    const root = await mkdtemp(join(tmpdir(), "openedbot-worker-blob-"));
    temporaryRoots.push(root);
    const filePath = join(root, supportKey);
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, "capture");

    await deleteBlob({ blob: { driver: "file", root } }, supportKey);
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  test("deletes where the row says, even after the driver switched to R2", async () => {
    const root = await mkdtemp(join(tmpdir(), "openedbot-worker-blob-"));
    temporaryRoots.push(root);
    const filePath = join(root, objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, "payload");
    // R2 écrit désormais ; l'objet, lui, a été écrit sur le disque.
    const config = {
      blob: { driver: "r2" as const, bucket: "b", endpoint: "https://r2.invalid", accessKeyId: "k", secretAccessKey: "s" },
      blobOther: { driver: "file" as const, root },
    };
    await deleteBlob(config, objectKey, "file");
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  test("never confirms a deletion on a store this worker cannot reach", async () => {
    const root = await mkdtemp(join(tmpdir(), "openedbot-worker-blob-"));
    temporaryRoots.push(root);
    await expect(deleteBlob({ blob: { driver: "file", root }, blobOther: null }, objectKey, "r2"))
      .rejects.toThrow("Blob driver r2 is not configured on this worker.");
  });

  test("an unknown driver deletes on every reachable store", async () => {
    const root = await mkdtemp(join(tmpdir(), "openedbot-worker-blob-"));
    temporaryRoots.push(root);
    const filePath = join(root, objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, "payload");
    await deleteBlob({ blob: { driver: "file", root }, blobOther: null }, objectKey, null);
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  test("rejects a key outside the two known namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "openedbot-worker-blob-"));
    temporaryRoots.push(root);

    for (const key of [
      "../secret",
      "secret/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
      "support/../../etc/passwd",
    ]) {
      await expect(deleteBlob({ blob: { driver: "file", root } }, key)).rejects.toThrow(
        "Invalid deletion blob key",
      );
    }
  });
});
