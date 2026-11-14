import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { approvalRoutes } from "../src/routes/conversation/conversation-routes";
import { alwaysOffered, approvalGateView, routineGateContext, type AlwaysGateRow } from "../src/routes/conversation/approval-always";
import { botPermissionGrantRoutes } from "../src/routes/roster/bot-permission-grant-routes";
import { runtimePermissionRoutes } from "../src/routes/runtimes/runtime-permission-routes";

const ORG = "00000000-0000-4000-8000-000000000254";
const BOT = "00000000-0000-4000-8000-000000000301";
const GRANT = "00000000-0000-4000-8000-000000000401";
const RUNTIME = "00000000-0000-4000-8000-000000000501";

const owner: AuthContext = {
  sessionId: "s", organizationId: ORG, userId: "00000000-0000-4000-8000-000000000101", role: "owner", kind: "web", credentialHash: "h",
};
const admin: AuthContext = { ...owner, role: "admin" };
const member: AuthContext = { ...owner, role: "member" };

/** A permission write records the actor kind `member` and never names an actor organization column (dropped by a later migration). */
function expectMemberActor(sql: string, kindColumn: string): void {
  expect(sql).toContain(kindColumn);
  expect(sql).toContain("'member'");
  expect(sql).not.toMatch(/_by_[a-z]+_organization_id/);
}

const WRITE_ARGS = { tool: "write_file", deletes: "no", opaque: false, digest: "a".repeat(64), args: { path: "notes.md", size: 4 } };
const PLUGIN_GATE: AlwaysGateRow = {
  pipeline: "v2", decisionState: "awaiting_human", gateKind: "plugin_tool", toolKey: "write_file", gateArgs: WRITE_ARGS, choices: ["once", "deny"], effectiveMode: "auto",
};
const TERMINAL_GATE: AlwaysGateRow = {
  pipeline: "v2", decisionState: "awaiting_human", gateKind: "terminal_danger", toolKey: null, gateArgs: { command: "git push --force" }, choices: ["once", "deny"], effectiveMode: "auto",
};

function mount(router: Hono<{ Variables: AppVariables }>, auth: AuthContext): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) =>
    error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED", message: (error as Error).message } }, 500),
  );
  app.route("/", router);
  return app;
}

type Call = { sql: string; values: unknown[] };

/** A transaction that answers the respond route's reads for one pending gate. */
function respondDb(gate: AlwaysGateRow, options: { failGrant?: boolean; runtime?: string | null } = {}) {
  const calls: Call[] = [];
  let committed = false;
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.includes("select approval.run_id")) return Promise.resolve([{ runId: "run-1", workflowId: null }]);
    if (sql.includes("select status, hermes_run_id as \"hermesRunId\" from runs")) return Promise.resolve([{ status: "awaiting_approval" }]);
    if (sql.includes('select id, thread_id as "threadId"')) {
      return Promise.resolve([{ id: "approval-1", threadId: "thread-1", runId: "run-1", expiresAt: new Date(Date.now() + 60_000), ...gate }]);
    }
    if (sql.includes('as "botName"') && sql.includes("from approval_requests")) {
      return Promise.resolve([{ botId: BOT, botName: "Atlas", action: "" }]);
    }
    if (sql.includes("from routines")) return Promise.resolve([{ id: "00000000-0000-4000-8000-000000000601", botId: BOT, name: "Point hebdo", neverWait: true }]);
    if (sql.includes("insert into bot_permission_grants")) {
      return options.failGrant ? Promise.reject(new Error("duplicate key value violates unique constraint")) : Promise.resolve([{ id: GRANT }]);
    }
    if (sql.includes("from runtimes") && sql.includes("is_active")) {
      return Promise.resolve(options.runtime === null ? [] : [{ id: options.runtime ?? RUNTIME }]);
    }
    if (sql.includes("from runtimes")) return Promise.resolve([{ id: RUNTIME }]);
    if (sql.includes("insert into runtime_permission_settings")) return Promise.resolve([{ id: RUNTIME, changed: true }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { array(values: unknown[]): unknown[] }).array = (values) => values;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => {
    const value = await callback(tx);
    committed = true;
    return value;
  };
  return { tx, calls, committed: () => committed };
}

