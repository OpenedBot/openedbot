import { describe, expect, test } from "bun:test";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { displayedRuntimeHealth, runtimeBlocksConversation, runtimeVerdictExpired } from "../../../src/lib/runtime/runtime-health";

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

describe("effective vitality and its horizon (rework-flux-api step 5d)", () => {
  const NOW = Date.parse("2026-11-07T12:00:00.000Z");
  const withLink = (link: Partial<NonNullable<RuntimePublicDto["link"]>>, overrides: Partial<RuntimePublicDto> = {}) =>
    runtime({ link: { ...runtime().link!, ...link }, ...overrides });

  test("an open but dead link (owner gone, silent) is disconnected, whatever the database said", () => {
    expect(displayedRuntimeHealth(withLink({ connected: true, live: false }), undefined, NOW)).toBe("disconnected");
    expect(displayedRuntimeHealth(withLink({ connected: true, live: true, validUntil: "2026-11-07T12:01:00.000Z" }), undefined, NOW)).toBe("healthy");
  });

  test("an older API without `live` keeps reading `connected`", () => {
    expect(displayedRuntimeHealth(withLink({ connected: false }), undefined, NOW)).toBe("disconnected");
    expect(displayedRuntimeHealth(withLink({ connected: true }), undefined, NOW)).toBe("healthy");
  });

  test("past its horizon a read is unknown, never ready, and does not block the composer", () => {
    const expired = withLink({ connected: true, live: true, validUntil: "2026-11-07T11:59:59.000Z" });
    expect(runtimeVerdictExpired(expired, NOW)).toBe(true);
    expect(displayedRuntimeHealth(expired, undefined, NOW)).toBe("unknown");
    expect(runtimeVerdictExpired(withLink({ live: true, validUntil: null }), NOW)).toBe(false);
  });

  test("unknown never erases a known verdict: disconnected, or an authentication failure", () => {
    const expiredDead = withLink({ connected: true, live: false, validUntil: "2026-11-07T11:00:00.000Z" });
    expect(displayedRuntimeHealth(expiredDead, undefined, NOW)).toBe("disconnected");
    const expiredUnauthorized = withLink({ live: true, validUntil: "2026-11-07T11:00:00.000Z" }, { lastHealthStatus: "unauthorized" });
    expect(displayedRuntimeHealth(expiredUnauthorized, undefined, NOW)).toBe("unauthorized");
  });
});
