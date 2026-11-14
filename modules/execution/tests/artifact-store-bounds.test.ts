import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getArtifactBlob } from '../src/application/artifact-store';

const root = mkdtempSync(join(tmpdir(), 'artifact-bounds-'));
const key = 'org/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
const blob = { driver: 'file' as const, root };
mkdirSync(join(root, 'org', '11111111-1111-4111-8111-111111111111'), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('bounded blob read cancels the stream as soon as actual content exceeds the bound', async () => {
  const data = new Uint8Array(5 * 1024 * 1024).fill(7);
  writeFileSync(join(root, key), data);
  const cancel = spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
  try {
    expect(await getArtifactBlob(blob, key, 1024 * 1024)).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally { cancel.mockRestore(); }
  // Existing callers with two arguments retain their previous complete read.
  expect((await getArtifactBlob(blob, key))?.byteLength).toBe(data.byteLength);
});

test('exact-bound and empty reads succeed; missing/unreadable blobs remain null', async () => {
  writeFileSync(join(root, key), new Uint8Array([1,2,3,4]));
  expect(await getArtifactBlob(blob, key, 4)).toEqual(new Uint8Array([1,2,3,4]));
  expect(await getArtifactBlob(blob, key, 0)).toBeNull();
  writeFileSync(join(root, key), new Uint8Array());
  expect(await getArtifactBlob(blob, key, 0)).toEqual(new Uint8Array());
  rmSync(join(root, key));
  expect(await getArtifactBlob(blob, key, 4)).toBeNull();
  mkdirSync(join(root, key));
  expect(await getArtifactBlob(blob, key, 4)).toBeNull();
  rmSync(join(root, key), { recursive: true });
});

test('invalid bounds fail before attempting storage', async () => {
  for (const bound of [-1,NaN,Infinity,1.5]) await expect(getArtifactBlob(blob, key, bound)).rejects.toThrow('Invalid blob read bound');
});
