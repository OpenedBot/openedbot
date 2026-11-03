import { describe, expect, test } from "bun:test";
import { publicRuntime, type RuntimeRow } from "../src/routes/runtimes/runtime-routes";
import type { RuntimeProviderIncidentDto } from "@openedbot/contracts-api";

const row: RuntimeRow = {
  id: "runtime-1",
  name: "Hermes",
  endpoint: null,
  tokenCiphertext: null,
  tokenNonce: null,
  tokenTag: null,
  tokenKeyId: null,
  reachability: "connector",
  linkConnectedAt: new Date("2026-09-04T20:00:00.000Z"),
  linkLastSeenAt: new Date("2026-09-04T20:00:00.000Z"),
  linkFeatures: [],
  linkRotatedAt: null,
  linkLastReplacedAt: null,
  linkHijackSuspectedAt: null,
  selectedProvider: "openai-codex",
  selectedModel: "gpt-5.4",
  reasoningEffort: null,
  capacity: 4,
  lastHealthStatus: "healthy",
  lastHealthError: null,
  lastProbedAt: null,
  isActive: true,
  createdAt: new Date("2026-09-04T00:00:00.000Z"),
  updatedAt: new Date("2026-09-04T00:00:00.000Z"),
};

const incident: RuntimeProviderIncidentDto = {
  provider: "openai-codex",
  kind: "quota",
  firstSeenAt: "2026-09-04T20:03:00.000Z",
  lastSeenAt: "2026-09-04T20:03:00.000Z",
  until: "2026-09-05T02:03:00.000Z",
  fallbackProvider: "opencode-free",
  fallbackModel: "nemotron",
  message: "HTTP 429: The usage limit has been reached",
};

describe("publicRuntime providerIncidents", () => {
  test("defaults to an empty list", () => {
    expect(publicRuntime(row, "disabled").providerIncidents).toEqual([]);
  });

  test("carries active incidents on GET /api/runtime", () => {
    expect(publicRuntime(row, "disabled", [incident]).providerIncidents).toEqual([incident]);
  });
});
