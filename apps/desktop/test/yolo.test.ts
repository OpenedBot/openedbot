import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "../src/main/auth";
import {
  createYoloMonitor,
  formatCountdown,
  killOutcomeMessage,
  parseLeasesResponse,
  pickDisplayedLease,
  yoloStatusLabel,
  type YoloLeaseView,
  type YoloMonitorDeps,
} from "../src/main/yolo";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const RUNTIME = "11111111-1111-4111-8111-111111111111";

function dto(id: string, expiresInMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    scope: "thread",
    runtimeId: RUNTIME,
    botId: "22222222-2222-4222-8222-222222222222",
    threadId: "33333333-3333-4333-8333-333333333333",
    grantedByUserId: "44444444-4444-4444-8444-444444444444",
    issuedAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + expiresInMs).toISOString(),
    revokedAt: null,
    hostState: "active",
    deliveredAt: null,
    ...extra,
  };
}

function view(id: string, expiresInMs: number, hostState = "active"): YoloLeaseView {
  const expiresAt = new Date(NOW + expiresInMs).toISOString();
  return { id, scope: "bot", runtimeId: RUNTIME, expiresAt, expiresAtMs: Date.parse(expiresAt), hostState };
}

describe("parseLeasesResponse", () => {
  test("reads the API's YoloLeaseDto list", () => {
    const leases = parseLeasesResponse({ leases: [dto("a", 3_600_000), dto("b", 60_000, { scope: "runtime", hostState: "pending" })] });
    expect(leases?.map((lease) => [lease.id, lease.scope, lease.hostState])).toEqual([
      ["a", "thread", "active"],
      ["b", "runtime", "pending"],
    ]);
    expect(leases?.[0]?.expiresAtMs).toBe(NOW + 3_600_000);
  });

  test("an empty list is YOLO off, not an error", () => {
    expect(parseLeasesResponse({ leases: [] })).toEqual([]);
  });

  test("skips a revoked lease", () => {
    expect(parseLeasesResponse({ leases: [dto("a", 60_000, { revokedAt: new Date(NOW).toISOString() })] })).toEqual([]);
  });

  test("one unreadable lease rejects the whole answer", () => {
    expect(parseLeasesResponse(null)).toBeNull();
    expect(parseLeasesResponse({})).toBeNull();
    expect(parseLeasesResponse({ leases: "nope" })).toBeNull();
    expect(parseLeasesResponse({ leases: [dto("a", 60_000), dto("b", 60_000, { expiresAt: "tomorrow" })] })).toBeNull();
    expect(parseLeasesResponse({ leases: [dto("a", 60_000, { id: 42 })] })).toBeNull();
    expect(parseLeasesResponse({ leases: [dto("a", 60_000, { revokedAt: 1 })] })).toBeNull();
    expect(parseLeasesResponse({ leases: [42] })).toBeNull();
  });
});

describe("pickDisplayedLease", () => {
  test("shows the live lease that ends last", () => {
    const leases = [view("short", 10 * 60_000), view("long", 5 * 3_600_000), view("mid", 3_600_000)];
    expect(pickDisplayedLease(leases, NOW)?.id).toBe("long");
  });

  test("leaves out expired leases and those the host refused or ended", () => {
    const leases = [view("past", -1), view("rejected", 9 * 3_600_000, "rejected"), view("expired", 9 * 3_600_000, "expired"), view("pending", 60_000, "pending")];
    expect(pickDisplayedLease(leases, NOW)?.id).toBe("pending");
    expect(pickDisplayedLease([view("past", 0)], NOW)).toBeNull();
  });

  test("a tie goes to the smallest id, whatever the order", () => {
    expect(pickDisplayedLease([view("b", 60_000), view("a", 60_000)], NOW)?.id).toBe("a");
    expect(pickDisplayedLease([view("a", 60_000), view("b", 60_000)], NOW)?.id).toBe("a");
  });
});

