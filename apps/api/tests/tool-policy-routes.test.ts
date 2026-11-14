import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { HermesApprovalPolicyMode } from "@openedbot/hermes";
import type { BotRouteDeps } from "@openedbot/roster/application/bots";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import type { ApiConfig } from "../src/infrastructure/config";
import { botRoutes } from "../src/routes/roster/bot-routes";
import { HttpError } from "../src/interfaces/http/http-error";

const ORG = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const base: AuthContext = { sessionId: "s", organizationId: ORG, userId: "33333333-3333-4333-8333-333333333333", role: "owner", kind: "web", credentialHash: "c" };

type Stored = { toolKey: string; policy: string };

/**
 * A database that answers the tool policy use case by its SQL text, keeps
 * the rows in memory and records every statement with its values.
 */
function fakeDb(options: { pipeline?: string; stored?: Stored[]; managed?: boolean } = {}) {
  const rows = new Map((options.stored ?? []).map((row) => [row.toolKey, row.policy]));
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let tenant = "";
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql, values });
    if (sql.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: tenant }]);
    if (sql.includes("set_config('app.organization_id'")) { tenant = String(values[0]); return Promise.resolve([]); }
    if (sql.includes("from bots b join organizations o")) {
      return Promise.resolve([{ profile: "scout", profileManaged: options.managed ?? true, permissionMode: "auto", pipeline: options.pipeline ?? "v2", policyEffectiveAt: null }]);
    }
    if (sql.startsWith("select slug, hermes_profile")) return Promise.resolve([{ slug: "scout", profile: "scout" }]);
    if (sql.startsWith("delete from bot_permission_tool_policies")) { rows.delete(String(values[2])); return Promise.resolve([]); }
    if (sql.startsWith("insert into bot_permission_tool_policies")) { rows.set(String(values[2]), String(values[3])); return Promise.resolve([]); }
    if (sql.includes("count(*) filter")) {
      return Promise.resolve([{ stored: [...rows.values()].filter((p) => p !== "inherit").length, blocked: [...rows.values()].filter((p) => p === "block").length }]);
    }
    if (sql.includes("from bot_permission_tool_policies") && sql.includes("policy = 'block'")) {
      return Promise.resolve([...rows].filter(([, p]) => p === "block").map(([toolKey]) => ({ toolKey })).sort((a, b) => (a.toolKey < b.toolKey ? -1 : 1)));
    }
    if (sql.includes("from bot_permission_tool_policies")) {
      return Promise.resolve([...rows].map(([toolKey, policy]) => ({ toolKey, policy, updatedAt: "2026-10-24T00:00:00.000Z", updatedByKind: "member" })));
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  Object.assign(db, {
    begin: (run: (tx: SQL) => Promise<unknown>) => run(db),
    reserve: async () => Object.assign(db, { release: () => {}, close: async () => {} }),
  });
  return { db, rows, statements };
}

function host() {
  const writes: Array<readonly string[] | undefined> = [];
  let held: string[] = [];
  let mode: HermesApprovalPolicyMode = "ask_writes";
  const state = () => ({ mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: held });
  const deps: BotRouteDeps = {
    readRuntime: (async () => ({ client: {}, linkFeatures: ["approval_policy"] })) as unknown as BotRouteDeps["readRuntime"],
    clientFactory: (() => ({
      hostSetApprovalPolicy: async (_slug: string, next: HermesApprovalPolicyMode, blockedTools?: readonly string[]) => {
        writes.push(blockedTools);
        mode = next;
        if (blockedTools) held = [...blockedTools];
        return state();
      },
      hostApprovalPolicy: async () => state(),
    })) as unknown as BotRouteDeps["clientFactory"],
  };
  return { deps, writes };
}

function mount(db: SQL, auth: AuthContext, deps: BotRouteDeps = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", botRoutes(db, {} as ApiConfig, deps));
  return app;
}