async function respond(app: Hono<{ Variables: AppVariables }>, choice: string) {
  return app.request("/approval-1/respond", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }),
  });
}

const approvalUpdate = (calls: Call[]) => calls.find((call) => call.sql.startsWith("update approval_requests set status ="));
const journalEnvelope = (calls: Call[]) => calls.find((call) => call.sql.includes("insert into decisions"))?.values
  .find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;

describe("alwaysOffered", () => {
  test("a member owner or admin is offered the grant on a grantable plugin gate and the switch on a terminal gate", () => {
    expect(alwaysOffered(PLUGIN_GATE, owner)).toBe("always_bot_tool");
    expect(alwaysOffered(PLUGIN_GATE, admin)).toBe("always_bot_tool");
    expect(alwaysOffered(TERMINAL_GATE, owner)).toBe("always_runtime_terminal");
  });

  test("never to a member, never outside a v2 gate waiting for a human", () => {
    expect(alwaysOffered(PLUGIN_GATE, member)).toBeNull();
    expect(alwaysOffered({ ...PLUGIN_GATE, pipeline: "legacy" }, owner)).toBeNull();
    expect(alwaysOffered({ ...PLUGIN_GATE, decisionState: null }, owner)).toBeNull();
    // A manual bot's gate goes to a person before any grant: no Always.
    expect(alwaysOffered({ ...PLUGIN_GATE, effectiveMode: "manual" }, owner)).toBeNull();
    expect(alwaysOffered({ ...TERMINAL_GATE, effectiveMode: "manual" }, owner)).toBeNull();
    expect(alwaysOffered({ ...PLUGIN_GATE, effectiveMode: null }, owner)).toBeNull();
    expect(alwaysOffered({ ...PLUGIN_GATE, decisionState: "decided" }, owner)).toBeNull();
    expect(alwaysOffered({ ...PLUGIN_GATE, gateKind: "unknown", toolKey: null, gateArgs: null }, owner)).toBeNull();
    expect(alwaysOffered({ ...PLUGIN_GATE, gateArgs: { ...WRITE_ARGS, deletes: "yes" } }, owner)).toBeNull();
    expect(alwaysOffered({ ...TERMINAL_GATE, gateArgs: { command: "rm -rf build" } }, owner)).toBeNull();
  });
});

