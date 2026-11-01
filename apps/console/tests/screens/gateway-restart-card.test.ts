import { describe, expect, test } from "bun:test";
import type { RuntimeGatewayRestartDto } from "@openedbot/contracts-api";
import { freshHostJob } from "../../src/screens/settings/installation/connectors-mcp-gateway";

const job = (overrides: Partial<RuntimeGatewayRestartDto> = {}): RuntimeGatewayRestartDto => ({
  jobId: "job-1", status: "ok", step: "done", startedAt: "2026-10-24T18:00:00Z",
  finishedAt: "2026-10-24T18:00:20Z", error: null, expiresAt: "2026-10-24T19:00:00Z", ...overrides,
});

describe("freshHostJob", () => {
  test("hides a finished restart older than the pending change", () => {
    expect(freshHostJob({ restartPending: true, pendingSince: "2026-10-24T18:53:00Z", activeSince: null, job: job() })).toBeNull();
  });

  test("keeps a restart that ended after the change, a running one, and any when nothing is pending", () => {
    const later = job({ finishedAt: "2026-10-24T18:54:00Z" });
    expect(freshHostJob({ restartPending: true, pendingSince: "2026-10-24T18:53:00Z", activeSince: null, job: later })).toBe(later);
    const running = job({ status: "running", finishedAt: null });
    expect(freshHostJob({ restartPending: true, pendingSince: "2026-10-24T18:53:00Z", activeSince: null, job: running })).toBe(running);
    const done = job();
    expect(freshHostJob({ restartPending: false, pendingSince: null, activeSince: null, job: done })).toBe(done);
    expect(freshHostJob(undefined)).toBeNull();
  });
});
