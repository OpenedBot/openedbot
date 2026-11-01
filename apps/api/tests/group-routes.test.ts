import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { groupRoutes } from "../src/routes/roster/group-routes";
import { readGroupDefaultResponder } from "@openedbot/roster/domain/groups";
import { readGroups } from "@openedbot/roster/sql/groups";
import { HttpError } from "../src/interfaces/http/http-error";

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

describe("group deletion while a run is active or uncertain", () => {
  for (const status of ["running", "unknown"] as const) {
    test(`refuses deletion for a ${status} run`, async () => {
      const calls: string[] = [];
      const response = await mount(deletionDb(calls, status)).request("/group-1", { method: "DELETE" });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "GROUP_BUSY" } });
      expect(calls.some((sql) => sql.includes("delete from bot_groups"))).toBe(false);
      const activeCheck = calls.find((sql) => sql.includes("select run.id from runs"));
      expect(activeCheck).toContain("'unknown'");
      expect(activeCheck).toContain("'relaying'");
      expect(activeCheck).toContain("order by run.id for update of run");
      expect(activeCheck).toContain("'memory'");
      expect(activeCheck).toContain("'compaction'");
    });
  }

  test("locks active runs deterministically before the group and thread, then deletes", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, "completed")).request("/group-1", { method: "DELETE" });

    expect(response.status).toBe(204);
    const groupLock = calls.findIndex((sql) => sql.includes("select g.id") && sql.includes("for update of g, t"));
    const activeCheck = calls.findIndex((sql) => sql.includes("select run.id from runs") && sql.includes("for update of run"));
    const ingressGuard = calls.findIndex((sql) => sql.includes("from message_ingress"));
    const deletion = calls.findIndex((sql) => sql.includes("delete from bot_groups"));
    expect(groupLock).toBeGreaterThanOrEqual(0);
    expect(activeCheck).toBeGreaterThanOrEqual(0);
    expect(activeCheck).toBeLessThan(groupLock);
    expect(groupLock).toBeLessThan(ingressGuard);
    expect(ingressGuard).toBeLessThan(deletion);
    expect(calls[ingressGuard]).toContain("'reserved','abandoned'");
  });

  test("accepte un salon dont le workflow est terminé", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, "completed")).request("/group-1", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(calls.some((sql) => sql.includes("delete from bot_groups"))).toBe(true);
    const activeCheck = calls.find((sql) => sql.includes("select run.id from runs"));
    expect(activeCheck).toContain("run.step_kind not in ('memory', 'compaction')");
  });

  test("rechecks after the group/thread lock so a concurrent FK insert cannot be deleted", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, "completed", true)).request("/group-1", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "GROUP_BUSY" } });
    const groupLock = calls.findIndex((sql) => sql.includes("select g.id") && sql.includes("for update of g, t"));
    const lateCheck = calls.findIndex((sql, index) => index > groupLock && sql.includes("select run.id from runs"));
    expect(lateCheck).toBeGreaterThan(groupLock);
    expect(calls[lateCheck]).not.toContain("for update");
    expect(calls.some((sql) => sql.includes("delete from bot_groups"))).toBe(false);
  });
});

describe("group membership while a run is active or uncertain", () => {
  test("locks active runs before the group and refuses a membership change before mutating it", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, "unknown")).request("/group-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["bot-1", "bot-2"] }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "GROUP_BUSY" } });
    const groupLock = calls.findIndex((sql) => sql.includes("select g.id") && sql.includes("for update of g, t"));
    const activeCheck = calls.findIndex((sql) => sql.includes("select run.id from runs") && sql.includes("for update of run"));
    expect(groupLock).toBeGreaterThanOrEqual(0);
    expect(activeCheck).toBeGreaterThanOrEqual(0);
    expect(activeCheck).toBeLessThan(groupLock);
    expect(calls[activeCheck]).toContain("'unknown'");
    expect(calls.some((sql) => sql.includes("delete from group_members"))).toBe(false);
  });

  test("refuse atomiquement de retirer le pilote sans nouvelle règle", async () => {
    const calls: string[] = [];
    const tx = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      calls.push(sql);
      if (sql.includes("select run.id from runs")) return Promise.resolve([]);
      if (sql.includes("select g.id") && sql.includes("for update of g, t")) {
        return Promise.resolve([{
          id: "group-1",
          threadId: "thread-1",
          defaultResponder: { kind: "member", botId: "bot-1" },
        }]);
      }
      if (sql.includes("select id from bots")) return Promise.resolve([{ id: "bot-2" }, { id: "bot-3" }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);

    const response = await mount(tx).request("/group-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["bot-2", "bot-3"] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "GROUP_RESPONDER_NOT_MEMBER" } });
    expect(calls.some((sql) => sql.includes("update bot_groups"))).toBe(false);
    expect(calls.some((sql) => sql.includes("delete from group_members"))).toBe(false);
  });

  test("verrouille les futurs membres contre un archivage concurrent", async () => {
    const calls: string[] = [];
    const tx = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      calls.push(sql);
      if (sql.includes("select run.id from runs")) return Promise.resolve([]);
      if (sql.includes("select g.id") && sql.includes("for update of g, t")) {
        return Promise.resolve([{
          id: "group-1", threadId: "thread-1", defaultResponder: { kind: "everyone" },
        }]);
      }
      if (sql.includes("select id from bots")) return Promise.resolve([{ id: "bot-1" }, { id: "bot-2" }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);

    await mount(tx).request("/group-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["bot-1", "bot-2"] }),
    });

    const botGuard = calls.find((sql) => sql.includes("select id from bots"));
    expect(botGuard).toContain("order by id for key share");
    expect(botGuard).toContain("archived_at is null");
  });
});

