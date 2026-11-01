import { describe, expect, test } from "bun:test";
import { matchRelayRoute } from "@openedbot/contracts-connector";
import { HermesClient } from "../src/client";
import {
  parseA2AAuditHostSnapshot,
  type A2AAuditHostSnapshot,
} from "../src/a2a-audit";

const snapshot = (limit = 2): A2AAuditHostSnapshot => ({
  status: "available",
  source: "a2a_audit",
  limit,
  truncated: false,
  records: [
    { id: "a2a_audit:0", source: "upstream", ts: 1_790_000_000.125, direction: "inbound", peer: "client-a", taskId: "task-0123456789abcdef" },
    { id: "a2a_audit:200", source: "operator.policy_probe", ts: 1_790_000_001.75, direction: "denied", peer: "client-b", taskId: "task-fedcba9876543210" },
  ],
});

describe("bounded A2A host audit", () => {
  test("projects only safe metadata and drops unknown prompt, reply, and preview fields", () => {
    const value = snapshot();
    const raw = {
      ...value,
      private: "private-marker",
      records: value.records.map((item) => ({
        ...item,
        prompt: "prompt-marker",
        reply: "reply-marker",
        toolPreview: { text: "preview-marker" },
        summary: "summary-marker",
      })),
    };

    const parsed = parseA2AAuditHostSnapshot(raw, 2);
    expect(parsed).toEqual(value);
    expect(JSON.stringify(parsed)).not.toMatch(/private-marker|prompt-marker|reply-marker|preview-marker|summary-marker/);
  });

  test("accepts the missing-file status with an empty projection", () => {
    expect(parseA2AAuditHostSnapshot({
      status: "missing", source: "a2a_audit", limit: 50, truncated: false, records: [],
    })).toEqual({ status: "missing", source: "a2a_audit", limit: 50, truncated: false, records: [] });
  });

  test("projects guard-file denials with optional generated task IDs and no unknown fields", () => {
    const guard = {
      id: "policy_denials:17",
      source: "operator.policy_guard",
      ts: 1_790_000_002,
      direction: "denied",
      peer: "alpha",
      privateField: "DROP_PRIVATE_FIELD",
      prompt: "DROP_PROMPT",
      taskId: "task-0123456789abcdef",
    };
    const parsed = parseA2AAuditHostSnapshot({
      status: "available",
      source: "a2a_audit",
      limit: 2,
      truncated: false,
      records: [
        { ...guard, taskId: undefined },
        guard,
      ],
    });
    expect(parsed.records).toEqual([
      { id: "policy_denials:17", source: "operator.policy_guard", ts: 1_790_000_002, direction: "denied", peer: "alpha" },
      { id: "policy_denials:17", source: "operator.policy_guard", ts: 1_790_000_002, direction: "denied", peer: "alpha", taskId: "task-0123456789abcdef" },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/DROP_PRIVATE_FIELD|DROP_PROMPT/);
  });

  test.each([
    { ...snapshot(), source: "other" },
    { ...snapshot(), status: "unknown" },
    { ...snapshot(), status: ["available"] },
    { ...snapshot(), truncated: true },
    { ...snapshot(), limit: 0 },
    { ...snapshot(), limit: 101 },
    { ...snapshot(), limit: 1.5 },
    { ...snapshot(), limit: 3, truncated: "false" },
    { ...snapshot(), status: "truncated", truncated: false },
    { ...snapshot(), status: "missing" },
    { ...snapshot(), skippedRecords: -1 },
    { ...snapshot(), skippedRecords: 1_000_001 },
    { ...snapshot(1) },
    { ...snapshot(), records: [null] },
    { ...snapshot(), records: [{ ...snapshot().records[0], source: "unrecognized" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], direction: "read" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], id: "" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], id: "a2a_audit:9223372036854775808" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], ts: 0 }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], ts: 253_402_300_800 }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], source: "operator.policy_probe", direction: "inbound" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], source: "operator.policy_guard", direction: "denied" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], id: "policy_denials:1", source: "upstream" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], id: "policy_denials:1", source: "operator.policy_guard", direction: "outbound" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], id: "policy_denials:1", source: "operator.policy_guard", direction: "denied", taskId: "caller text" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], taskId: undefined }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], id: "x".repeat(129) }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], ts: "1790000000000" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], ts: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], peer: { name: "client-a" } }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], peer: "bad\npeer" }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], taskId: 42 }] },
    { ...snapshot(), records: [{ ...snapshot().records[0], taskId: "x".repeat(257) }] },
  ])("rejects invalid envelope or record metadata", (value) => {
    expect(() => parseA2AAuditHostSnapshot(value)).toThrow();
  });

  test("requires the requested limit to match the host readback", () => {
    expect(() => parseA2AAuditHostSnapshot(snapshot(50), 25)).toThrow();
  });

  test("allowlists only the named read-only host audit path", () => {
    expect(matchRelayRoute("GET", "/hermes-setup/a2a/audit?limit=37")?.host).toBe(true);
    expect(matchRelayRoute("GET", "/hermes-setup/a2a/audit?limit=50")).not.toBeNull();
    expect(matchRelayRoute("GET", "/p/specialist/hermes-setup/a2a/audit?limit=50")).toBeNull();
    expect(matchRelayRoute("GET", "/hermes-setup/a2a/audit?limit=01")).toBeNull();
    expect(matchRelayRoute("POST", "/hermes-setup/a2a/audit")).toBeNull();
    expect(matchRelayRoute("GET", "/hermes-setup/a2a/audit/extra")).toBeNull();
  });

  test("uses one fixed host-root route and only the caller's bounded limit", async () => {
    const requests: Array<{ path: string; method?: string; kind: string }> = [];
    const client = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send(path, init, kind) {
        requests.push({ path, method: init.method, kind });
        return Response.json(snapshot(37));
      },
    } });

    expect(await client.a2aAudit(37)).toEqual(snapshot(37));
    expect(requests).toEqual([{ path: "/hermes-setup/a2a/audit?limit=37", method: "GET", kind: "safe" }]);
  });

  test("uses the host default without a query and rejects invalid limits before sending", async () => {
    const requests: string[] = [];
    const client = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send(path) {
        requests.push(path);
        return Response.json(snapshot(50));
      },
    } });

    expect(await client.a2aAudit()).toEqual(snapshot(50));
    expect(requests).toEqual(["/hermes-setup/a2a/audit"]);
    for (const limit of [0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(client.a2aAudit(limit)).rejects.toBeInstanceOf(RangeError);
    }
    expect(requests).toHaveLength(1);
  });

  test("bounds the response body and rejects a mismatched host limit", async () => {
    const oversizedClient = new HermesClient({ transport: {
      kind: "relay",
      async send() {
        return Response.json({ ...snapshot(50), ignored: "x".repeat(65 * 1024) });
      },
    } });
    await expect(oversizedClient.a2aAudit()).rejects.toThrow();

    const mismatchedClient = new HermesClient({ transport: {
      kind: "relay",
      async send() { return Response.json(snapshot(50)); },
    } });
    await expect(mismatchedClient.a2aAudit(37)).rejects.toMatchObject({ code: "HERMES_RESPONSE_INVALID" });
  });
});