describe("formatCountdown", () => {
  test("by the minute, rounded down", () => {
    expect(formatCountdown(4 * 3_600_000)).toBe("4 h 00");
    expect(formatCountdown(3 * 3_600_000 + 5 * 60_000 + 59_000)).toBe("3 h 05");
    expect(formatCountdown(3_600_000 - 1)).toBe("59 min");
    expect(formatCountdown(60_000)).toBe("1 min");
    expect(formatCountdown(59_999)).toBe("< 1 min");
    expect(formatCountdown(-5_000)).toBe("< 1 min");
  });

  test("status line: off, one lease, several", () => {
    expect(yoloStatusLabel({ displayed: null, liveCount: 0 }, NOW)).toBeNull();
    expect(yoloStatusLabel({ displayed: view("a", 2 * 3_600_000), liveCount: 1 }, NOW)).toBe("YOLO actif · encore 2 h 00");
    expect(yoloStatusLabel({ displayed: view("a", 42 * 60_000), liveCount: 3 }, NOW)).toBe("YOLO actif (3 baux) · encore 42 min");
  });
});

describe("killOutcomeMessage", () => {
  test("says what happened, and nothing when cancelled", () => {
    expect(killOutcomeMessage({ kind: "cancelled" })).toBeNull();
    expect(killOutcomeMessage({ kind: "done", revoked: 2, runtimes: 1 })?.detail).toBe("2 bail(s) révoqué(s), 1 runtime prévenu(s).");
    expect(killOutcomeMessage({ kind: "done", revoked: 0, runtimes: 3 })?.detail).toContain("Aucun bail en cours");
    expect(killOutcomeMessage({ kind: "forbidden" })?.detail).toContain("propriétaire et les administrateurs");
    const failed = killOutcomeMessage({ kind: "failed", reason: "Le serveur est injoignable." });
    expect(failed?.type).toBe("error");
    expect(failed?.detail).toContain("edge-setup yolo off");
  });
});

type Call = { url: string; method: string; headers: Record<string, string> };

function harness(options: {
  responses: Array<Response | Error>;
  confirm?: boolean;
  grants?: Array<AccessGrant | null>;
}) {
  const calls: Call[] = [];
  const reads: Array<{ force: boolean; servedToken?: string | null }> = [];
  let confirms = 0;
  let changes = 0;
  const grants = options.grants ?? [];
  const deps: YoloMonitorDeps = {
    apiOrigin: "https://api.example.com",
    auth: {
      readAccess: async (request) => {
        reads.push(request);
        if (grants.length > 0) return grants.shift() ?? null;
        return { accessToken: "access-1", accessTokenExpiresAt: new Date(NOW + 600_000).toISOString(), organizationId: "org-1" };
      },
    },
    fetch: async (url, init) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string> });
      const next = options.responses.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      if (next instanceof Error) throw next;
      return next;
    },
    confirmKill: async () => {
      confirms += 1;
      return options.confirm ?? true;
    },
    onChange: () => {
      changes += 1;
    },
    now: () => NOW,
  };
  const monitor = createYoloMonitor(deps);
  return { monitor, calls, reads, confirms: () => confirms, changes: () => changes };
}

const leasesBody = (...leases: Array<Record<string, unknown>>): Response => Response.json({ leases });

