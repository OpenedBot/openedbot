import { afterEach, expect, test } from "bun:test";
import { threadsApi } from "../../../src/lib/api/threads";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("a message carries the browser's IANA zone, for a routine the bot schedules from it (0187)", async () => {
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ runId: "r", messageId: "m" }, { status: 202 });
  }) as typeof fetch;
  await threadsApi.sendMessage("thread-1", "rappelle-moi demain à 9 h", [], "key-1");
  expect(body as unknown).toEqual({ input: "rappelle-moi demain à 9 h", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
});
