import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { YoloLease } from "@openedbot/contracts-api";
import { verifyYoloLeaseSignature } from "@openedbot/execution/domain/yolo-lease";
import type { YoloLeasePublisher } from "@openedbot/execution/application/yolo-leases";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { yoloRoutes } from "../src/routes/identity/yolo-routes";
import { HttpError } from "../src/interfaces/http/http-error";

const ORG = "7b000000-0000-4000-8000-000000000001";
const OWNER = "7b000000-0000-4000-8000-000000000011";
const RUNTIME = "7b000000-0000-4000-8000-000000000021";
const OTHER_RUNTIME = "7b000000-0000-4000-8000-000000000022";
const BOT = "7b000000-0000-4000-8000-000000000031";
const THREAD = "7b000000-0000-4000-8000-000000000041";
const LEASE = "7b000000-0000-4000-8000-000000000051";
const SESSION = "hermes-session-1";
// A public TEST seed (0x00..0x1f), the one of the shared lease vector: never a real key.
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const NOW = 1_800_000_000_000;

const base: AuthContext = { sessionId: "s", organizationId: ORG, userId: OWNER, role: "owner", kind: "web", credentialHash: "c" };

type State = {
  policy?: { maxMode: string | null; enforceReview: boolean; commandBlocklist: readonly string[] } | null;
  grantStatus?: string;
  botProfile?: string | null;
  consent?: boolean;
};

type Call = { sql: string; parameters: unknown[] };

function fakeDb(state: State, calls: Call[]): SQL {
  const leases = new Map<string, Record<string, unknown>>();
  const tx = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ sql, parameters });
    if (sql.includes("set_config")) return Promise.resolve([{}]);
    if (sql.includes("from organization_permission_policies")) {
      return Promise.resolve(state.policy ? [{ ...state.policy, rulesMode: "adds", version: 1, updatedAt: new Date(0) }] : []);
    }
    if (sql.includes("from runtimes where") && sql.includes("is_active")) return Promise.resolve([{ id: RUNTIME }]);
    if (sql.includes("from runtimes where") && sql.includes("revoked_at is null")) {
      return Promise.resolve(sql.includes("and id =") ? [{ id: parameters[1] }] : [{ id: RUNTIME }, { id: OTHER_RUNTIME }]);
    }
    if (sql.includes("from bots")) return Promise.resolve(state.botProfile === undefined ? [{ profile: "designer" }] : state.botProfile === "gone" ? [] : [{ profile: state.botProfile }]);
    if (sql.includes("from threads")) return Promise.resolve([{ sessionId: SESSION }]);
    if (sql.includes("grant_permission_yolo_lease")) {
      const status = state.grantStatus ?? "granted";
      if (status === "granted") {
        const lease = JSON.parse(String(parameters[6])) as YoloLease;
        leases.set(lease.leaseId, {
          id: lease.leaseId, scope: lease.scope, runtimeId: lease.runtimeId, botId: parameters[2], threadId: parameters[3],
          grantedByUserId: lease.grantedBy, issuedAt: new Date(lease.issuedAt * 1000), expiresAt: new Date(lease.expiresAt * 1000),
          revokedAt: null, hostState: "pending", deliveredAt: null,
        });
      }
      return Promise.resolve([{ status, superseded: status === "granted" ? [LEASE] : [] }]);
    }
    if (sql.includes("revoke_permission_yolo_leases")) {
      const id = parameters[2] as string | null;
      const revoked = [...leases.values()].filter((row) => row.revokedAt === null && (id === null || row.id === id));
      for (const row of revoked) row.revokedAt = new Date(NOW);
      return Promise.resolve(revoked.map((row) => ({ leaseId: row.id, runtimeId: row.runtimeId })));
    }
    if (sql.includes("from permission_yolo_leases where organization_id = ? and id = ?")) {
      const row = leases.get(String(parameters[1]));
      return Promise.resolve(row ? [row] : []);
    }
    if (sql.includes("from permission_yolo_leases")) return Promise.resolve([...leases.values()].filter((row) => row.revokedAt === null));
    if (sql.includes("from permission_yolo_consents")) return Promise.resolve(state.consent ? [{ acknowledgedAt: new Date(NOW), soloDefault: false }] : []);
    if (sql.includes("insert into permission_yolo_consents")) return Promise.resolve([{ acknowledgedAt: new Date(NOW), soloDefault: parameters[2] }]);
    if (sql.includes("from permission_yolo_audit")) {
      return Promise.resolve([{
        id: "7", runtimeId: RUNTIME, leaseId: LEASE, writeSeq: "3", occurredAt: new Date(NOW), profile: "designer",
        gateKind: "plugin_tool", toolKey: "write_file", argsHash: "a".repeat(64), entryHash: "b".repeat(64),
      }]);
    }
    throw new Error(`unexpected query: ${sql}`);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