describe("monitor", () => {
  test("polls GET /leases with the bearer and the tenant header", async () => {
    const h = harness({ responses: [leasesBody(dto("a", 3_600_000), dto("b", 2 * 3_600_000))] });
    h.monitor.start();
    await h.monitor.pollNow();
    h.monitor.stop();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      url: "https://api.example.com/api/organization/yolo/leases",
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer access-1", "X-OHB-Organization": "org-1" },
    });
  });

  test("exposes the longest lease, and forgets everything on stop", async () => {
    const h = harness({ responses: [leasesBody(dto("a", 3_600_000), dto("b", 2 * 3_600_000))] });
    h.monitor.start();
    await h.monitor.pollNow();
    expect(h.monitor.snapshot()).toMatchObject({ liveCount: 2, canKill: true, killing: false });
    expect(h.monitor.snapshot().displayed?.id).toBe("b");
    expect(h.changes()).toBeGreaterThan(0);
    h.monitor.stop();
    expect(h.monitor.snapshot().displayed).toBeNull();
  });

  test("keeps the last leases when a poll fails or answers garbage", async () => {
    const h = harness({ responses: [leasesBody(dto("a", 3_600_000)), new Error("offline"), Response.json({ nope: true }), Response.json({}, { status: 500 })] });
    h.monitor.start();
    await h.monitor.pollNow();
    await h.monitor.pollNow();
    await h.monitor.pollNow();
    await h.monitor.pollNow();
    expect(h.monitor.snapshot().displayed?.id).toBe("a");
    h.monitor.stop();
  });

  test("a 401 forces one rotation, then retries with the new token", async () => {
    const h = harness({
      responses: [Response.json({ error: { code: "AUTH_REQUIRED" } }, { status: 401 }), leasesBody(dto("a", 60_000))],
      grants: [
        { accessToken: "stale", accessTokenExpiresAt: new Date(NOW).toISOString(), organizationId: "org-1" },
        { accessToken: "fresh", accessTokenExpiresAt: new Date(NOW + 600_000).toISOString(), organizationId: "org-1" },
      ],
    });
    h.monitor.start();
    await h.monitor.pollNow();
    h.monitor.stop();
    expect(h.reads).toEqual([{ force: false }, { force: true, servedToken: "stale" }]);
    expect(h.calls.map((call) => call.headers.Authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  test("signed out: no request, no lease", async () => {
    const h = harness({ responses: [], grants: [null] });
    h.monitor.start();
    await h.monitor.pollNow();
    h.monitor.stop();
    expect(h.calls).toHaveLength(0);
    expect(h.monitor.snapshot().displayed).toBeNull();
  });
});

describe("killEverywhere", () => {
  test("asks first; a refusal sends nothing", async () => {
    const h = harness({ responses: [], confirm: false });
    expect(await h.monitor.killEverywhere()).toEqual({ kind: "cancelled" });
    expect(h.confirms()).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  test("confirmed: POST /kill, then reads the leases back", async () => {
    const h = harness({ responses: [leasesBody(dto("a", 3_600_000)), Response.json({ revoked: 1, runtimes: 2 }), leasesBody()] });
    h.monitor.start();
    await h.monitor.pollNow();
    const outcome = await h.monitor.killEverywhere();
    await h.monitor.pollNow();
    h.monitor.stop();
    expect(outcome).toEqual({ kind: "done", revoked: 1, runtimes: 2 });
    expect(h.calls.map((call) => `${call.method} ${call.url.replace("https://api.example.com", "")}`)).toEqual([
      "GET /api/organization/yolo/leases",
      "POST /api/organization/yolo/kill",
      "GET /api/organization/yolo/leases",
    ]);
    expect(h.calls[1]?.headers["X-OHB-Organization"]).toBe("org-1");
  });

  test("a 403 is reported and hides the entry until the session changes", async () => {
    const h = harness({ responses: [Response.json({ error: { code: "ROLE_REQUIRED" } }, { status: 403 })] });
    expect(await h.monitor.killEverywhere()).toEqual({ kind: "forbidden" });
    expect(h.monitor.snapshot().canKill).toBe(false);
    h.monitor.stop();
    expect(h.monitor.snapshot().canKill).toBe(true);
  });

  test("a server or network failure says so, the entry stays", async () => {
    const h = harness({ responses: [Response.json({ error: { code: "INTERNAL" } }, { status: 500 }), new Error("offline")] });
    expect(await h.monitor.killEverywhere()).toEqual({ kind: "failed", reason: "Le serveur a répondu 500 (INTERNAL)." });
    expect(await h.monitor.killEverywhere()).toEqual({ kind: "failed", reason: "Le serveur est injoignable." });
    expect(h.monitor.snapshot().canKill).toBe(true);
  });

  test("signed out meanwhile: nothing sent", async () => {
    const h = harness({ responses: [], grants: [null] });
    expect(await h.monitor.killEverywhere()).toEqual({ kind: "signed-out" });
    expect(h.calls).toHaveLength(0);
  });
});
