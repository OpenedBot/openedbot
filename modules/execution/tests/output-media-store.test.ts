import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeRuntimeArtifacts } from "../src/application/runner/transcript";
import { extractOutputMedia } from "../src/domain/output-media";
import { citedWorkspacePaths } from "../src/domain/output-workspace-files";
import type { HermesClient } from "@openedbot/hermes";
import type { WorkerConfig } from "../src/application/worker-config";
import type { RunEvent } from "../src/domain/hermes-events";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("an image the reply delivered is stored as an attachment, with no write in the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "openedbot-output-media-"));
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

test("a file the reply cites as a plain path becomes an attachment; a missing one is skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "openedbot-output-media-"));
  roots.push(root);
  const config = { blob: { driver: "file", root } } as unknown as WorkerConfig;
  const context = {
    id: "8c7a8e18-668f-4fe1-a679-4be117b85dd3",
    organizationId: "00000000-0000-4000-8000-000000000201",
    sessionId: "session-1",
    workflowId: null,
  };
  const output = "Le fichier `/workspace/notes.md` contient la liste. Le graphique /workspace/chart.png aussi, mais /workspace/absent.md et /workspace/gone.png non.";
  const turnMessages = [{
    role: "assistant",
    tool_calls: [{ function: { name: "write_file", arguments: JSON.stringify({ path: "/workspace/notes.md", content: "# Notes\n\n- un\n" }) } }],
  }];
  const event = { type: "run.completed", payload: { output, turnMessages } } as unknown as RunEvent;
  const asked: string[] = [];
  const client = {
    hostWorkspaceFile: async (name: string) => {
      asked.push(name);
      if (name === "chart.png") return { contentType: "image/png" as const, bytes: new Uint8Array(Buffer.from(PNG, "base64")) };
      throw Object.assign(new Error("absent"), { status: 404, code: "WORKSPACE_FILE_NOT_FOUND" });
    },
  } as unknown as HermesClient;
  const cited = citedWorkspacePaths(output);
  expect(cited).toEqual(["notes.md", "chart.png", "absent.md", "gone.png"]);
  const stored = await storeRuntimeArtifacts(config, context, event, client, [], cited);
  expect(stored.map(({ name, contentType, kind }) => ({ name, contentType, kind }))).toEqual([
    { name: "notes.md", contentType: "text/markdown", kind: "document" },
    { name: "chart.png", contentType: "image/png", kind: "image" },
  ]);
  // Only a root image or PDF name is asked of the host; a text file comes from the turn.
  expect(asked.sort()).toEqual(["chart.png", "gone.png"]);
  expect(await readFile(join(root, stored[0]!.objectKey), "utf8")).toBe("# Notes\n\n- un\n");
});

test("a cited file already delivered by MEDIA: is attached once", async () => {
  const root = await mkdtemp(join(tmpdir(), "openedbot-output-media-"));
  roots.push(root);
  const config = { blob: { driver: "file", root } } as unknown as WorkerConfig;
  const context = { id: "run-2", organizationId: "00000000-0000-4000-8000-000000000201", sessionId: "s", workflowId: null };
  const png = new Uint8Array(Buffer.from(PNG, "base64"));
  const output = "MEDIA:/workspace/chart.png\nVoir `/workspace/chart.png`.";
  const media = extractOutputMedia(output, new Map([["chart.png", { contentType: "image/png" as const, bytes: png }]]));
  const event = { type: "run.completed", payload: { output, turnMessages: [] } } as unknown as RunEvent;
  const stored = await storeRuntimeArtifacts(config, context, event, undefined, media.images, citedWorkspacePaths(output));
  expect(stored.map((artifact) => artifact.name)).toEqual(["chart.png"]);
});
