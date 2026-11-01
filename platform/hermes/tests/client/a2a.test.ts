import { describe, expect, test } from "bun:test";
import { HermesClient } from "../../src/client";
import { parseA2aAgentCard } from "../../src/parsers";
import type { A2aAgentCard } from "../../src/contracts";

const card: A2aAgentCard = {
  name: "Hermes", description: "Bounded runtime metadata", url: "http://127.0.0.1:9900/", version: "0.20.5",
  supportedInterfaces: [{ url: "http://127.0.0.1:9900/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  capabilities: { streaming: false, pushNotifications: false },
  skills: [{ id: "answer", name: "Answer", description: "One bounded reply", tags: ["chat"] }],
};
describe("bounded A2A Agent Card", () => {
  test("projects only metadata, never unknown/provider/security fields", () => {
    const parsed = parseA2aAgentCard({ ...card, provider: { private: "marker" }, security: "marker", summary: "marker",
      skills: [{ ...card.skills[0], examples: ["marker"], token: "marker" }] });
    expect(parsed).toEqual(card);
    expect(JSON.stringify(parsed)).not.toContain("marker");
  });
  test.each([
    { ...card, name: "x".repeat(121) },
    { ...card, name: "bad\nname" },
    { ...card, skills: Array(65).fill(card.skills[0]) },
    { ...card, supportedInterfaces: [] },
    { ...card, supportedInterfaces: [{ ...card.supportedInterfaces[0], protocolVersion: ["1.0"] }] },
    { ...card, supportedInterfaces: [{ ...card.supportedInterfaces[0], protocolBinding: "GRPC" }] },
    { ...card, capabilities: { streaming: "yes", pushNotifications: false } },
    { ...card, url: "https://example.test/?private=marker" },
    { ...card, url: "https://identity:marker@example.test/" },
  ])("rejects malformed or over-bound metadata", (value) => {
    expect(() => parseA2aAgentCard(value)).toThrow();
  });
  test("the operator route stays fixed at the host root even for a named profile", async () => {
    const requests: Array<{ path: string; method?: string; kind: string }> = [];
    const client = new HermesClient({ profile: "specialist", transport: { kind: "relay", async send(path, init, kind) {
      requests.push({ path, method: init.method, kind }); return Response.json(card);
    } } });
    expect(await client.a2aAgentCard()).toEqual(card);
    expect(requests).toEqual([{ path: "/hermes-setup/a2a/agent-card", method: "GET", kind: "safe" }]);
  });
  test("refuses an oversized operator response before projecting it", async () => {
    const client = new HermesClient({ transport: { kind: "relay", async send() {
      return Response.json({ ...card, unknown: "x".repeat(33 * 1024) });
    } } });
    await expect(client.a2aAgentCard()).rejects.toMatchObject({ code: "HERMES_RESPONSE_INVALID" });
  });
});
