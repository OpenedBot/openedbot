import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { persistEvents } from "../../src/application/runner/persist";
import type { WorkerConfig } from "../../src/application/worker-config";
import type { RunEvent } from "../../src/domain/hermes-events";

const organizationId = "00000000-0000-4000-8000-000000000001";
const html = "<!doctype html><html><body>semaine</body></html>";

describe("persistEvents : pièces du runtime", () => {
  test("copie un HTML write_file en attachments et en part du message", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohb-artifacts-"));
    const messages: unknown[] = [];
    const attachments: unknown[] = [];
    const payloads: unknown[] = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("insert into run_events")) {
        payloads.push(values[5]);
        return Promise.resolve([{
          cursor: "1",
          botId: "bot-1",
          turnId: "run-1",
          sessionKey: "ohb:org:thread",
          leaseGeneration: "1",
        }]);
      }
      if (sql.includes("insert into messages")) {
        messages.push(values[4]);
        return Promise.resolve([]);
      }
      if (sql.includes("insert into attachments")) {
        attachments.push({
          id: values[0],
          name: values[5],
          contentType: values[6],
          kind: values[7],
          bytes: values[8],
          objectKey: values[3],
        });
        return Promise.resolve([]);
      }
      if (sql.includes("select id from runs")) return Promise.resolve([{ id: "run-1" }]);
      return Promise.resolve([]);
    };
    const db = {
      begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as SQL;
    const config = {
      workerId: "worker-1",
      apiInternalUrl: "http://api.test",
      apiInternalToken: "tok",
      blob: { driver: "file" as const, root },
    } as WorkerConfig;
    const context = {
      id: "run-1",
      organizationId,
      threadId: "thread-1",
      botId: "bot-1",
      botName: "Neo",
      botSlug: "neo",
      sessionId: "ohb:org:thread",
      leaseGeneration: 1,
      workflowId: null,
      workflowRootRunId: null,
      groupId: null,
      groupTurnPosition: null,
      groupState: null,
      stepKind: "root",
      originRunId: null,
      provider: null,
      runtimeId: "rt-1",
    };
    const event: RunEvent = {
      sequence: 1,
      type: "run.completed",
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
      payload: {
        output: "voici la page",
        turnMessages: [{
          role: "assistant",
          tool_calls: [{
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "/root/actualite-ia-semaine.html", content: html }),
            },
          }],
        }],
      },
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    try {
      await persistEvents(db, config, context as never, 1, [event]);
    } finally {
      globalThis.fetch = original;
    }

    expect(payloads[0]).toEqual({ output: "voici la page" });
    expect(messages[0]).toEqual([
      { type: "text", text: "voici la page" },
      expect.objectContaining({
        type: "attachment",
        name: "actualite-ia-semaine.html",
        contentType: "text/html",
        kind: "document",
        bytes: new TextEncoder().encode(html).byteLength,
      }),
    ]);
    expect(attachments).toHaveLength(1);
    const stored = attachments[0] as {
      id: string;
      objectKey: string;
      name: string;
      contentType: string;
      kind: string;
    };
    expect(stored).toMatchObject({
      name: "actualite-ia-semaine.html",
      contentType: "text/html",
      kind: "document",
    });
    const onDisk = await readFile(join(root, stored.objectKey), "utf8");
    expect(onDisk).toBe(html);
  });
});