describe("POST /approvals/:id/respond with an Always", () => {
  test("a member is refused before any database access", async () => {
    const unused = (() => { throw new Error("database must not be called"); }) as unknown as SQL;
    const asMember = await respond(mount(approvalRoutes(unused), member), "always_bot_tool");
    expect(asMember.status).toBe(403);
    expect(await asMember.json()).toEqual({ error: { code: "ROLE_REQUIRED" } });
  });

  test("a plain deny records a member decider and no grant", async () => {
    const db = respondDb(PLUGIN_GATE);
    const response = await respond(mount(approvalRoutes(db.tx), admin), "deny");
    expect(response.status).toBe(202);
    expect(db.calls.some((call) => call.sql.includes("bot_permission_grants"))).toBe(false);
    expect(approvalUpdate(db.calls)!.sql).toContain("decided_by_kind = case when decision_state is null then null else 'member' end");
  });

  test("owner and admin record the grant, and the gate leaves as once with the grant id", async () => {
    for (const actor of [owner, admin]) {
      const db = respondDb(PLUGIN_GATE);
      const response = await respond(mount(approvalRoutes(db.tx), actor), "always_bot_tool");
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ always: { choice: "always_bot_tool", saved: true } });
      const insert = db.calls.find((call) => call.sql.includes("insert into bot_permission_grants"))!;
      expect(insert.values).toEqual([ORG, BOT, "write_file", actor.userId, "approval-1"]);
      expectMemberActor(insert.sql, "created_by_kind");
      const update = approvalUpdate(db.calls)!;
      expect(update.values).toContain("once");
      expect(update.values).toContainEqual({ always: "always_bot_tool", grantId: GRANT });
      expect(db.calls.some((call) => call.sql === "release savepoint permission_always")).toBe(true);
      expect(journalEnvelope(db.calls)).toMatchObject({ choice: "once", grantId: GRANT });
    }
  });

  test("a grant that cannot be saved still answers once and says so", async () => {
    const db = respondDb(PLUGIN_GATE, { failGrant: true });
    const response = await respond(mount(approvalRoutes(db.tx), owner), "always_bot_tool");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ always: { choice: "always_bot_tool", saved: false, error: "PERMISSION_GRANT_FAILED" } });
    const savepoint = db.calls.findIndex((call) => call.sql === "savepoint permission_always");
    const rollback = db.calls.findIndex((call) => call.sql === "rollback to savepoint permission_always");
    const update = db.calls.findIndex((call) => call.sql.startsWith("update approval_requests set status ="));
    expect(savepoint).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(savepoint);
    expect(update).toBeGreaterThan(rollback);
    expect(db.calls[update]!.values).toContain("once");
    // The database message never reaches the gate's detail.
    expect(db.calls[update]!.values).toContainEqual({ always: "always_bot_tool", grantError: "PERMISSION_GRANT_FAILED" });
    expect(journalEnvelope(db.calls)).toMatchObject({ choice: "once" });
    expect(journalEnvelope(db.calls)).not.toHaveProperty("grantId");
    expect(db.committed()).toBe(true);
  });

  test("an Always no longer offered at click time is refused and decides nothing", async () => {
    for (const gate of [
      { ...PLUGIN_GATE, gateArgs: { ...WRITE_ARGS, deletes: "yes" } },
      { ...PLUGIN_GATE, pipeline: "legacy" },
      TERMINAL_GATE,
    ]) {
      const db = respondDb(gate);
      const response = await respond(mount(approvalRoutes(db.tx), owner), "always_bot_tool");
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "APPROVAL_ALWAYS_UNAVAILABLE" } });
      expect(approvalUpdate(db.calls)).toBeUndefined();
      expect(db.calls.some((call) => call.sql.includes("insert into decisions"))).toBe(false);
      expect(db.committed()).toBe(false);
    }
  });

  test("the terminal Always turns the runtime switch on and the gate leaves as once", async () => {
    const db = respondDb(TERMINAL_GATE);
    const response = await respond(mount(approvalRoutes(db.tx), owner), "always_runtime_terminal");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ always: { choice: "always_runtime_terminal", saved: true } });
    const upsert = db.calls.find((call) => call.sql.includes("insert into runtime_permission_settings"))!;
    expect(upsert.values.slice(0, 3)).toEqual([RUNTIME, ORG, true]);
    expect(approvalUpdate(db.calls)!.values).toContainEqual({ always: "always_runtime_terminal", runtimeSettingId: RUNTIME });
    expect(journalEnvelope(db.calls)).toMatchObject({ choice: "once", runtimeSettingId: RUNTIME });
  });

  test("no active runtime: the switch is not saved, the gate is still answered once", async () => {
    const db = respondDb(TERMINAL_GATE, { runtime: null });
    const response = await respond(mount(approvalRoutes(db.tx), owner), "always_runtime_terminal");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ always: { saved: false, error: "RUNTIME_NOT_FOUND" } });
    expect(approvalUpdate(db.calls)!.values).toContain("once");
  });

  test("a plain once carries no Always and opens no savepoint", async () => {
    const db = respondDb(PLUGIN_GATE);
    const response = await respond(mount(approvalRoutes(db.tx), owner), "once");
    expect(response.status).toBe(202);
    expect(await response.json()).not.toHaveProperty("always");
    expect(db.calls.some((call) => call.sql.includes("savepoint"))).toBe(false);
  });
});

