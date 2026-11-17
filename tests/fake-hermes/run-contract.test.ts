import { expect, test } from "bun:test";
import { HermesClient } from "../../platform/hermes/src/client";
import { isRunContractPayload, RUN_CONTRACT_ROUTES } from "../../protocol/connector/src/run-contract";
import { startFakeHermes, type FakeHermesOptions } from "./server";
import { FAKE_HERMES_TOKEN } from "./defaults";

for (const interruptRun of [false, true]) {
  test(`contract gateway: live replay, idempotency and ${interruptRun ? "interruption" : "completion"}`, async () => {
    const requests: NonNullable<FakeHermesOptions["requests"]> = [];
    const server = startFakeHermes({ port: 0, contractOnly: true, requests, interruptRun, delayMs: 50 });
    const endpoint = server.url.origin;
    const client = new HermesClient({ endpoint, token: FAKE_HERMES_TOKEN, mtls: null,
      policy: { environment: "test", testHttpUrl: endpoint } });
    try {
      expect((await fetch(`${endpoint}/health`)).status).toBe(401);
      const headers = { Authorization: `Bearer ${FAKE_HERMES_TOKEN}` };
      expect((await fetch(`${endpoint}/p/unknown/health`, { headers })).status).toBe(404);
      for (const route of RUN_CONTRACT_ROUTES.filter((r) => !r.mandatory)) {
        const response = await fetch(`${endpoint}${route.path.replace(/\{(?:id|slug|file)\}/g, "contract")}`, { method: route.method, headers });
        expect(response.status).toBe(404);
        await response.body?.cancel();
      }
      expect((await fetch(`${endpoint}/unlisted`, { headers })).status).toBe(404);
      const capabilities = await client.capabilities();
      expect(isRunContractPayload("capabilities", capabilities)).toBe(true);
      expect(await client.runSteerSupported()).toBe(false);
      await client.ensureSession("contract-session", "Contract bot");
      await client.ensureSession("contract-session", "Contract bot"); // 409 is success.
      const input = { input: "contract", instructions: "Contract bot", sessionId: "contract-session", idempotencyKey: "contract-key" };
      const id = await client.createRun(input);
      expect(await client.createRun(input)).toBe(id);
      const first = client.events(id, new AbortController().signal);
      const head = await first.next();
      expect(head.value?.event).toBe("message.interim");
      const second = client.events(id, new AbortController().signal);
      expect((await second.next()).value).toEqual(head.value);
      const a = [], b = [];
      for await (const event of first) a.push(event);
      for await (const event of second) b.push(event);
      expect(a).toEqual(b);
      for (const event of a) expect(isRunContractPayload("event", event)).toBe(true);
      expect(a.at(-1)?.event).toBe(interruptRun ? "run.interrupted" : "run.completed");
      expect((await client.getRunStatus(id)).status).toBe(interruptRun ? "interrupted" : "completed");
      expect(requests.filter((r) => r.path === "/v1/runs" && r.method === "POST")).toHaveLength(2);
    } finally { server.stop(true); }
  });
}
