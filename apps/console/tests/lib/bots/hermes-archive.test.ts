import { expect, test } from "bun:test";
import { gzipSync, strToU8, zipSync } from "fflate";
import { readHermesArchive } from "../../../src/lib/bots/hermes-archive";
const file = (bytes: Uint8Array, name = "scout.zip") => ({ name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }) as File;

test("reads stored/deflated ZIP and excludes hostile paths and secrets", async () => {
  for (const level of [0, 6] as const) {
    const result = await readHermesArchive(file(zipSync({ "config.yaml": strToU8("name: Scout"), "../escape": strToU8("x"), ".env": strToU8("SECRET") }, { level })));
    expect(result.entries.map((entry) => entry.path)).toEqual(["config.yaml"]);
    expect(result.dropped.map((entry) => entry.reason)).toEqual(["path-invalid", "secret"]);
  }
});
test("rejects truncated archives, false CRC, encryption and ZIP64", async () => {
  const zipped = zipSync({ "config.yaml": strToU8("name: Scout") }, { level: 0 });
  await expect(readHermesArchive(file(zipped.subarray(0, zipped.length - 2)))).rejects.toThrow();
  const corrupt = zipped.slice(); corrupt[41] = corrupt[41]! ^ 1;
  await expect(readHermesArchive(file(corrupt))).rejects.toThrow();
  for (const patch of [(v: DataView) => v.setUint16(6, 1, true), (v: DataView) => v.setUint16(zipped.length - 12, 65535, true)]) {
    const value = zipped.slice(); patch(new DataView(value.buffer)); await expect(readHermesArchive(file(value))).rejects.toThrow();
  }
});
test("central Unix symlinks are never treated as regular files", async () => {
  const zipped = zipSync({ "config.yaml": strToU8("target") });
  const view = new DataView(zipped.buffer);
  const central = view.getUint32(zipped.length - 6, true);
  view.setUint32(central + 38, 0xa1ff0000, true);
  const result = await readHermesArchive(file(zipped));
  expect(result.entries).toHaveLength(0); expect(result.dropped[0]?.reason).toBe("symlink");
});
test("decompression budgets stop highly compressible ZIP and gzip payloads", async () => {
  const bomb = new Uint8Array(65 * 1024 * 1024);
  await expect(readHermesArchive(file(zipSync({ "bomb": bomb })))).rejects.toThrow();
  await expect(readHermesArchive(file(gzipSync(bomb), "bomb.tgz"))).rejects.toThrow();
}, 15000);

test("reads ustar TGZ and rejects checksum errors, unsupported extensions and truncation", async () => {
  const payload = strToU8("name: Scout");
  const tar = new Uint8Array(2048);
  const put = (offset: number, text: string) => tar.set(strToU8(text), offset);
  put(0, "config.yaml"); put(124, payload.length.toString(8).padStart(11, "0") + "\0");
  put(148, "        "); put(156, "0"); put(257, "ustar\0"); put(263, "00");
  const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  put(148, sum.toString(8).padStart(6, "0") + "\0 "); tar.set(payload, 512);
  const read = await readHermesArchive(file(gzipSync(tar), "scout.tar.gz"));
  expect(new TextDecoder().decode(read.entries[0]?.bytes)).toBe("name: Scout");
  const bad = tar.slice(); bad[0] = 0;
  await expect(readHermesArchive(file(gzipSync(bad), "scout.tgz"))).rejects.toThrow();
  await expect(readHermesArchive(file(gzipSync(tar.subarray(0, 700)), "scout.tgz"))).rejects.toThrow();
  put(156, "x"); put(148, "        "); put(148, tar.subarray(0, 512).reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0") + "\0 ");
  await expect(readHermesArchive(file(gzipSync(tar), "scout.tgz"))).rejects.toThrow();
});
