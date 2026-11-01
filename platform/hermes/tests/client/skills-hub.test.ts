import { describe, expect, test } from "bun:test";
import {
  HermesClient,
  HermesClientError,
  isSkillsHubIdentifier,
  parseSkillsHubInspection,
  parseSkillsHubOperation,
  parseSkillsHubScan,
  parseSkillsHubSearch,
  type HermesSkillsHubOperation,
  type HermesSkillsHubScan,
  type HermesSkillsHubSearchResult,
} from "../../src";
import type { HermesRequestKind, HermesTransport } from "../../src/transport/types";

type Sent = { path: string; method: string; kind: HermesRequestKind; body?: string };

function clientFor(body: unknown) {
  const sent: Sent[] = [];
  const transport: HermesTransport = {
    kind: "relay",
    async send(path, init, kind) {
      sent.push({ path, method: (init.method ?? "GET").toUpperCase(), kind, body: typeof init.body === "string" ? init.body : undefined });
      return Response.json(body);
    },
  };
  return { client: new HermesClient({ transport }), sent };
}

const search: HermesSkillsHubSearchResult[] = [{ name: "Research", identifier: "official/research", source: "official", trustLevel: "official", description: "A brief." }];
const inspection = {
  name: "Research", description: "A brief.", source: "official", identifier: "official/research", tags: ["research"], skillMdPreview: "# Research",
};
const scan: HermesSkillsHubScan = {
  trustLevel: "official", source: "official", verdict: "safe", policy: "allow",
  findings: [{ severity: "low", category: "style", description: "A note.", file: "SKILL.md", line: 1 }],
};
const operation: HermesSkillsHubOperation = {
  operationId: "123e4567-e89b-12d3-a456-426614174000", profile: "scout", identifier: "official/research", state: "succeeded", error: null, skills: ["official/research"],
};

describe("Skills Hub Hermes surface", () => {
  test("parses search, inspect, scan and terminal operation payloads", async () => {
    expect(parseSkillsHubSearch(search)).toEqual(search);
    expect(parseSkillsHubInspection(inspection)).toEqual(inspection);
    expect(parseSkillsHubScan(scan)).toEqual(scan);
    expect(parseSkillsHubOperation(operation)).toEqual(operation);

    const { client, sent } = clientFor(search);
    await expect(client.skillsHubSearch("research", { source: "official", limit: 5 })).resolves.toEqual(search);
    expect(sent[0]).toMatchObject({ path: "/hermes-setup/skills/hub/search", method: "POST", kind: "safe" });
    expect(JSON.parse(sent[0]!.body!)).toEqual({ query: "research", source: "official", limit: 5 });
  });

  test("rejects an unknown operation state and missing required fields", () => {
    expect(() => parseSkillsHubOperation({ ...operation, state: "done" })).toThrow(HermesClientError);
    expect(() => parseSkillsHubOperation({ ...operation, identifier: undefined })).toThrow(HermesClientError);
    expect(() => parseSkillsHubScan({ ...scan, policy: "unknown" })).toThrow(HermesClientError);
  });

  test("parses upstream caution and dangerous findings", () => {
    for (const verdict of ["safe", "caution", "dangerous"] as const) {
      expect(parseSkillsHubScan({ ...scan, verdict })).toMatchObject({ verdict, findings: scan.findings });
    }
    expect(() => parseSkillsHubScan({ ...scan, findings: [{ ...scan.findings[0], description: "x".repeat(1_001) }] })).toThrow(HermesClientError);
  });

  test("keeps upstream GitHub identifiers and drops only the rows outside the class", () => {
    const github = { name: "tao-run-on-kubernetes", identifier: "NVIDIA/skills/skills/tao-run-on-kubernetes", source: "github", trustLevel: "trusted", description: "Run TAO jobs." };
    expect(parseSkillsHubSearch([github, ...search])).toEqual([github as HermesSkillsHubSearchResult, ...search]);
    const outside = { ...github, identifier: "well-known:https://example.invalid/skill" };
    expect(parseSkillsHubSearch([outside, ...search, { ...github, trustLevel: "unknown" }])).toEqual(search);
    for (const identifier of ["a/b/../c", "a/b//c", "a/../b", "a//b", "a/b:ref", "a/b c", `${"a".repeat(9)}/${"b".repeat(191)}`]) {
      expect(isSkillsHubIdentifier(identifier)).toBe(false);
      expect(parseSkillsHubSearch([{ ...github, identifier }, ...search])).toEqual(search);
    }
    expect(isSkillsHubIdentifier(`${"a".repeat(8)}/${"b".repeat(191)}`)).toBe(true);
    expect(() => parseSkillsHubSearch(["not a row"])).toThrow(HermesClientError);
    expect(() => parseSkillsHubSearch({ results: search })).toThrow(HermesClientError);
  });

  test("validates bounded identifiers before dispatch", async () => {
    const { client, sent } = clientFor(search);
    await expect(client.skillsHubInspect("well-known:https://example.invalid")).rejects.toMatchObject({ code: "SKILL_IDENTIFIER_INVALID" });
    await expect(client.skillsHubSearch(" ")).rejects.toMatchObject({ code: "SKILL_QUERY_INVALID" });
    expect(sent).toHaveLength(0);
  });
});