const patch = (app: Hono<{ Variables: AppVariables }>, body: unknown) =>
  app.request(`/${BOT}/tool-policies`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("PERM2-5 tool policy routes", () => {
  test("role matrix: every member reads, only owner and admin write", async () => {
    for (const role of ["owner", "admin", "member"] as const) {
      const { db } = fakeDb({ stored: [{ toolKey: "patch", policy: "ask" }] });
      const auth = { ...base, role };
      const read = await mount(db, auth).request(`/${BOT}/tool-policies`);
      expect(read.status).toBe(200);
      const view = await read.json() as { writable: boolean; enforced: boolean; policies: unknown[] };
      expect(view.writable).toBe(role !== "member");
      expect(view.policies).toHaveLength(1);
      const write = await patch(mount(db, auth, host().deps), { policies: [{ toolKey: "write_file", policy: "always" }] });
      expect(write.status).toBe(role === "member" ? 403 : 200);
    }
  });

  test("a member is refused before any database write", async () => {
    const { db, statements } = fakeDb();
    const response = await patch(mount(db, { ...base, role: "member" }), { policies: [{ toolKey: "patch", policy: "block" }] });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("ROLE_REQUIRED");
    expect(statements).toEqual([]);
  });

  test("validation answers 400 before any database statement", async () => {
    const { db, statements } = fakeDb();
    const app = mount(db, base);
    expect((await patch(app, { policies: [{ toolKey: "read_file", policy: "block" }] })).status).toBe(400);
    expect((await patch(app, { policies: [{ toolKey: "patch", policy: "never" }] })).status).toBe(400);
    expect((await patch(app, { policies: [] })).status).toBe(400);
    expect(statements).toEqual([]);
  });

  test("the writer is recorded as a member actor, and no actor organization column is named", async () => {
    const { db, statements } = fakeDb();
    await patch(mount(db, { ...base, role: "admin" }, host().deps), { policies: [{ toolKey: "patch", policy: "ask" }] });
    const insert = statements.find((statement) => statement.sql.startsWith("insert into bot_permission_tool_policies"));
    expect(insert?.values).toEqual([ORG, BOT, "patch", "ask", base.userId]);
    expect(insert?.sql).toContain("updated_by_kind) values (?, ?, ?, ?, ?, 'member')");
    expect(insert?.sql).not.toMatch(/_by_[a-z]+_organization_id/);
  });

  test("a block reaches the host sorted, with the proof cleared then rewritten from the re-read", async () => {
    const { db, statements } = fakeDb({ stored: [{ toolKey: "write_file", policy: "block" }] });
    const h = host();
    const response = await patch(mount(db, base, h.deps), { policies: [{ toolKey: "mcp:files:delete", policy: "block" }] });
    expect(response.status).toBe(200);
    expect(h.writes).toEqual([["mcp:files:delete", "write_file"]]);
    const proofs = statements.filter((statement) => statement.sql.includes("approval_policy_effective_at = case"));
    expect(proofs.map((proof) => proof.values.slice(0, 2))).toEqual([[null, false], ["ask_writes", true]]);
  });

  test("a change that does not touch the blocked list writes nothing on the host", async () => {
    const { db } = fakeDb();
    const h = host();
    expect((await patch(mount(db, base, h.deps), { policies: [{ toolKey: "patch", policy: "always" }] })).status).toBe(200);
    expect(h.writes).toEqual([]);
  });

  test("a legacy organization keeps reading but refuses writes; the limits are enforced", async () => {
    const legacy = fakeDb({ pipeline: "legacy" });
    const refused = await patch(mount(legacy.db, base, host().deps), { policies: [{ toolKey: "patch", policy: "block" }] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("TOOL_POLICIES_REQUIRE_V2");

    const full = fakeDb({ stored: Array.from({ length: 64 }, (_, index) => ({ toolKey: `mcp:s:t${index}`, policy: "block" })) });
    const over = await patch(mount(full.db, base, host().deps), { policies: [{ toolKey: "patch", policy: "block" }] });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("TOOL_POLICIES_LIMIT");
  });
});