type Pushed = { kind: "lease" | "revoke"; runtimeId: string; frame: Record<string, unknown> };

function mount(state: State, auth: AuthContext, options: { seed?: Uint8Array | null; failPush?: boolean } = {}) {
  const calls: Call[] = [];
  const pushed: Pushed[] = [];
  const publisher: YoloLeasePublisher = {
    pushLease: async ({ runtimeId, frame }) => {
      if (options.failPush) throw new Error("link down");
      pushed.push({ kind: "lease", runtimeId, frame });
    },
    pushRevoke: async ({ runtimeId, frame }) => {
      if (options.failPush) throw new Error("link down");
      pushed.push({ kind: "revoke", runtimeId, frame });
    },
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, ...(error.details ? { details: error.details } : {}) } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  const seed = options.seed === undefined ? TEST_SEED : options.seed;
  app.route("/", yoloRoutes(fakeDb(state, calls), { signing: { seed, previousSeeds: [] }, publisher, now: () => NOW }));
  return { app, calls, pushed };
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const grant = (target: ReturnType<typeof mount>, body: unknown = { scope: "thread", botId: BOT, threadId: THREAD, acknowledged: true }) =>
  target.app.request("/leases", json(body));
const granted = (calls: Call[]) => calls.some((call) => call.sql.includes("grant_permission_yolo_lease"));

describe("POST /api/organization/yolo/leases", () => {
  test("a member or an agency cannot grant, and nothing reaches the database", async () => {
    for (const role of ["member", "agency"] as const) {
      const target = mount({}, { ...base, role });
      const response = await grant(target);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "ROLE_REQUIRED" } });
      expect(granted(target.calls)).toBe(false);
    }
  });

  test("a bot, a tool or an assisted session never grants, even as an owner", async () => {
    for (const auth of [{ ...base, kind: "bot" }, { ...base, kind: "mcp" }, { ...base, impersonatedByStaffUserId: "staff-1" }] as AuthContext[]) {
      const target = mount({}, auth);
      const response = await grant(target);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "YOLO_HUMAN_REQUIRED" } });
      expect(granted(target.calls)).toBe(false);
    }
  });

  test("without a signing key the server refuses with 503 and never writes an unsigned lease", async () => {
    const target = mount({}, base, { seed: null });
    const response = await grant(target);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "YOLO_SIGNING_UNAVAILABLE" } });
    expect(target.calls).toEqual([]);
    expect(await (await target.app.request("/keys")).json()).toEqual({ keys: [] });
  });

  test("a ceiling below bypass or an enforced review is an explicit refusal with its reason", async () => {
    for (const [policy, reason] of [
      [{ maxMode: "auto", enforceReview: false, commandBlocklist: [] }, "ceiling"],
      [{ maxMode: null, enforceReview: true, commandBlocklist: [] }, "enforce_review"],
    ] as const) {
      const target = mount({ policy }, base);
      const response = await grant(target);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "YOLO_BLOCKED_BY_POLICY", details: { reason } } });
      expect(granted(target.calls)).toBe(false);
    }
    // The definer function's own check (a policy saved meanwhile) answers the same.
    const raced = await grant(mount({ grantStatus: "blocked_enforce_review" }, base));
    expect(await raced.json()).toEqual({ error: { code: "YOLO_BLOCKED_BY_POLICY", details: { reason: "enforce_review" } } });
  });

  test("a first grant without confirmation is 428, and an unsupported host is 409 with its reason", async () => {
    const ack = await grant(mount({ grantStatus: "ack_required" }, base), { scope: "bot", botId: BOT });
    expect(ack.status).toBe(428);
    expect(await ack.json()).toEqual({ error: { code: "YOLO_ACK_REQUIRED" } });
    for (const [status, reason] of [["host_unsupported", "yolo_lease"], ["host_unsupported_thread", "yolo_thread_scope"]] as const) {
      const response = await grant(mount({ grantStatus: status }, base));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "YOLO_HOST_UNSUPPORTED", details: { reason } } });
    }
    const noProfile = await grant(mount({ botProfile: null }, base), { scope: "bot", botId: BOT });
    expect(await noProfile.json()).toEqual({ error: { code: "YOLO_HOST_UNSUPPORTED", details: { reason: "bot_profile_missing" } } });
  });

  test("an owner gets a signed 4 h thread lease, pushed after the commit, the previous one revoked", async () => {
    const target = mount({ policy: { maxMode: "bypass", enforceReview: false, commandBlocklist: ["git push --force"] } }, base);
    const response = await grant(target);
    expect(response.status).toBe(201);
    const { lease } = await response.json() as { lease: Record<string, unknown> };
    expect(lease).toMatchObject({ scope: "thread", runtimeId: RUNTIME, botId: BOT, threadId: THREAD, grantedByUserId: OWNER, hostState: "pending", revokedAt: null });
    expect(Date.parse(String(lease.expiresAt)) - Date.parse(String(lease.issuedAt))).toBe(4 * 3600 * 1000);

    const call = target.calls.find((entry) => entry.sql.includes("grant_permission_yolo_lease"))!;
    const payload = JSON.parse(String(call.parameters[6])) as YoloLease;
    expect(payload).toMatchObject({
      organizationId: ORG, runtimeId: RUNTIME, scope: "thread", profile: "designer", grantedBy: OWNER,
      sessionKey: createHash("sha256").update(SESSION).digest("hex"), issuedAt: NOW / 1000, notBefore: NOW / 1000,
      deny: { commands: ["git push --force"], tools: [], paths: [] },
    });
    expect(call.parameters[7]).toBe(true);
    // The signature verifies on the key the API publishes for pinning.
    const { keys } = await (await target.app.request("/keys")).json() as { keys: Array<{ keyId: string; publicKey: string; current: boolean }> };
    expect(keys).toHaveLength(1);
    expect(keys[0]!.current).toBe(true);
    expect(verifyYoloLeaseSignature(payload, String(call.parameters[4]), String(call.parameters[5]), keys)).toEqual({ ok: true });

    expect(target.pushed.map((entry) => [entry.kind, entry.runtimeId])).toEqual([["revoke", RUNTIME], ["lease", RUNTIME]]);
    expect(target.pushed[0]!.frame).toEqual({ t: "yolo.revoke", leaseId: LEASE, revokedAt: NOW / 1000 });
    expect(target.pushed[1]!.frame).toMatchObject({ t: "yolo.lease", keyId: keys[0]!.keyId, lease: payload });
  });

  test("a link that cannot take the push does not fail the grant", async () => {
    const response = await grant(mount({}, base, { failPush: true }), { scope: "runtime" });
    expect(response.status).toBe(201);
  });

  test("a malformed body is refused before the database", async () => {
    for (const body of [
      { scope: "everything" },
      { scope: "bot" },
      { scope: "runtime", botId: BOT },
      { scope: "thread", botId: BOT },
      { scope: "bot", botId: BOT, durationMinutes: 1441 },
      { scope: "bot", botId: BOT, durationMinutes: 0 },
      { scope: "bot", botId: "not-a-uuid" },
    ]) {
      const target = mount({}, base);
      const response = await grant(target, body);
      expect(response.status).toBe(400);
      expect(granted(target.calls)).toBe(false);
    }
  });

  test("a chosen duration is honored up to 24 h", async () => {
    const target = mount({}, { ...base, role: "admin" });
    const response = await grant(target, { scope: "bot", botId: BOT, durationMinutes: 1440 });
    const { lease } = await response.json() as { lease: { issuedAt: string; expiresAt: string } };
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt)).toBe(24 * 3600 * 1000);
  });
});

