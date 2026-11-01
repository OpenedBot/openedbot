import { describe, expect, test } from "bun:test";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { runtimeBlocksConversation } from "../../src/lib/runtime-health";

function runtime(overrides: Partial<RuntimePublicDto> = {}): RuntimePublicDto {
  return {
    id: "6f0a1b2c-3d4e-4f50-9a1b-2c3d4e5f6071",
    configured: true,
    baseUrl: null,
    reachability: "connector",
    transport: "connector",
    link: {
      connected: true,
      lastSeenAt: "2026-09-16T10:00:00.000Z",
      lastReplacedAt: null,
      hijackSuspectedAt: null,
      rotatedAt: null,
      origin: null,
      originRetired: false,
      relinkCommand: null,
    },
    management: { kind: "host", credentialsWritable: true, oauthWritable: true },
    name: "runtime",
    isDefault: true,
    isActive: true,
    tokenConfigured: true,
    botCount: 1,
    selectedProvider: "openai",
    selectedModel: "gpt-test",
    reasoningEffort: null,
    detectedVersion: null,
    capabilities: null,
    lastHealthStatus: "healthy",
    lastHealthError: null,
    lastCheckedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("runtimeBlocksConversation", () => {
  test("does not block before the runtime query settles", () => {
    expect(runtimeBlocksConversation(undefined, false)).toBe(false);
  });

  test("blocks a missing or disconnected runtime", () => {
    expect(runtimeBlocksConversation(null, true)).toBe(true);
    expect(runtimeBlocksConversation(runtime({ link: { ...runtime().link!, connected: false } }), true)).toBe(true);
  });

  test("keeps the composer available for a healthy or not-yet-tested link", () => {
    expect(runtimeBlocksConversation(runtime(), true)).toBe(false);
    expect(runtimeBlocksConversation(runtime({ lastHealthStatus: "unknown" }), true)).toBe(false);
  });
});