describe("group section move", () => {
  const VALID = "11111111-2222-4333-8444-555555555555";

  function sectionDb(calls: Array<{ sql: string; values: unknown[] }>, sectionExists: boolean): SQL {
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join("?");
      calls.push({ sql, values });
      if (sql.includes("select g.id") && sql.includes("for update of g, t")) {
        return Promise.resolve([{ id: "group-1", threadId: "thread-1", defaultResponder: { kind: "everyone" } }]);
      }
      if (sql.includes("select bot_id as id from group_members")) return Promise.resolve([{ id: "bot-1" }, { id: "bot-2" }]);
      if (sql.includes("select id from sections")) return Promise.resolve(sectionExists ? [{ id: VALID }] : []);
      if (sql.includes("coalesce(max(position), -1) + 1")) return Promise.resolve([{ next: 3 }]);
      if (sql.includes("update bot_groups set")) return Promise.resolve([{ id: "group-1" }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }

  const patch = (db: SQL, sectionId: string) => mount(db).request("/group-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sectionId }),
  });

  test("une section qui n'est pas un uuid est refusée avant toute écriture", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await patch(sectionDb(calls, true), "");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "SECTION_ID_INVALID" } });
    expect(calls.some((call) => call.sql.includes("update bot_groups"))).toBe(false);
  });

  test("une section inconnue répond 404, jamais une violation de clé", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await patch(sectionDb(calls, false), VALID);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "SECTION_NOT_FOUND" } });
    expect(calls.some((call) => call.sql.includes("update bot_groups"))).toBe(false);
  });

  test("le salon prend le rang suivant dans sa nouvelle section", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    await patch(sectionDb(calls, true), VALID);
    const update = calls.find((call) => call.sql.includes("update bot_groups set"));
    expect(update?.sql).toContain("position = coalesce(");
    expect(update?.values).toContain(3);
    expect(update?.values).toContain(VALID);
  });
});

describe("group default responder validation", () => {
  const memberIds = ["bot-1", "bot-2"];

  test("accepte les trois règles représentables", () => {
    expect(readGroupDefaultResponder({ kind: "everyone" }, memberIds)).toEqual({ kind: "everyone" });
    expect(readGroupDefaultResponder({ kind: "mentions" }, memberIds)).toEqual({ kind: "mentions" });
    expect(readGroupDefaultResponder({ kind: "member", botId: "bot-2" }, memberIds)).toEqual({
      kind: "member", botId: "bot-2",
    });
  });

  test("refuse un pilote hors roster et les champs supplémentaires", () => {
    expect(() => readGroupDefaultResponder({ kind: "member", botId: "bot-3" }, memberIds)).toThrow(HttpError);
    expect(() => readGroupDefaultResponder({ kind: "everyone", botId: "bot-1" }, memberIds)).toThrow(HttpError);
    try {
      readGroupDefaultResponder({ kind: "member", botId: "bot-3" }, memberIds);
    } catch (error) {
      expect((error as HttpError).code).toBe("GROUP_RESPONDER_NOT_MEMBER");
    }
  });

  test("le schéma borne la forme persistée du répondeur par défaut", async () => {
    const sql = await Bun.file(new URL("../../../db/migrations/0003_roster.sql", import.meta.url)).text();
    expect(sql).toContain("default_responder jsonb not null default '{\"kind\":\"everyone\"}'::jsonb");
    expect(sql).toContain("bot_groups_default_responder_shape");
    expect(sql).toContain("jsonb_build_object");
  });
});

describe("group voice roster", () => {
  test("expose la voix propre à chaque bot du groupe", async () => {
    const calls: string[] = [];
    const tx = ((strings: TemplateStringsArray | unknown[]) => {
      if (!("raw" in strings)) return strings;
      const sql = [...strings].join(" ");
      calls.push(sql);
      if (sql.includes("from bot_groups g join threads")) {
        return Promise.resolve([{
          id: "group-1",
          name: "QA",
          instructions: "",
          defaultResponder: { kind: "everyone" },
          threadId: "thread-1",
          sectionId: "section-1",
          position: 0,
          pinned: false,
          needsYou: false,
          awaitingApproval: false,
          unread: false,
          hidden: false,
          running: false,
          preview: null,
          lastActivityAt: "2026-08-26T10:00:00.000Z",
          createdAt: "2026-08-26T10:00:00.000Z",
          updatedAt: "2026-08-26T10:00:00.000Z",
        }]);
      }
      if (sql.includes("from group_members gm")) {
        return Promise.resolve([{
          groupId: "group-1",
          id: "bot-1",
          name: "Scout",
          slug: "scout",
          face: null,
          voiceId: "elevenlabs:scout",
          archivedAt: null,
          position: 0,
        }]);
      }
      return Promise.resolve([]);
    }) as unknown as Bun.TransactionSQL;

    const groups = await readGroups(tx, "org-1", "group-1", "user-1");

    expect(groups[0]?.members[0]?.voiceId).toBe("elevenlabs:scout");
    expect(calls.find((sql) => sql.includes("from group_members gm"))).toContain('b.voice_id as "voiceId"');
  });
});

function mount(db: SQL): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", owner);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", groupRoutes(db));
  return app;
}

function deletionDb(calls: string[], runStatus: string, lateActive = false): SQL {
  let activeChecks = 0;
  const tx = ((strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ");
    calls.push(sql);
    if (sql.includes("select g.id")) return Promise.resolve([{ id: "group-1", threadId: "thread-1" }]);
    if (sql.includes("select run.id from runs")) {
      activeChecks += 1;
      return Promise.resolve(
        (lateActive ? activeChecks > 1 : sql.includes(`'${runStatus}'`)) ? [{ id: "run-1" }] : [],
      );
    }
    if (sql.includes("delete from bot_groups")) return Promise.resolve([{ id: "group-1" }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}