/** A database that answers the grant and runtime routes. */
function settingsDb(rows: { bot?: boolean; revoked?: boolean; runtime?: boolean; stored?: boolean } = {}) {
  const calls: Call[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.startsWith("select id from bots")) return Promise.resolve(rows.bot === false ? [] : [{ id: BOT }]);
    if (sql.includes("update bot_permission_grants")) return Promise.resolve(rows.revoked === false ? [] : [{ id: GRANT }]);
    if (sql.includes("from bot_permission_grants g")) {
      return Promise.resolve([{
        id: GRANT, toolKey: "write_file", createdAt: new Date("2026-10-24T10:00:00Z"), createdByKind: "member",
        createdByName: "Camille Lefèvre", createdFromApprovalId: "approval-1", createdFromThreadId: "thread-1",
      }]);
    }
    if (sql.startsWith("select id from runtimes")) return Promise.resolve(rows.runtime === false ? [] : [{ id: RUNTIME }]);
    if (sql.includes("insert into runtime_permission_settings")) return Promise.resolve([{ id: RUNTIME, changed: true }]);
    if (sql.includes("left join runtime_permission_settings")) {
      return Promise.resolve(rows.runtime === false ? [] : [{
        runtimeId: RUNTIME, terminalDangerAlways: rows.stored ?? true, updatedAt: new Date("2026-10-24T11:00:00Z"),
        updatedByKind: "member", updatedByName: "Camille Lefèvre",
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
  return { tx, calls };
}

describe("bot permission grants routes", () => {
  test("lists the bot's active grants", async () => {
    const db = settingsDb();
    const response = await mount(botPermissionGrantRoutes(db.tx), owner).request(`/${BOT}/permission-grants`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      id: GRANT, toolKey: "write_file", createdAt: "2026-10-24T10:00:00.000Z", createdByKind: "member",
      createdByName: "Camille Lefèvre", createdFromApprovalId: "approval-1", createdFromThreadId: "thread-1",
    }]);
  });

  test("an admin revokes, and the revocation records a member actor", async () => {
    const db = settingsDb();
    const response = await mount(botPermissionGrantRoutes(db.tx), admin).request(`/${BOT}/permission-grants/${GRANT}/revoke`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Plus utile" }),
    });
    expect(response.status).toBe(204);
    const update = db.calls.find((call) => call.sql.includes("update bot_permission_grants"))!;
    expect(update.values).toEqual([admin.userId, "Plus utile", ORG, BOT, GRANT]);
    expectMemberActor(update.sql, "revoked_by_kind");
  });

  test("a grant already revoked is 404, an unknown bot too", async () => {
    const revoked = await mount(botPermissionGrantRoutes(settingsDb({ revoked: false }).tx), owner)
      .request(`/${BOT}/permission-grants/${GRANT}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toEqual({ error: { code: "PERMISSION_GRANT_NOT_FOUND" } });
    const missing = await mount(botPermissionGrantRoutes(settingsDb({ bot: false }).tx), owner).request(`/${BOT}/permission-grants`);
    expect(missing.status).toBe(404);
  });

  test("ids and reasons are validated before any write", async () => {
    const db = settingsDb();
    const app = mount(botPermissionGrantRoutes(db.tx), owner);
    expect((await app.request("/not-a-uuid/permission-grants")).status).toBe(400);
    const long = await app.request(`/${BOT}/permission-grants/${GRANT}/revoke`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "x".repeat(201) }),
    });
    expect(long.status).toBe(400);
    expect(db.calls.some((call) => call.sql.includes("update bot_permission_grants"))).toBe(false);
  });
});

describe("runtime permission settings routes", () => {
  test("an admin turns the switch on as a member actor; the answer is the row read back", async () => {
    const db = settingsDb({ stored: true });
    const response = await mount(runtimePermissionRoutes(db.tx), admin).request(`/${RUNTIME}/permission-settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminalDangerAlways: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runtimeId: RUNTIME, terminalDangerAlways: true, updatedAt: "2026-10-24T11:00:00.000Z", updatedByKind: "member", updatedByName: "Camille Lefèvre",
    });
    const upsert = db.calls.find((call) => call.sql.includes("insert into runtime_permission_settings"))!;
    expect(upsert.values).toEqual([RUNTIME, ORG, true, admin.userId]);
    expectMemberActor(upsert.sql, "updated_by_kind");
  });

  test("a read-back that disagrees is a refusal, never a success", async () => {
    const response = await mount(runtimePermissionRoutes(settingsDb({ stored: false }).tx), owner).request(`/${RUNTIME}/permission-settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminalDangerAlways: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "RUNTIME_PERMISSION_SETTINGS_NOT_SAVED" } });
  });

  test("another organization's runtime is 404, a non-boolean value 400", async () => {
    const foreign = await mount(runtimePermissionRoutes(settingsDb({ runtime: false }).tx), owner).request(`/${RUNTIME}/permission-settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminalDangerAlways: false }),
    });
    expect(foreign.status).toBe(404);
    const invalid = await mount(runtimePermissionRoutes(settingsDb().tx), owner).request(`/${RUNTIME}/permission-settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminalDangerAlways: "yes" }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe("approvalGateView", () => {
  test("a proven plugin gate exposes its tool key and bounded args, never the digest", () => {
    expect(approvalGateView(PLUGIN_GATE)).toEqual({ toolKey: "write_file", gateArgs: { path: "notes.md", size: 4 } });
  });

  test("MCP free-form arguments stay on the server", () => {
    const mcp = { ...PLUGIN_GATE, toolKey: "mcp:srv:tool", gateArgs: { ...WRITE_ARGS, args: { server: "srv", tool: "tool", arguments: { note: "x" } } } };
    expect(approvalGateView(mcp)).toEqual({ toolKey: "mcp:srv:tool", gateArgs: { server: "srv", tool: "tool" } });
  });

  const ROUTINE_ID = "00000000-0000-4000-8000-000000000601";
  const routineGate = (args: Record<string, unknown> | undefined) => ({
    ...PLUGIN_GATE, botId: BOT, toolKey: "mcp:openedbot_routines:routine_manage",
    gateArgs: { ...WRITE_ARGS, tool: "mcp:openedbot_routines:routine_manage", deletes: "unknown",
      args: { server: "openedbot_routines", tool: "routine_manage", ...(args ? { arguments: args } : {}) } },
  });
  const context = (locale: "fr" | "en") => ({ targets: new Map([[`${BOT}:${ROUTINE_ID}`, { name: "Point hebdo", neverWait: false }]]), locale, now: new Date("2026-11-12T10:00:00Z") });

  test("a routine_manage gate: its detail is the platform's sentence in the reader's language, with the structured call", () => {
    const create = routineGate({ action: "create", name: "Point hebdo", prompt: "p", schedule: "every monday at 9am", timezone: "Europe/Paris" });
    expect(approvalGateView(create, context("fr"))).toEqual({
      toolKey: "mcp:openedbot_routines:routine_manage",
      gateArgs: { server: "openedbot_routines", tool: "routine_manage" },
      routine: { action: "create", name: "Point hebdo", schedule: { kind: "recurring", cron: "0 9 * * 1" }, timezone: "Europe/Paris", prompt: { excerpt: "p", chars: 1 }, issue: null },
      detail: "Créer la routine « Point hebdo » : Chaque lundi à 9:00 (fuseau Europe/Paris). Message envoyé au bot à chaque passage : « p » (1 caractères). Active dès sa création, en « Ne jamais attendre » : elle s’exécute sans demander d’autorisation.",
    });
    expect(approvalGateView(routineGate({ action: "remove", job_id: ROUTINE_ID.toUpperCase() }), context("en")).detail)
      .toBe("Delete the routine “Point hebdo” and its history.");
    // The host sent no arguments (too long, older host): said, not guessed.
    expect(approvalGateView(routineGate(undefined), context("en"))).toMatchObject({ routine: null, detail: expect.stringContaining("could not be read") });
  });

  test("the request's language picks the sentence's; anything but English reads French", async () => {
    const tx = (() => Promise.resolve([])) as never;
    expect((await routineGateContext(tx, ORG, [], "en-US,en;q=0.9")).locale).toBe("en");
    for (const header of [undefined, "fr-FR", "de"]) expect((await routineGateContext(tx, ORG, [], header)).locale).toBe("fr");
  });

  test("the decisions journal keeps, for a routine_manage gate, the sentence its decider read", async () => {
    const gate = { ...routineGate({ action: "pause", job_id: ROUTINE_ID }), effectiveMode: "manual" } as AlwaysGateRow;
    const db = respondDb(gate);
    const app = mount(approvalRoutes(db.tx), owner);
    const response = await app.request("/approval-1/respond", {
      method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": "fr" }, body: JSON.stringify({ choice: "once" }),
    });
    expect(response.status).toBe(202);
    expect(journalEnvelope(db.calls)?.action).toBe("Mettre en pause la routine « Point hebdo ».");
  });

  test("terminal and unidentified gates expose nothing", () => {
    expect(approvalGateView(TERMINAL_GATE)).toEqual({ toolKey: null, gateArgs: null });
    expect(approvalGateView({ ...PLUGIN_GATE, gateKind: "unknown", toolKey: null, gateArgs: null })).toEqual({ toolKey: null, gateArgs: null });
  });
});
