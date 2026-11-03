import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeRuntimeArtifacts } from "../src/application/runner/transcript";
import { extractOutputMedia } from "../src/domain/output-media";
import type { WorkerConfig } from "../src/application/worker-config";
import type { RunEvent } from "../src/domain/hermes-events";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("an image the reply delivered is stored as an attachment, with no write in the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohb-output-media-"));
  roots.push(root);
  const config = { blob: { driver: "file", root } } as unknown as WorkerConfig;
  const context = {
    id: "8c7a8e18-668f-4fe1-a679-4be117b85dd3",
    organizationId: "00000000-0000-4000-8000-000000000201",
    sessionId: "session-1",
    workflowId: null,
  };
  const output = `Voici le résumé :\n\n![image](data:image/png;base64,${PNG})`;
  const event = { type: "run.completed", payload: { output, turnMessages: [] } } as unknown as RunEvent;
  const media = extractOutputMedia(output);
  const stored = await storeRuntimeArtifacts(config, context, event, undefined, media.images);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ name: "image.png", contentType: "image/png", kind: "image", driver: "file" });
  const bytes = await readFile(join(root, stored[0]!.objectKey));
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
});