describe("revocation and the kill switch", () => {
  test("a member can neither revoke nor kill", async () => {
    const target = mount({}, { ...base, role: "member" });
    expect((await target.app.request(`/leases/${LEASE}`, { method: "DELETE" })).status).toBe(403);
    expect((await target.app.request("/kill", { method: "POST" })).status).toBe(403);
    expect(target.calls.some((call) => call.sql.includes("revoke_permission_yolo_leases"))).toBe(false);
  });

  test("an unknown lease is 404", async () => {
    expect((await mount({}, base).app.request(`/leases/${LEASE}`, { method: "DELETE" })).status).toBe(404);
    expect((await mount({}, base).app.request("/leases/nope", { method: "DELETE" })).status).toBe(404);
  });

  test("an owner revokes a lease and the host is told", async () => {
    const target = mount({}, base);
    const { lease } = await (await grant(target, { scope: "runtime" })).json() as { lease: { id: string } };
    const response = await target.app.request(`/leases/${lease.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ lease: { id: lease.id, revokedAt: new Date(NOW).toISOString() } });
    expect(target.pushed.at(-1)).toEqual({ kind: "revoke", runtimeId: RUNTIME, frame: { t: "yolo.revoke", leaseId: lease.id, revokedAt: NOW / 1000 } });
    const call = target.calls.find((entry) => entry.sql.includes("revoke_permission_yolo_leases"))!;
    expect(call.parameters.slice(2)).toEqual([lease.id, "manual"]);
  });

  test("« Couper YOLO partout » revokes every lease and tells every live runtime", async () => {
    const target = mount({}, base);
    await grant(target, { scope: "runtime" });
    const response = await target.app.request("/kill", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 1, runtimes: 2 });
    const call = target.calls.find((entry) => entry.sql.includes("revoke_permission_yolo_leases"))!;
    expect(call.parameters.slice(2)).toEqual([null, "kill_switch"]);
    const kills = target.pushed.filter((entry) => entry.kind === "revoke" && entry.frame.all === true);
    expect(kills.map((entry) => entry.runtimeId).sort()).toEqual([RUNTIME, OTHER_RUNTIME].sort());
  });
});

describe("reads, consent and audit", () => {
  test("a member reads the live leases and the public keys", async () => {
    const target = mount({}, { ...base, role: "member" });
    const response = await target.app.request(`/leases?botId=${BOT}&threadId=${THREAD}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ leases: [] });
    expect((await target.app.request("/leases?botId=nope")).status).toBe(400);
    expect((await target.app.request("/keys")).status).toBe(200);
  });

  test("the audit is for owners and admins, paged, hashes only", async () => {
    expect((await mount({}, { ...base, role: "member" }).app.request("/audit")).status).toBe(403);
    const response = await mount({}, base).app.request(`/audit?leaseId=${LEASE}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      entries: [{
        id: "7", runtimeId: RUNTIME, leaseId: LEASE, writeSeq: 3, occurredAt: new Date(NOW).toISOString(), profile: "designer",
        gateKind: "plugin_tool", toolKey: "write_file", argsHash: "a".repeat(64), entryHash: "b".repeat(64),
      }],
      nextCursor: null,
    });
    expect((await mount({}, base).app.request("/audit?cursor=abc")).status).toBe(400);
  });

  test("consent: read by anyone, given explicitly, solo default for owners and admins only", async () => {
    expect(await (await mount({}, { ...base, role: "member" }).app.request("/consent")).json()).toEqual({ acknowledgedAt: null, soloDefault: false });
    const put = (auth: AuthContext, body: unknown) => mount({}, auth).app.request("/consent", { ...json(body), method: "PUT" });
    expect((await put({ ...base, role: "member" }, { acknowledged: true })).status).toBe(200);
    expect((await put({ ...base, role: "member" }, { acknowledged: true, soloDefault: true })).status).toBe(403);
    expect((await put(base, { acknowledged: false })).status).toBe(400);
    expect((await put({ ...base, kind: "bot" } as unknown as AuthContext,{ acknowledged: true })).status).toBe(403);
    expect(await (await put(base, { acknowledged: true, soloDefault: true })).json()).toEqual({ acknowledgedAt: new Date(NOW).toISOString(), soloDefault: true });
  });
});
