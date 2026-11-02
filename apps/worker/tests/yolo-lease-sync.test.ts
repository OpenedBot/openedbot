import { beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { decodeTextFrame } from "@openedbot/contracts-connector";
import { resetYoloLeaseSync, syncYoloLeases, yoloSyncFrame } from "../src/maintenance/yolo-lease-sync";

const id = (n: number) => `95910000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const RUNTIME = id(51);

const payload = (leaseId: string) => ({
  v: 1, leaseId, organizationId: ORG, runtimeId: RUNTIME, scope: "runtime", profile: null, sessionKey: null,
  issuedAt: 1_793_491_000, notBefore: 1_793_491_000, expiresAt: 1_793_505_400, grantedBy: id(11),
  deny: { commands: [], tools: [], paths: [] }, protect: ["ssh"],
});

type Due = { id: string; runtimeId: string; payload: unknown; keyId: string; signature: string; revokedAt: Date | null };

const lease = (n: number, revokedAt: Date | null = null): Due => ({
  id: id(200 + n), runtimeId: RUNTIME, payload: payload(id(200 + n)), keyId: "e".repeat(32), signature: `${"A".repeat(86)}==`, revokedAt,
});

function fakeDb(input: { organizations?: string[]; due?: Due[]; expired?: number }) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let organizationsServed = false;
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    statements.push({ sql, values });
    if (sql.includes("select distinct organization_id")) {
      // One batch, then the end of the cycle (the cursor resets).
      if (organizationsServed) return [];
      organizationsServed = true;
      return (input.organizations ?? [ORG]).map((organizationId) => ({ organizationId }));
    }
    if (sql.includes("set host_state = 'expired'")) return Array.from({ length: input.expired ?? 0 }, (_, index) => ({ id: id(300 + index) }));
    if (sql.includes("from permission_yolo_leases l")) return input.due ?? [];
    return [];
  };
  const db = Object.assign(run, { begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(run) }) as unknown as SQL;
  return { db, statements };
}

function fakeFetch(pushed: boolean | ((body: { kind: string; frame: unknown }) => boolean) = true) {
  const calls: Array<{ url: string; body: { kind: string; frame: unknown }; headers: Record<string, string> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { kind: string; frame: unknown };
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    const ok = typeof pushed === "function" ? pushed(body) : pushed;
    return Response.json({ pushed: ok });
  };
  return { calls, fetchImpl };
}

const options = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, now = new Date("2026-11-02T10:00:00Z")) => ({
  apiInternalUrl: "http://api:8790/",
  runtimeLinkInternalUrl: "http://link:8792",
  apiInternalToken: "internal-token",
  fetchImpl,
  now: () => now,
});

beforeEach(() => resetYoloLeaseSync());

describe("yolo-lease-sync", () => {
  test("marque les baux échus, sous le tenant de chaque organisation", async () => {
    const { db, statements } = fakeDb({ expired: 2 });
    const { fetchImpl, calls } = fakeFetch();
    expect(await syncYoloLeases(db, options(fetchImpl))).toEqual({ expired: 2, pushed: 0, failed: 0 });
    const tenant = statements.findIndex(({ sql }) => sql.includes("app.organization_id"));
    expect(statements[tenant]!.values[0]).toBe(ORG);
    const expire = statements.find(({ sql }) => sql.includes("set host_state = 'expired'"))!;
    expect(expire.sql).toContain("host_state_reason = 'window_elapsed'");
    expect(expire.sql).toContain("revoked_at is null and expires_at <= now()");
    expect(statements.indexOf(expire)).toBeGreaterThan(tenant);
    expect(calls).toEqual([]);
  });

  test("repousse un bail non livré et une révocation non confirmée par le relais de contrôle du lien", async () => {
    const revokedAt = new Date("2026-11-02T09:30:00Z");
    const { db, statements } = fakeDb({ due: [lease(1), lease(2, revokedAt)] });
    const { fetchImpl, calls } = fakeFetch();
    expect(await syncYoloLeases(db, options(fetchImpl))).toEqual({ expired: 0, pushed: 2, failed: 0 });
    expect(calls.map((call) => call.url)).toEqual([
      `http://link:8792/internal/runtime-links/${RUNTIME}/control`,
      `http://link:8792/internal/runtime-links/${RUNTIME}/control`,
    ]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer internal-token");
    // Ce que le relais relit, une trame valide du contrat : le bail signé tel quel, puis sa révocation.
    expect(decodeTextFrame(JSON.stringify(calls[0]!.body.frame))).toMatchObject({ t: "yolo.lease", lease: { leaseId: id(201) } });
    expect(calls[1]!.body).toEqual({ kind: "yolo", frame: { t: "yolo.revoke", leaseId: id(202), revokedAt: Math.floor(revokedAt.getTime() / 1000) } });
    // Seuls les hôtes connectés qui savent appliquer un bail, et un bail de thread exige la portée thread.
    const due = statements.find(({ sql }) => sql.includes("from permission_yolo_leases l"))!;
    expect(due.sql).toContain("r.link_features @> array['yolo_lease']::text[]");
    expect(due.sql).toContain("l.scope <> 'thread' or r.link_features @> array['yolo_thread_scope']::text[]");
    expect(due.sql).toContain("r.last_health_status <> 'disconnected'");
  });

  test("un échec de poussée recule : le bail n'est pas repoussé avant son délai", async () => {
    const now = new Date("2026-11-02T10:00:00Z");
    const first = fakeDb({ due: [lease(1)] });
    const failing = fakeFetch(false);
    expect(await syncYoloLeases(first.db, options(failing.fetchImpl, now))).toEqual({ expired: 0, pushed: 0, failed: 1 });
    const again = fakeDb({ due: [lease(1)] });
    expect(await syncYoloLeases(again.db, options(failing.fetchImpl, new Date(now.getTime() + 30_000)))).toEqual({ expired: 0, pushed: 0, failed: 0 });
    expect(failing.calls).toHaveLength(1);
    const later = fakeDb({ due: [lease(1)] });
    const working = fakeFetch(true);
    expect(await syncYoloLeases(later.db, options(working.fetchImpl, new Date(now.getTime() + 61_000)))).toEqual({ expired: 0, pushed: 1, failed: 0 });
  });

  test("une charge stockée illisible n'est jamais poussée", async () => {
    const broken = { ...lease(1), payload: { v: 2 } };
    expect(yoloSyncFrame(broken)).toBeNull();
    const { db } = fakeDb({ due: [broken] });
    const { fetchImpl, calls } = fakeFetch();
    expect(await syncYoloLeases(db, options(fetchImpl))).toEqual({ expired: 0, pushed: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  test("sans organisation à visiter, le curseur repart du début", async () => {
    const { db } = fakeDb({ organizations: [] });
    const { fetchImpl } = fakeFetch();
    expect(await syncYoloLeases(db, options(fetchImpl))).toEqual({ expired: 0, pushed: 0, failed: 0 });
  });
});
