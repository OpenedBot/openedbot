import { describe, expect, test } from "bun:test";
import { startFakePush } from "./server";

describe("fake-push", () => {
  test("journalise un POST et répond 201, puis 410 sur commande", async () => {
    const server = startFakePush({ port: 0 });
    try {
      const first = await fetch(`${server.url}/push/sub-1`, { method: "POST", body: "payload" });
      expect(first.status).toBe(201);
      expect(server.journal()).toHaveLength(1);
      expect(server.journal()[0]?.path).toBe("/push/sub-1");

      server.setStatus(410);
      const gone = await fetch(`${server.url}/push/sub-1`, { method: "POST", body: "payload" });
      expect(gone.status).toBe(410);
      expect(server.journal()).toHaveLength(2);

      const health = await fetch(`${server.url}/health`);
      expect((await health.json() as { ok: boolean }).ok).toBe(true);
    } finally {
      server.stop();
    }
  });
});
