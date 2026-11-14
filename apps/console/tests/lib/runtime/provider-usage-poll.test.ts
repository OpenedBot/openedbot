import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { RuntimeProviderUsageDto } from "@openedbot/contracts-api";
import {
  countPendingPolls,
  PROVIDER_USAGE_FALLBACK_POLL_MS,
  PROVIDER_USAGE_JITTER_MS,
  PROVIDER_USAGE_MAX_POLL_MS,
  PROVIDER_USAGE_MIN_POLL_MS,
  PROVIDER_USAGE_PENDING_POLL_MS,
  PROVIDER_USAGE_PENDING_POLLS,
  PROVIDER_USAGE_RETRY_POLL_MS,
  PROVIDER_USAGE_SLOW_PENDING_POLL_MS,
  providerUsagePollMs,
  providerUsageStaleMs,
} from "../../../src/lib/runtime/provider-usage-poll";

const NOW = Date.parse("2026-11-07T10:00:00Z");

function usage(status: RuntimeProviderUsageDto["status"], freshUntil: string | null = null): RuntimeProviderUsageDto {
  return { runtimeId: "rt", status, reason: null, fetchedAt: null, freshUntil, providers: [], error: null };
}

describe("providerUsagePollMs", () => {
  test("a fresh reading is read again at freshUntil, plus a bounded jitter that only delays", () => {
    const ok = usage("ok", "2026-11-07T10:05:00Z");
    expect(providerUsagePollMs(ok, 0, NOW, () => 0)).toBe(5 * 60_000);
    expect(providerUsagePollMs(ok, 0, NOW, () => 0.999999)).toBe(5 * 60_000 + PROVIDER_USAGE_JITTER_MS - 1);
    expect(providerUsagePollMs(ok, 0, NOW, () => 7)).toBe(5 * 60_000 + PROVIDER_USAGE_JITTER_MS);
  });

  test("freshUntil already passed, too close or too far is clamped", () => {
    expect(providerUsagePollMs(usage("ok", "2026-11-07T09:00:00Z"), 0, NOW, () => 0)).toBe(PROVIDER_USAGE_MIN_POLL_MS);
    expect(providerUsagePollMs(usage("ok", "2026-11-07T10:00:05Z"), 0, NOW, () => 0)).toBe(PROVIDER_USAGE_MIN_POLL_MS);
    expect(providerUsagePollMs(usage("ok", "2026-11-08T10:00:00Z"), 0, NOW, () => 0)).toBe(PROVIDER_USAGE_MAX_POLL_MS);
  });

  test("absent or invalid freshUntil falls back to the former cadence", () => {
    expect(providerUsagePollMs(usage("ok", null), 0, NOW)).toBe(PROVIDER_USAGE_FALLBACK_POLL_MS);
    expect(providerUsagePollMs(usage("ok", "not a date"), 0, NOW)).toBe(PROVIDER_USAGE_FALLBACK_POLL_MS);
    expect(providerUsagePollMs(undefined, 0, NOW)).toBe(PROVIDER_USAGE_FALLBACK_POLL_MS);
  });

  // Codex: the 2 s loop must serve every probe in flight, the first load and
  // the automatic stale renewal included, not only the manual refresh.
  test("loading and stale poll quickly, then slow down past the bounded budget", () => {
    for (const status of ["loading", "stale"] as const) {
      expect(providerUsagePollMs(usage(status), 1, NOW)).toBe(PROVIDER_USAGE_PENDING_POLL_MS);
      expect(providerUsagePollMs(usage(status), PROVIDER_USAGE_PENDING_POLLS, NOW)).toBe(PROVIDER_USAGE_PENDING_POLL_MS);
      expect(providerUsagePollMs(usage(status), PROVIDER_USAGE_PENDING_POLLS + 1, NOW)).toBe(PROVIDER_USAGE_SLOW_PENDING_POLL_MS);
    }
  });

  test("failures and closed links retry slowly; an unsupported host is barely polled", () => {
    expect(providerUsagePollMs(usage("error"), 0, NOW)).toBe(PROVIDER_USAGE_RETRY_POLL_MS);
    expect(providerUsagePollMs(usage("disconnected"), 0, NOW)).toBe(PROVIDER_USAGE_RETRY_POLL_MS);
    expect(providerUsagePollMs(usage("unsupported"), 0, NOW)).toBe(PROVIDER_USAGE_MAX_POLL_MS);
  });
});

describe("providerUsageStaleMs", () => {
  // Codex: TanStack counts staleTime from dataUpdatedAt. A reading 160 s old,
  // fresh for 140 s more, must not be stale on focus or remount.
  test("in the query cache, a reading stays fresh until freshUntil, measured from dataUpdatedAt", () => {
    const client = new QueryClient();
    const key = ["provider-usage", "rt"];
    const now = Date.now();
    const reading = usage("ok", new Date(now + 140_000).toISOString());
    client.setQueryData(key, reading, { updatedAt: now - 160_000 });
    const query = client.getQueryCache().find({ queryKey: key })!;
    const staleTime = providerUsageStaleMs(query.state.data as RuntimeProviderUsageDto, query.state.dataUpdatedAt);
    expect(query.isStaleByTime(staleTime)).toBe(false);
    client.setQueryData(key, usage("ok", new Date(now - 1_000).toISOString()), { updatedAt: now - 301_000 });
    const expired = providerUsageStaleMs(query.state.data as RuntimeProviderUsageDto, query.state.dataUpdatedAt);
    expect(query.isStaleByTime(expired)).toBe(true);
    client.clear();
  });

  test("an ok reading stays fresh in cache until freshUntil, anything else is stale at once", () => {
    expect(providerUsageStaleMs(usage("ok", "2026-11-07T10:05:00Z"), NOW)).toBe(5 * 60_000);
    expect(providerUsageStaleMs(usage("ok", "2026-11-07T09:00:00Z"), NOW)).toBe(0);
    expect(providerUsageStaleMs(usage("stale", "2026-11-07T10:05:00Z"), NOW)).toBe(0);
    expect(providerUsageStaleMs(undefined, NOW)).toBe(0);
  });
});

describe("countPendingPolls", () => {
  test("counts each pending reading once, by dataUpdatedAt, and resets on a settled one", () => {
    let state = { dataUpdatedAt: 0, count: 0 };
    state = countPendingPolls(state, usage("loading"), 1);
    state = countPendingPolls(state, usage("loading"), 1);
    expect(state.count).toBe(1);
    state = countPendingPolls(state, usage("stale"), 2);
    expect(state.count).toBe(2);
    state = countPendingPolls(state, usage("ok", "2026-11-07T10:05:00Z"), 3);
    expect(state.count).toBe(0);
  });
});
