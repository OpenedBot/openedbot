import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import type { ApiConfig } from "../src/infrastructure/config";
import { personaDraftSessionKey } from "@openedbot/roster/domain/persona-draft";
import { HermesClientError } from "@openedbot/hermes";
import { botRoutes } from "../src/routes/roster/bot-routes";
import type { BotRouteDeps } from "@openedbot/roster/application/bots";
import type { BotRow } from "@openedbot/roster/domain/bot-dto";
import { HttpError } from "../src/interfaces/http/http-error";

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

function mount(db: SQL, auth: AuthContext = owner, deps: BotRouteDeps = {}): Hono<{ Variables: AppVariables }> {
  Object.assign(db, { reserve: async () => Object.assign(db, { release: () => {}, close: async () => {} }) });
  if (!("array" in db)) Object.assign(db, { array: (values: unknown[]) => values });
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({
      error: { code: error.code, ...(error.details ? { details: error.details } : {}) },
    }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", botRoutes(db, {} as ApiConfig, deps));
  return app;
}

/**
 * Une ligne de bot telle que `readBotRows` la rend : le minimum pour que
 * `publicBot` sérialise sans exploser. Le soft delete répond avec le bot mis
 * à jour, il faut donc que la lecture qui suit l'`update` renvoie quelque
 * chose.
 */
const storedBotRow = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Scout",
  slug: "scout",
  description: null,
  instructions: "",
  model: null,
  reasoningEffort: null,
  sectionId: "section-1",
  position: 0,
  pinned: false,
  face: null,
  voiceId: null,
  label: null,
  replyLanguage: "auto",
  notifyOnFinish: true,
  speechRate: "1.00",
  permissionMode: "manual",
  hermesProfile: "scout",
  archivedAt: "2026-09-03T00:00:00.000Z",
  deletedAt: "2026-09-03T00:00:00.000Z",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  awaitingApproval: false,
  preview: null,
  lastActivityAt: "2026-09-03T00:00:00.000Z",
  lastRunAt: null,
  autonomyEnabled: true,
  autonomyMaxDepth: 3,
  autonomyMaxSteps: 8,
  autonomyMaxHandoffs: 4,
  autonomyTimeoutSeconds: 1_800,
  autonomyTokenBudget: 120_000,
} satisfies BotRow;

function deletionDb(calls: string[], active: boolean | "late" | "memory", inGroup = false, profileManaged = false, cleanupStatus: string | null = null, cleanupDeletedAt = "2026-09-01T00:00:00.000Z", preparing = false): SQL {
  let activeChecks = 0;
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    calls.push(sql);
    if (preparing && sql.includes("from bot_profile_provisions") && sql.includes("'queued', 'running'")) {
      return Promise.resolve([{ status: "running" }]);
    }
    if (inGroup && sql.includes("delete from group_members")) return Promise.resolve([{ groupId: "group-1" }]);
    if (sql.includes("select id from bots")) return Promise.resolve([{ id: "bot-1" }]);
    if (sql.includes("from runs r")) {
      activeChecks += 1;
      if (active === "memory") {
        if (sql.includes("for update of r")) {
          return Promise.resolve([{ id: "run-memory", stepKind: "memory", threadId: "thread-1" }]);
        }
        return Promise.resolve([]);
      }
      const busy = active === true || (active === "late" && activeChecks > 1);
      return Promise.resolve(busy ? [{ id: "run-1", stepKind: "root", threadId: "thread-1" }] : []);
    }
    if (sql.includes("from group_members membership")) {
      return Promise.resolve(inGroup ? [{ groupId: "group-1" }] : []);
    }
    if (sql.includes("from bot_host_cleanups") && sql.includes("for update")) {
      return Promise.resolve(cleanupStatus ? [{ id: "cleanup-1", status: cleanupStatus, live: cleanupStatus === "running" }] : []);
    }
    if (sql.includes("select status from bot_host_cleanups")) {
      const requestedAt = values.find((value) => value instanceof Date)?.toISOString();
      const matchesDeletion = !sql.includes("bot_deleted_at") || requestedAt === cleanupDeletedAt;
      return Promise.resolve(cleanupStatus && matchesDeletion ? [{ status: cleanupStatus }] : []);
    }
    if (sql.includes("delete from bots")) return Promise.resolve([{ id: "bot-1" }]);
    if (sql.includes("update bots") && sql.includes("archived_at")) return Promise.resolve([{ deletedAt: new Date("2026-10-01T00:00:00Z") }]);
    if (sql.includes("update bots")) return Promise.resolve([{ id: "bot-1" }]);
    if (sql.includes('t.id as "threadId"')) return Promise.resolve([storedBotRow]);
    if (sql.includes('hermes_profile as "hermesProfile"') && sql.includes("hermesProfileManaged")) {
      return Promise.resolve([{ name: "Scout", hermesProfile: "scout", hermesProfileManaged: profileManaged }]);
    }
    if (sql.includes('hermes_profile as "profile"')) {
      return Promise.resolve([{ deletedAt: new Date("2026-09-01T00:00:00Z"), profile: "scout", profileManaged }]);
    }
    if (sql.includes('hermes_session_id as "sessionId"')) {
      return Promise.resolve([{ sessionId: "openedbot:org-1:thread-1", threadId: "thread-1" }]);
    }
    if (sql.includes('workflow_id as "workflowId"')) {
      return Promise.resolve([{ workflowId: "workflow-1" }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

function patchSectionDb(calls: string[], sectionId: string | null): SQL {
  const tx = ((strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ");
    calls.push(sql);
    if (sql.includes("select id from sections")) {
      return Promise.resolve(sectionId ? [{ id: sectionId }] : []);
    }
    if (sql.includes("coalesce(greatest(")) return Promise.resolve([{ next: 4 }]);
    if (sql.includes("update bots set")) return Promise.resolve([{ id: "bot-1" }]);
    if (sql.includes('t.id as "threadId"')) {
      return Promise.resolve([{ ...storedBotRow, sectionId: sectionId ?? storedBotRow.sectionId, position: 4, archivedAt: null, deletedAt: null }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

describe("bot deletion while work is active", () => {
  test("refuses deletion so a handoff courier cannot be orphaned", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, true)).request("/bot-1", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_BUSY" } });
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(false);
  });

  test("locks active runs deterministically before the bot, then deletes", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls)).request("/bot-1?purge=1&force=1", { method: "DELETE" });
    expect(response.status).toBe(200);
    const botLock = calls.findIndex((sql) => sql.includes("select id from bots") && sql.includes("for update"));
    const activeLock = calls.findIndex((sql) => sql.includes("from runs r") && sql.includes("for update of r"));
    const ingressGuard = calls.findIndex((sql) => sql.includes("from message_ingress ingress"));
    const deletion = calls.findIndex((sql) => sql.includes("delete from bots"));
    expect(botLock).toBeGreaterThanOrEqual(0);
    expect(activeLock).toBeGreaterThanOrEqual(0);
    expect(activeLock).toBeLessThan(botLock);
    expect(botLock).toBeLessThan(ingressGuard);
    expect(ingressGuard).toBeLessThan(deletion);
    expect(calls[activeLock]).toContain("order by r.id");
    expect(calls[activeLock]).toContain("r.caller_bot_id");
    expect(calls[activeLock]).toContain("r.handoff_target_bot_id");
    expect(calls[activeLock]).toContain("t.bot_id");
    expect(calls[activeLock]).toContain("group_members");
    expect(calls[ingressGuard]).toContain("thread.bot_id");
    expect(calls[ingressGuard]).toContain("'reserved','abandoned'");
  });

  test("rechecks after the bot lock so a concurrent FK insert cannot be deleted", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, "late")).request("/bot-1", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_BUSY" } });
    const botLock = calls.findIndex((sql) => sql.includes("select id from bots") && sql.includes("for update"));
    const lateCheck = calls.findIndex((sql, index) => index > botLock && sql.includes("from runs r"));
    expect(lateCheck).toBeGreaterThan(botLock);
    expect(calls[lateCheck]).not.toContain("for update");
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(false);
  });
});

/**
 * Les suppressions de sessions et profils sont confiées au worker durable.
 */
function deleteRuntimeDeps(calls: string[], profileNames: string[] = ["scout"], failDelete = false): BotRouteDeps {
  const present = new Set(profileNames);
  const emptyProfile = (name: string) => ({
    name,
    displayName: name,
    title: null,
    description: null,
    soul: null,
    model: { default: null, provider: null },
    uiMeta: null,
    hasAvatar: false,
    routines: [],
    skills: [],
    toolsets: [],
    mcpServers: [],
  });
  const client = {
    hostProfileInventory: async () => { calls.push("inventory"); return { profiles: [...present].map(emptyProfile) }; },
    hostDeleteProfile: async (profile: string) => {
      if (failDelete) throw new HermesClientError("l'hôte a refusé", 502, "HERMES_UNREACHABLE");
      calls.push(`delete-profile:${profile}`);
      present.delete(profile);
    },
    hostCreateProfile: async (name: string) => {
      calls.push(`create-profile:${name}`);
      present.add(name);
      return emptyProfile(name);
    },
    probeProfileIsolation: async () => "isolated" as const,
    deleteSession: async (session: string) => { calls.push(`delete-session:${session}`); },
  };
  return {
    readRuntime: (async () => ({
      id: "runtime-1",
      name: "Hermes",
      capacity: 4,
      linkFeatures: ["profile_management"],
      client: {} as never,
      selectedProvider: "anthropic",
      selectedModel: "claude-sonnet-4",
      reasoningEffort: null,
    })) as BotRouteDeps["readRuntime"],
    readRuntimeForDeletion: (async () => ({ id: "runtime-1", linkFeatures: ["profile_management"] })) as BotRouteDeps["readRuntimeForDeletion"],
    clientFactory: () => client as never,
  };
}

describe("suppression d'un bot en deux temps", () => {
  test("un runtime enregistré mais hors ligne ne bloque pas la corbeille", async () => {
    const calls: string[] = [];
    const deps = deleteRuntimeDeps(calls, ["scout"]);
    deps.readRuntime = (async () => { throw new Error("reachability accessor must not run on deletion"); }) as BotRouteDeps["readRuntime"];
    const response = await mount(deletionDb(calls, false, false, true), owner, deps).request("/bot-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect((await response.json()).hostCleanupStatus).toBe("pending");
    expect(calls.some((sql) => sql.includes("insert into bot_host_cleanups"))).toBe(true);
    expect(calls.some((call) => call === "inventory" || call.startsWith("delete-profile:") || call.startsWith("delete-session:"))).toBe(false);
  });

  test("le DELETE nu met à la corbeille et programme le nettoyage sans appel hôte", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls)).request("/bot-1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "bot-1", deletedAt: expect.any(String) });
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(false);
    const update = calls.find((sql) => sql.includes("deleted_at = coalesce(deleted_at, now())"))!;
    expect(update).toContain("deleted_at = coalesce(deleted_at, now())");
    // L'invariant de 0031 : supprimé ⇒ archivé. C'est lui qui retire le bot
    // des ~25 requêtes qui filtrent déjà `archived_at is null`.
    expect(update).toContain("archived_at = coalesce(archived_at, now())");
    expect(calls.some((sql) => sql.includes("insert into bot_host_cleanups"))).toBe(true);
    expect(calls.some((call) => call.startsWith("delete-profile:") || call.startsWith("delete-session:"))).toBe(false);
  });

  test("un profil déjà absent sur l'hôte n'empêche pas la corbeille", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls, [])).request("/bot-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(calls.some((sql) => sql.includes("deleted_at = coalesce(deleted_at, now())"))).toBe(true);
    expect(calls.some((call) => call === "delete-profile:scout")).toBe(false);
  });

  test("un hôte indisponible ne bloque pas la corbeille ni la programmation du nettoyage", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls, ["scout"], true)).request("/bot-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hostCleanupStatus: "pending" });
    expect(calls.some((sql) => sql.includes("insert into bot_host_cleanups"))).toBe(true);
    expect(calls.some((call) => call.startsWith("delete-profile:") || call.startsWith("delete-session:"))).toBe(false);
  });

  test("le soft delete garde les mêmes gardes que la suppression définitive", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, true)).request("/bot-1", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_BUSY" } });
    expect(calls.some((sql) => sql.includes("update bots"))).toBe(false);
  });

  test("la purge lit les sessions du bot AVANT d'effacer la ligne", async () => {
    const calls: string[] = [];
    await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls)).request("/bot-1?purge=1&force=1", { method: "DELETE" });

    const read = calls.findIndex((sql) => sql.includes('hermes_session_id as "sessionId"'));
    const deletion = calls.findIndex((sql) => sql.includes("delete from bots"));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(read);
    // Le profil vient du bot : une session créée sous `/p/<slug>` ne
    // s'efface que sous ce même préfixe.
    expect(calls.some((sql) => sql.includes('hermes_profile as "profile"'))).toBe(true);
    // Un workflow autonome ouvre une session que `threads` ne nomme pas.
    expect(calls.some((sql) => sql.includes('workflow_id as "workflowId"'))).toBe(true);
  });

  test("la purge programme le nettoyage sans appeler l'hôte", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls, ["scout"], true)).request("/bot-1?purge=1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "bot-1", hostCleanup: "queued" });
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(true);
    expect(calls.some((call) => call.startsWith("delete-profile:") || call.startsWith("delete-session:") || call === "inventory")).toBe(false);
  });

  test("force=1 détache les groupes et retourne le statut du nettoyage", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls)).request("/bot-1?purge=1&force=1", { method: "DELETE" });

    expect(response.status).toBe(200);
    // Cinq familles de sessions, une seule ligne de fil et un workflow :
    // le fil, sa compaction, la session du workflow et le brouillon de
    // persona. Aucune n'est oubliée sur le VPS du client.
    expect(await response.json()).toEqual({
      id: "bot-1",
      hostCleanup: "queued",
      // `force=1` détache d'abord le bot de ses salons ; ce faux n'en a aucun.
      groupsDetached: { left: 0, deleted: 0 },
    });
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(true);
  });

  test("une purge forcée refusée (profil en préparation) ne détache aucun salon", async () => {
    const calls: string[] = [];
    const response = await mount(
      deletionDb(calls, false, true, false, null, undefined, true), owner, deleteRuntimeDeps(calls),
    ).request("/bot-1?purge=1&force=1", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_PROFILE_PREPARING" } });
    expect(calls.some((sql) => sql.includes("delete from group_members"))).toBe(false);
    expect(calls.some((sql) => sql.includes("delete from bot_groups"))).toBe(false);
  });

  test("une purge forcée refusée (mission en cours) ne détache aucun salon", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, true, true), owner, deleteRuntimeDeps(calls))
      .request("/bot-1?purge=1&force=1", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_BUSY" } });
    expect(calls.some((sql) => sql.includes("delete from group_members"))).toBe(false);
  });

  test("le détachement suit les gardes, dans la transaction qui supprime, et réaffecte le pilote", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, true), owner, deleteRuntimeDeps(calls))
      .request("/bot-1?purge=1&force=1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ groupsDetached: { left: 1, deleted: 0 } });
    const deletion = calls.findIndex((sql) => sql.includes("delete from bots"));
    const detach = calls.findIndex((sql) => sql.includes("delete from group_members"));
    const lastGuard = calls.reduce(
      (found, sql, index) => index < deletion && sql.includes("from runs r") && sql.includes("for update of r") ? index : found,
      -1,
    );
    const pilot = calls.findIndex((sql) => sql.includes("update bot_groups g") && sql.includes("default_responder"));
    expect(lastGuard).toBeGreaterThan(calls.findIndex((sql) => sql.includes('hermes_session_id as "sessionId"')));
    expect(detach).toBeGreaterThan(lastGuard);
    expect(pilot).toBeGreaterThan(detach);
    expect(deletion).toBeGreaterThan(pilot);
    expect(calls[pilot]).toContain("order by m.position");
  });

  test("la purge après corbeille réutilise la tâche existante sans en insérer une seconde", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, false, false, "queued"), owner, deleteRuntimeDeps(calls)).request("/bot-1?purge=1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hostCleanup: "none" });
    expect(calls.filter((sql) => sql.includes("insert into bot_host_cleanups"))).toHaveLength(0);
  });

  test("un succès historique ne masque pas le nettoyage du purge courant", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, false, false, "succeeded", "2026-08-01T00:00:00.000Z"), owner, deleteRuntimeDeps(calls)).request("/bot-1?purge=1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hostCleanup: "queued" });
    expect(calls.filter((sql) => sql.includes("insert into bot_host_cleanups"))).toHaveLength(1);
  });

  test("les gardes sont rejouées dans la transaction de suppression", async () => {
    const calls: string[] = [];
    await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls)).request("/bot-1?purge=1&force=1", { method: "DELETE" });

    // Le verrou du bot est repris dans la transaction qui supprime.
    const deletion = calls.findIndex((sql) => sql.includes("delete from bots"));
    const lastLock = calls.reduce(
      (found, sql, index) =>
        index < deletion && sql.includes("select id from bots") && sql.includes("for update") ? index : found,
      -1,
    );
    const read = calls.findIndex((sql) => sql.includes('hermes_session_id as "sessionId"'));
    expect(lastLock).toBeGreaterThan(read);
  });

  test("restaurer un bot le sort de la corbeille, sinon l'invariant de 0031 le bloquerait", async () => {
    const calls: string[] = [];
    await mount(deletionDb(calls, false), owner, deleteRuntimeDeps(calls, ["scout"])).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });

    const update = calls.find((sql) => sql.includes("update bots set"))!;
    expect(update).toContain("deleted_at = case when");
  });

  test("restaurer un bot recrée le profil hôte s'il a disparu", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, false, true), owner, deleteRuntimeDeps(calls, [])).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(response.status).toBe(200);
    expect(calls).toContain("create-profile:scout");
    expect(calls.findIndex((sql) => sql.includes("update bots set")))
      .toBeGreaterThan(calls.indexOf("create-profile:scout"));
  });

  test("restaurer un bot dont le profil hôte est encore là ne le recrée pas", async () => {
    const calls: string[] = [];
    await mount(deletionDb(calls, false, false, true), owner, deleteRuntimeDeps(calls, ["scout"])).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(calls.some((call) => String(call).startsWith("create-profile"))).toBe(false);
  });

  test("la restauration annule le nettoyage en attente et prouve le profil sans le recréer", async () => {
    const calls: string[] = [];
    const sql = deletionDb(calls, false, false, true, "queued");
    const response = await mount(sql, owner, deleteRuntimeDeps(calls, ["scout"])).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: false }),
    });
    expect(response.status).toBe(200);
    expect(calls.some((statement) => statement.includes("update bot_host_cleanups"))).toBe(true);
    expect(calls).toContain("inventory");
    expect(calls.some((call) => call.startsWith("create-profile:"))).toBe(false);
  });

  test("la restauration est refusée pendant le bail actif du nettoyage", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, false, true, "running"), owner, deleteRuntimeDeps(calls)).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: false }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_HOST_CLEANUP_RUNNING" } });
    expect(calls).not.toContain("inventory");
  });
});

describe("retry du nettoyage hôte", () => {
  test("accepte uniquement une tâche en échec", async () => {
    const makeDb = (status: "failed" | "queued", botExists = true) => {
      const statements: string[] = [];
      const tx = ((parts: TemplateStringsArray) => {
        const sql = [...parts].join(" ");
        statements.push(sql);
        if (sql.includes("update bot_host_cleanups")) return Promise.resolve(status === "failed" ? [{ id: "cleanup-1" }] : []);
        if (sql.includes("select status from bot_host_cleanups")) return Promise.resolve([{ status }]);
        if (sql.includes('t.id as "threadId"')) return Promise.resolve(botExists ? [{ ...storedBotRow, hostCleanupStatus: "pending" }] : []);
        return Promise.resolve([]);
      }) as unknown as SQL;
      (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
      return { tx, statements };
    };
    const failed = makeDb("failed");
    const retried = await mount(failed.tx).request("/bot-1/host-cleanup/retry", { method: "POST" });
    expect(retried.status).toBe(200);
    expect((await retried.json()).hostCleanupStatus).toBe("pending");
    expect(failed.statements.some((sql) => sql.includes("attempts = 0") && sql.includes("error = null"))).toBe(true);

    const queued = makeDb("queued");
    const refused = await mount(queued.tx).request("/bot-1/host-cleanup/retry", { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "BOT_HOST_CLEANUP_NOT_FAILED" } });

    const purged = makeDb("failed", false);
    const retriedPurged = await mount(purged.tx).request("/bot-1/host-cleanup/retry", { method: "POST" });
    expect(retriedPurged.status).toBe(204);
    expect(purged.statements.some((sql) => sql.includes("attempts = 0"))).toBe(true);
  });
});

describe("bot archival while work is active", () => {
  test("refuses archival while a run is active or awaiting reconciliation", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, true)).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_BUSY" } });
    expect(calls.some((sql) => sql.includes("update bots set"))).toBe(false);
    const botLock = calls.findIndex((sql) => sql.includes("select id from bots") && sql.includes("for update"));
    const activeCheck = calls.findIndex((sql) => sql.includes("from runs r") && sql.includes("for update of r"));
    expect(botLock).toBeGreaterThanOrEqual(0);
    expect(activeCheck).toBeLessThan(botLock);
    expect(calls[activeCheck]).toContain("'unknown'");
  });

  test("a memory run is cancelled and named in BOT_BUSY details when a root run remains", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, true)).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "BOT_BUSY", details: { runId: "run-1", stepKind: "root" } },
    });
  });
});

describe("bot purge while a legacy memory extract run is still queued", () => {
  test("annule la passe mémoire et purge le bot", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, "memory"), owner, deleteRuntimeDeps(calls)).request("/bot-1?purge=1&force=1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "bot-1" });
    expect(calls.some((sql) => sql.includes("update runs set status = 'cancelled'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("insert into run_events") && sql.includes("'run.error'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(true);
    const lock = calls.find((sql) => sql.includes("from runs r") && sql.includes("for update of r"));
    expect(lock).toContain('r.step_kind as "stepKind"');
  });

  test("archive aussi : la passe mémoire est annulée, le bot part aux archives", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, "memory")).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    expect(response.status).toBe(200);
    expect(calls.some((sql) => sql.includes("update runs set status = 'cancelled'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("update bots set"))).toBe(true);
  });
});

describe("PATCH bot sectionId", () => {
  test("déplace le bot en fin de section cible", async () => {
    const calls: string[] = [];
    const target = "bee0702c-c86b-4615-ace8-ccae30c56bf6";
    const response = await mount(patchSectionDb(calls, target)).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionId: target }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "bot-1", sectionId: target, position: 4 });
    const update = calls.find((sql) => sql.includes("update bots set"))!;
    expect(update).toContain("section_id = coalesce(");
    expect(update).toContain("position = coalesce(");
    expect(calls.some((sql) => sql.includes("select id from sections"))).toBe(true);
    // Bots et salons partagent l'ordre d'une section : le rang suivant se prend
    // sur les deux tables, section verrouillée contre une arrivée simultanée.
    const next = calls.find((sql) => sql.includes("coalesce(greatest("))!;
    expect(next).toContain("from bots");
    expect(next).toContain("from bot_groups");
    expect(calls.some((sql) => sql.includes("from sections") && sql.includes("for update"))).toBe(true);
  });

  test("une section étrangère répond 404 SECTION_NOT_FOUND", async () => {
    const calls: string[] = [];
    const response = await mount(patchSectionDb(calls, null)).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionId: "00000000-0000-4000-8000-000000000999" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "SECTION_NOT_FOUND" } });
    expect(calls.some((sql) => sql.includes("update bots set"))).toBe(false);
  });
});

describe("bot lifecycle while it belongs to a group", () => {
  test("refuses archival so a persistent group pilot cannot become dangling", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, true)).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "BOT_IN_GROUP" } });
    expect(calls.some((sql) => sql.includes("update bots set"))).toBe(false);
    const botLock = calls.findIndex((sql) => sql.includes("select id from bots") && sql.includes("for update"));
    const membershipGuard = calls.findIndex((sql) => sql.includes("from group_members membership"));
    expect(botLock).toBeGreaterThanOrEqual(0);
    expect(membershipGuard).toBeGreaterThan(botLock);
  });

  test("refuses deletion instead of cascading a member out of a routable room", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, true)).request("/bot-1", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "BOT_IN_GROUP" } });
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(false);
  });
});

describe("panneau des capacités d'un bot", () => {
  test("un bot inconnu est un 404, pas un panneau vide", async () => {
    const tx = (() => Promise.resolve([])) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    const response = await mount(tx).request("/bot-404/capabilities");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "BOT_NOT_FOUND" } });
  });

  test("l'usage part des runs de CE bot et écarte les résultats dont l'appel a été purgé", async () => {
    let usageSql = "";
    const tx = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      if (sql.includes("hermes_profile")) return Promise.resolve([{ hermesProfile: "pixel" }]);
      if (sql.includes("from run_events")) {
        usageSql = sql;
        return Promise.resolve([
          { tool: "terminal", calls: 9, failures: 2, lastUsedAt: "2026-08-25T09:30:00.000Z" },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);

    const response = await mount(tx).request("/bot-1/capabilities");
    expect(response.status).toBe(200);
    const body = await response.json() as { usage: unknown; inventoryError: { code: string } };
    expect(body.usage).toEqual([
      { tool: "terminal", calls: 9, failures: 2, lastUsedAt: "2026-08-25T09:30:00.000Z" },
    ]);
    // Sans runtime enregistré, la lecture d'inventaire est impossible : et
    // l'usage arrive quand même.
    expect(body.inventoryError.code).toBe("RUNTIME_REQUIRED");
    expect(usageSql).toContain("run.bot_id =");
    expect(usageSql).toContain("having count(*) filter (where event.type = 'tool.call') > 0");
  });
});

describe("erreurs d'outils d'un bot", () => {
  const stored = {
    id: "5f1b2f6e-0c6d-4d2f-9c3f-2b7f9a1c0001",
    botId: "bot-1",
    threadId: "thread-1",
    runId: "c48ad03c-d8bc-4afa-9d82-4328fe44f333",
    userId: "user-1",
    tool: "skill_manage",
    toolCallId: "tc_6",
    errorMessage: null,
    durationMs: 27,
    occurredAt: "2026-09-03T10:00:00.000Z",
  };

  function errorsDb(rows: unknown[], capture: { sql: string; bindings: unknown[] }): SQL {
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join(" ");
      if (sql.includes("select id from bots")) return Promise.resolve([{ id: "bot-1" }]);
      if (sql.includes("from tool_errors")) {
        capture.sql = sql;
        capture.bindings = values;
        return Promise.resolve(rows);
      }
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }

  test("liste les échecs de CE bot, les plus récents d'abord, message null conservé", async () => {
    const capture = { sql: "", bindings: [] as unknown[] };
    const response = await mount(errorsDb([stored], capture)).request("/bot-1/tool-errors");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ errors: [stored], nextCursor: null });
    expect(capture.sql).toContain("from tool_errors");
    expect(capture.sql).toContain("bot_id =");
    expect(capture.sql).toContain("order by occurred_at desc, id desc");
    expect(capture.bindings).toContain("bot-1");
    expect(capture.bindings).toContain("org-1");
  });

  test("pagine à limit+1 et rend un curseur occurredAt|id", async () => {
    const capture = { sql: "", bindings: [] as unknown[] };
    const second = { ...stored, id: "5f1b2f6e-0c6d-4d2f-9c3f-2b7f9a1c0002", occurredAt: "2026-09-03T09:00:00.000Z" };
    const response = await mount(errorsDb([stored, second], capture)).request("/bot-1/tool-errors?limit=1");
    const body = await response.json() as { errors: unknown[]; nextCursor: string | null };
    expect(body.errors).toHaveLength(1);
    expect(body.nextCursor).toBe(`${stored.occurredAt}|${stored.id}`);
    expect(capture.bindings).toContain(2);

    const next = await mount(errorsDb([second], capture)).request(`/bot-1/tool-errors?cursor=${encodeURIComponent(body.nextCursor!)}`);
    expect(next.status).toBe(200);
    expect(capture.bindings).toContain(stored.id);
  });

  test("limite bornée à 50, curseur validé, bot inconnu en 404", async () => {
    const capture = { sql: "", bindings: [] as unknown[] };
    expect((await mount(errorsDb([], capture)).request("/bot-1/tool-errors?limit=51")).status).toBe(400);
    expect((await mount(errorsDb([], capture)).request("/bot-1/tool-errors?limit=0")).status).toBe(400);
    expect((await mount(errorsDb([], capture)).request("/bot-1/tool-errors?cursor=garbage")).status).toBe(400);
    const tx = (() => Promise.resolve([])) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    expect((await mount(tx).request("/bot-404/tool-errors")).status).toBe(404);
  });
});

describe("persona d'un bot", () => {
  function acceptingDb(): SQL {
    const tx = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      if (sql.includes("update bots set")) return Promise.resolve([{ id: "bot-1" }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }

  // Rogner à 100 000 caractères retirait au bot une partie de son cadrage sans
  // le dire : 200 à l'enregistrement, et un bot qui « change de caractère »
  // plusieurs runs plus tard, sans rien à quoi rattacher le changement.
  test("une persona trop longue est refusée, pas rognée en silence", async () => {
    const response = await mount(acceptingDb()).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "x".repeat(100_001) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "BOT_INSTRUCTIONS_TOO_LONG" } });
  });

  test("une persona exactement au plafond passe", async () => {
    const response = await mount(acceptingDb()).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "x".repeat(100_000) }),
    });
    expect(response.status).not.toBe(400);
  });

  // Le serveur mesure APRÈS `trim()` : sinon des espaces de bord suffiraient à
  // faire refuser une persona que l'enregistrement aurait acceptée.
  test("les espaces de bord ne font pas franchir le plafond", async () => {
    const response = await mount(acceptingDb()).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: `   ${"x".repeat(100_000)}   ` }),
    });
    expect(response.status).not.toBe(400);
  });
});

describe("profil Hermes optionnel (0031)", () => {
  function creationDb(calls: string[]): SQL {
    const tx = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      calls.push(sql);
      if (sql.includes("select id from sections")) return Promise.resolve([{ id: "section-1" }]);
      if (sql.includes("coalesce(greatest(")) return Promise.resolve([{ next: 0 }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }

  // Exiger un profil obligeait l'opérateur à en inventer un, à le créer à la
  // main sur la machine (aucun endpoint HTTP ne le fait), pour un
  // cloisonnement qui n'existait pas tant que `multiplex_profiles` est coupé.
  test("créer un bot sans profil n’interroge jamais le runtime", async () => {
    const calls: string[] = [];
    const response = await mount(creationDb(calls)).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Pixel" }),
    });
    // Sans runtime enregistré, la création s'arrête sur RUNTIME_REQUIRED : ce
    // qui prouve justement qu'aucune validation de profil ne l'a précédée.
    expect(await response.json()).toEqual({ error: { code: "RUNTIME_REQUIRED" } });
    expect(calls.some((sql) => sql.includes("hermes_profile"))).toBe(false);
  });

  test("une chaîne vide vaut « pas de profil », pas un profil nommé « »", async () => {
    const calls: string[] = [];
    const response = await mount(creationDb(calls)).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Pixel", hermesProfile: "" }),
    });
    expect(response.status).not.toBe(400);
  });
});

describe("profil Hermes géré par openedbot", () => {
  const hostProfile = {
    name: "atlas",
    displayName: "Atlas",
    title: null,
    description: null,
    soul: null,
    model: { default: null, provider: null },
    uiMeta: null,
    hasAvatar: false,
    routines: [],
    skills: [{ name: "research", enabled: true }],
    toolsets: [{ name: "web", enabled: true }],
    mcpServers: [{ name: "linear", enabled: false }],
  };

  const hostMemory = (profile: string) => ({
    profile, memoryEnabled: true, userProfileEnabled: true,
    limits: { memory: 2200, user: 1375 },
    entries: { memory: ["Le projet est un monorepo Bun."], user: [] },
    usedChars: { memory: 30, user: 0 },
    message: null,
  });

  function runtimeDeps(calls: string[], features = ["profile_management", "profile_capabilities", "profile_credentials", "profile_memory"]): BotRouteDeps {
    let approvalMode = "ask_writes";
    const client = {
      modelOptions: async () => ({
        provider: "anthropic", model: "claude-sonnet-4",
        providers: [
          { slug: "anthropic", id: "claude-sonnet-4" },
          { slug: "opencode-free", id: "nemotron-3.5-lightning-free" },
        ].map(({ slug, id }) => ({ slug, authenticated: true, models: [{ id }] })),
      }),
      hostCreateProfile: async (_name: string, options?: string | { displayName?: string; provider?: string; model?: string }) => {
        const selection = typeof options === "string" ? undefined : options;
        if (selection?.provider && selection.model) {
          calls.push(`create-profile:${selection.provider}:${selection.model}`);
          return { ...hostProfile, model: { default: selection.model, provider: selection.provider } };
        }
        calls.push("create-profile");
        return hostProfile;
      },
      hostDeleteProfile: async (profile: string) => { calls.push(`delete-profile:${profile}`); },
      probeProfileIsolation: async () => "isolated" as const,
      capabilityInventory: async () => ({
        toolsets: [{ name: "web", label: "Web", description: null, enabled: true, configured: true, tools: ["web"] }],
        skills: [{ name: "research", description: "Find sources.", category: "research" }],
      }),
      hostProfileInventory: async () => ({ profiles: [hostProfile] }),
      mcpInventory: async () => ({ platform: "api_server", servers: [], catalog: [] }),
      hostSetProfileToolset: async (profile: string, name: string, enabled: boolean) => {
        calls.push(`toolset:${profile}:${name}:${enabled}`);
        return { name, profile, platform: "api_server", enabled, requested: enabled, applied: true };
      },
      hostProfileMemory: async (profile: string) => {
        calls.push(`memory-get:${profile}`);
        return hostMemory(profile);
      },
      hostWriteProfileMemory: async (profile: string, write: { action: string; target: string; content?: string; oldText?: string }) => {
        calls.push(`memory-write:${profile}:${write.target}:${write.action}:${write.content ?? ""}:${write.oldText ?? ""}`);
        return { ...hostMemory(profile), message: "Entry added." };
      },
      hostSetProfileMcpServer: async (profile: string, name: string, enabled: boolean) => {
        calls.push(`mcp:${profile}:${name}:${enabled}`);
        return { name, profile, enabled, requested: enabled, applied: true };
      },
      hostSetProfileSkill: async (profile: string, name: string, enabled: boolean) => {
        calls.push(`skill:${profile}:${name}:${enabled}`);
        return { name, profile, enabled, requested: enabled, applied: true };
      },
      hostSetProfileModel: async (profile: string, selection: { provider: string; model: string }) => {
        calls.push(`model:${profile}:${selection.provider}:${selection.model}`);
        return { profile, provider: selection.provider, model: selection.model, applied: true };
      },
      hostSetApprovalPolicy: async (profile: string, mode: string) => {
        calls.push(`approval-policy:${profile}:${mode}`);
        approvalMode = mode;
        return { mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
      },
      hostApprovalPolicy: async (profile: string) => {
        calls.push(`approval-policy-read:${profile}`);
        return { mode: approvalMode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
      },
      hostSetProfileCredential: async (profile: string, provider: string) => {
        calls.push(`cred-set:${profile}:${provider}`);
        return { provider, profile, verification: "confirmed" as const, detail: null };
      },
      hostDeleteProfileCredential: async (profile: string, provider: string) => {
        calls.push(`cred-del:${profile}:${provider}`);
        return { provider, profile, verification: "confirmed" as const, detail: null };
      },
      deleteSession: async () => undefined,
    };
    return {
      readRuntime: (async () => ({
        id: "runtime-1",
        name: "Hermes",
        capacity: 4,
        linkFeatures: features,
        client: {} as never,
        selectedProvider: "anthropic",
        selectedModel: "claude-sonnet-4",
        reasoningEffort: null,
      })) as BotRouteDeps["readRuntime"],
      readRuntimeForDeletion: (async () => ({ id: "runtime-1", linkFeatures: features })) as BotRouteDeps["readRuntimeForDeletion"],
      clientFactory: () => client as never,
    };
  }

  function profileDb(row: BotRow, mode: "create" | "capabilities" | "repair" = "create", statements: string[] = [], assignmentMode: "per_bot" | "global" = "per_bot"): SQL {
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join(" ");
      statements.push(sql);
      if (sql.includes("select model_assignment_mode")) return Promise.resolve([{ mode: assignmentMode }]);
      if (mode === "repair" && sql.includes('select name, hermes_profile as "profile", model')) return Promise.resolve([{ name: row.name, profile: row.hermesProfile, model: row.model }]);
      if (mode === "create" && sql.includes('select id, name, slug')) return Promise.resolve([{ id: row.id, name: row.name, slug: row.slug, profile: null, model: row.model }]);
      if (sql.includes("select id from sections")) return Promise.resolve(values.includes("ffffffff-ffff-4fff-8fff-ffffffffffff") ? [] : [{ id: row.sectionId }]);
      if (sql.includes("coalesce(greatest(")) return Promise.resolve([{ next: 0 }]);
      if (sql.includes("update bots")) return Promise.resolve([{ id: row.id }]);
      if (sql.includes('t.id as "threadId"')) return Promise.resolve([row]);
      if (mode === "capabilities" && sql.includes('hermes_profile as "hermesProfile"')) return Promise.resolve([{ hermesProfile: row.hermesProfile }]);
      if (mode === "capabilities" && sql.includes('hermes_profile as "profile"')) return Promise.resolve([{ profile: row.hermesProfile }]);
      if (sql.includes("from run_events")) return Promise.resolve([]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }

  test("crée le bot et met son profil en file sans appeler l'hôte", async () => {
    const calls: string[] = [];
    const statements: string[] = [];
    const response = await mount(profileDb({ ...storedBotRow, name: "Atlas", slug: "atlas", hermesProfile: "atlas", hermesProfileManaged: true }, "create", statements), owner, runtimeDeps(calls)).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Atlas" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.hermesProfileManaged).toBe(true);
    expect(body.profileProvisionStatus).toBe("preparing");
    expect(calls.some((call) => call.startsWith("create-profile"))).toBe(false);
    expect(statements.some((sql) => sql.includes("insert into bots"))).toBe(true);
    expect(statements.some((sql) => sql.includes("insert into bot_profile_provisions"))).toBe(true);
    expect(statements.some((sql) => sql.includes("insert into runs") && sql.includes("bot_greeting"))).toBe(false);
    expect(calls).not.toContain("delete-profile:atlas");
  });

  test("creates one queued root greeting in the bot transaction without a message", async () => {
    const statements: string[] = [];
    const response = await mount(profileDb({
      ...storedBotRow,
      name: "Atlas",
      slug: "atlas",
      description: "Research assistant",
      hermesProfile: "atlas",
      hermesProfileManaged: true,
    }, "create", statements), owner, runtimeDeps([])).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Atlas",
        description: "Research assistant",
        mission: "Find concise, sourced answers.",
        greet: true,
      }),
    });

    expect(response.status).toBe(201);
    const botInsert = statements.findIndex((sql) => sql.includes("insert into bots"));
    const provisionInsert = statements.findIndex((sql) => sql.includes("insert into bot_profile_provisions"));
    const greetingStatements = statements.filter((sql) => sql.includes("insert into runs") && sql.includes("bot_greeting"));
    const greetingInsert = statements.indexOf(greetingStatements[0]!);
    expect(botInsert).toBeGreaterThanOrEqual(0);
    expect(provisionInsert).toBeGreaterThan(botInsert);
    expect(greetingStatements).toHaveLength(1);
    expect(greetingInsert).toBeGreaterThan(provisionInsert);
    expect(statements[greetingInsert]).toContain("'queued'");
    expect(statements[greetingInsert]).toContain("null, 0, 'root', 0, null, null, 'not_started', true");
    expect(statements[greetingInsert]).toContain("initiator_user_id, deadline_at, origin");
    expect(statements.some((sql) => sql.includes("insert into messages"))).toBe(false);
  });

  test("omits a greeting when greet is false or absent", async () => {
    for (const body of [{ name: "Atlas" }, { name: "Atlas", greet: false }]) {
      const statements: string[] = [];
      const response = await mount(profileDb({
        ...storedBotRow,
        name: "Atlas",
        slug: "atlas",
        hermesProfile: "atlas",
        hermesProfileManaged: true,
      }, "create", statements), owner, runtimeDeps([])).request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(statements.some((sql) => sql.includes("insert into runs") && sql.includes("bot_greeting"))).toBe(false);
    }
  });

  test("PATCH model alone writes the provider from the catalog; unknown models never reach SQL or the host", async () => {
    const calls: string[] = [];
    const row = { ...storedBotRow, model: "nemotron-3.5-lightning-free", hermesProfile: "atlas", hermesProfileManaged: true };
    const deps = runtimeDeps(calls);
    const statements: string[] = [];
    const app = mount(profileDb(row, "create", statements), owner, deps);
    const patch = (model: string) => app.request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
    });
    expect((await patch(row.model)).status).toBe(200);
    expect(calls).toContain("model:atlas:opencode-free:nemotron-3.5-lightning-free");
    calls.length = 0;
    statements.length = 0;
    const response = await patch("not-in-catalog");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "BOT_MODEL_UNAVAILABLE" } });
    expect(calls).toEqual([]);
    expect(statements.some((sql) => sql.includes("update bots"))).toBe(false);
  });

  test("creation and adding a profile resolve a bot's own model from the catalog", async () => {
    for (const path of ["/", "/bot-1/profile"]) {
      const calls: string[] = [];
      const statements: string[] = [];
      const row = { ...storedBotRow, model: "nemotron-3.5-lightning-free", hermesProfile: "atlas", hermesProfileManaged: true };
      const response = await mount(profileDb(row, "create", statements), owner, runtimeDeps(calls)).request(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Atlas", model: row.model }),
      });
      expect(response.status).toBe(path === "/" ? 201 : 200);
      if (path === "/") {
        expect(calls.some((call) => call.startsWith("create-profile"))).toBe(false);
        expect(statements.some((sql) => sql.includes("insert into bot_profile_provisions"))).toBe(true);
      } else {
        expect(calls).toContain("create-profile:opencode-free:nemotron-3.5-lightning-free");
      }
    }
  });

  test("un PATCH modèle réécrit le bloc model du profil géré, un échec hôte ne bloque pas", async () => {
    const calls: string[] = [];
    const row = {
      ...storedBotRow,
      name: "Atlas",
      slug: "atlas",
      hermesProfile: "atlas",
      hermesProfileManaged: true,
      model: "claude-sonnet-4",
      archivedAt: null,
      deletedAt: null,
    };
    const patched = await mount(profileDb(row), owner, runtimeDeps(calls)).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", provider: "anthropic" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ profileModel: { applied: true } });
    expect(calls).toContain("model:atlas:anthropic:claude-sonnet-4");

    const failing: string[] = [];
    const deps = runtimeDeps(failing);
    const originalFactory = deps.clientFactory!;
    const broken: BotRouteDeps = {
      ...deps,
      clientFactory: (config) => ({
        ...originalFactory(config),
        hostSetProfileModel: async () => {
          failing.push("model-failed");
          throw new HermesClientError("down", 502, "HOST_UNAVAILABLE");
        },
      }),
    };
    const still = await mount(profileDb(row), owner, broken).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", provider: "anthropic" }),
    });
    expect(still.status).toBe(200);
    expect(await still.json()).toMatchObject({ profileModel: { applied: false } });
    expect(failing).toContain("model-failed");
  });

  test("en mode global, un PATCH modèle n'écrit pas le profil : le run y envoie le modèle global", async () => {
    const calls: string[] = [];
    const row = { ...storedBotRow, name: "Atlas", slug: "atlas", hermesProfile: "atlas", hermesProfileManaged: true, model: "claude-sonnet-4", archivedAt: null, deletedAt: null };
    const patched = await mount(profileDb(row, "create", [], "global"), owner, runtimeDeps(calls)).request("/bot-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", provider: "anthropic" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).not.toHaveProperty("profileModel");
    expect(calls.some((call) => call.startsWith("model:"))).toBe(false);
  });

  test("PATCH permissionMode synchronizes only a changed managed profile when the feature is announced", async () => {
    const calls: string[] = [];
    const tighteningEvents: string[] = [];
    const row = { ...storedBotRow, hermesProfile: "scout", hermesProfileManaged: true, archivedAt: null, deletedAt: null };
    const enabled = runtimeDeps(tighteningEvents, ["profile_management", "approval_policy"]);
    const changed = await mount(profileDb(row, "create", tighteningEvents), owner, enabled).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "plan" }),
    });
    expect(changed.status).toBe(200);
    expect(tighteningEvents).toContain("approval-policy:scout:block_writes");
    expect(tighteningEvents.indexOf("approval-policy:scout:block_writes")).toBeLessThan(tighteningEvents.findIndex((entry) => entry.includes("permission_mode =")));

    const looseningEvents: string[] = [];
    const loosened = await mount(profileDb(row, "create", looseningEvents), owner, runtimeDeps(looseningEvents, ["profile_management", "approval_policy"])).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "auto" }),
    });
    expect(loosened.status).toBe(200);
    expect(looseningEvents.indexOf("approval-policy:scout:off")).toBeGreaterThan(looseningEvents.findIndex((entry) => entry.includes("permission_mode =")));

    calls.length = 0;
    const rejected = await mount(profileDb(row), owner, runtimeDeps(calls, ["profile_management", "approval_policy"])).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "auto", sectionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
    });
    expect(rejected.status).toBe(404);
    expect(calls).not.toContain("approval-policy:scout:off");

    calls.length = 0;
    const unsupported = await mount(profileDb(row), owner, runtimeDeps(calls)).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "plan" }),
    });
    expect(unsupported.status).toBe(200);
    expect(calls).not.toContain("approval-policy:scout:block_writes");

    const failedCalls: string[] = [];
    const failedStatements: string[] = [];
    const brokenDeps = runtimeDeps(failedCalls, ["profile_management", "approval_policy"]);
    const originalFactory = brokenDeps.clientFactory!;
    brokenDeps.clientFactory = (config) => ({
      ...originalFactory(config),
      hostSetApprovalPolicy: async () => { throw new HermesClientError("unverified", 502, "APPROVAL_POLICY_UNVERIFIED"); },
    });
    const failed = await mount(profileDb(row, "create", failedStatements), owner, brokenDeps).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "plan" }),
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "APPROVAL_POLICY_UNVERIFIED" } });
    const botWrites = failedStatements.filter((sql) => sql.includes("update bots"));
    expect(botWrites.length).toBeGreaterThan(0);
    expect(botWrites.every((sql) => sql.includes("approval_policy_mode ="))).toBe(true);
    expect(botWrites.some((sql) => sql.includes("permission_mode ="))).toBe(false);
  });

  test("ajoute un profil à un bot historique sans profil", async () => {
    const calls: string[] = [];
    const response = await mount(profileDb({ ...storedBotRow, name: "Atlas", slug: "atlas", hermesProfile: "atlas", hermesProfileManaged: true }), owner, runtimeDeps(calls)).request("/bot-1/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).hermesProfile).toBe("atlas");
    expect(calls).not.toContain("delete-profile:atlas");
  });

  describe("profil absent du runtime actuel (runtime remplacé)", () => {
    const nova = { ...storedBotRow, name: "Nova", slug: "nova", hermesProfile: "nova", hermesProfileManaged: false, model: "nemotron-3.5-lightning-free" };
    // Avant la création, l'hôte n'a pas le profil ; après, il le prouve isolé.
    function missingDeps(calls: string[]): BotRouteDeps {
      const deps = runtimeDeps(calls);
      const client = deps.clientFactory!({} as never) as unknown as Record<string, unknown>;
      client.probeProfileIsolation = async () => calls.some((call) => call.startsWith("create-profile")) ? "isolated" : "missing";
      return deps;
    }
    const post = (_path: string) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

    test("l'état prouve l'absence sur l'hôte et dit ce qui suit le bot", async () => {
      const calls: string[] = [];
      const missing = await mount(profileDb(nova, "repair"), owner, missingDeps(calls)).request("/bot-1/profile/status");
      expect(missing.status).toBe(200);
      expect(await missing.json()).toMatchObject({ profile: "nova", state: "missing", canRepair: true, needsModel: { transfer: false, reset: false }, carried: ["identity", "model", "persona", "conversations"], lost: ["memory", "credentials", "capabilities", "sessions"] });
      const present = await mount(profileDb(nova, "repair"), owner, runtimeDeps([])).request("/bot-1/profile/status");
      expect(await present.json()).toMatchObject({ state: "present", canRepair: false });
    });

    test("le transfert recrée le même profil avec le modèle propre du bot", async () => {
      const calls: string[] = [];
      const statements: string[] = [];
      const response = await mount(profileDb(nova, "repair", statements), owner, missingDeps(calls)).request("/bot-1/profile/transfer", post("/"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mode: "transfer", profile: "nova", model: "nemotron-3.5-lightning-free", carried: ["identity", "model", "persona", "conversations"] });
      expect(calls).toContain("create-profile:opencode-free:nemotron-3.5-lightning-free");
      expect(statements.some((sql) => sql.includes("hermes_profile_managed = true"))).toBe(true);

      const again = await mount(profileDb(nova, "repair"), owner, runtimeDeps([])).request("/bot-1/profile/transfer", post("/"));
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: "HERMES_PROFILE_PRESENT" } });
    });

    test("un modèle absent bloque le transfert ; la réinitialisation repart du modèle du runtime", async () => {
      const calls: string[] = [];
      const orphan = { ...nova, model: "gpt-retired" };
      const refused = await mount(profileDb(orphan, "repair"), owner, missingDeps(calls)).request("/bot-1/profile/transfer", post("/"));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "BOT_MODEL_UNAVAILABLE" } });
      expect(calls.some((call) => call.startsWith("create-profile"))).toBe(false);

      const statements: string[] = [];
      const reset = await mount(profileDb(orphan, "repair", statements), owner, missingDeps(calls)).request("/bot-1/profile/reset", post("/"));
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({ mode: "reset", model: "claude-sonnet-4", carried: ["identity", "persona", "conversations"] });
      expect(calls).toContain("create-profile:anthropic:claude-sonnet-4");
      expect(statements.some((sql) => sql.includes("then model else"))).toBe(true);
    });

    // The runtime names no model of its own; the host may still have a default.
    function modellessDeps(calls: string[], hostDefault: { provider: string | null; model: string | null }): BotRouteDeps {
      const deps = missingDeps(calls);
      const client = deps.clientFactory!({} as never) as unknown as Record<string, unknown>;
      const modelOptions = client.modelOptions as () => Promise<Record<string, unknown>>;
      client.modelOptions = async () => ({ ...(await modelOptions()), ...hostDefault });
      const readRuntime = deps.readRuntime as unknown as (...args: unknown[]) => Promise<Record<string, unknown>>;
      return {
        ...deps,
        readRuntime: (async (...args: unknown[]) => ({ ...(await readRuntime(...args)), selectedProvider: null, selectedModel: null })) as unknown as BotRouteDeps["readRuntime"],
      };
    }
    const postJson = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    test("without any runtime model, the status asks for one and a bare reset never creates a modelless profile", async () => {
      const calls: string[] = [];
      const deps = modellessDeps(calls, { provider: null, model: null });
      const status = await mount(profileDb(nova, "repair"), owner, deps).request("/bot-1/profile/status");
      expect(await status.json()).toMatchObject({ canRepair: true, needsModel: { transfer: false, reset: true } });
      const follower = await mount(profileDb({ ...nova, model: null }, "repair"), owner, deps).request("/bot-1/profile/status");
      expect(await follower.json()).toMatchObject({ needsModel: { transfer: true, reset: true } });

      const refused = await mount(profileDb(nova, "repair"), owner, deps).request("/bot-1/profile/reset", post("/"));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "RUNTIME_MODEL_REQUIRED" } });
      expect(calls.some((call) => call.startsWith("create-profile"))).toBe(false);
    });

    test("a picked model creates the profile and becomes the bot's own; an unserved pick is refused", async () => {
      const calls: string[] = [];
      const statements: string[] = [];
      const deps = modellessDeps(calls, { provider: null, model: null });
      const reset = await mount(profileDb(nova, "repair", statements), owner, deps)
        .request("/bot-1/profile/reset", postJson({ model: "nemotron-3.5-lightning-free", provider: "opencode-free" }));
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({ mode: "reset", model: "nemotron-3.5-lightning-free" });
      expect(calls).toContain("create-profile:opencode-free:nemotron-3.5-lightning-free");
      expect(statements.some((sql) => sql.includes("then model else"))).toBe(true);

      const unserved = await mount(profileDb(nova, "repair"), owner, modellessDeps([], { provider: null, model: null }))
        .request("/bot-1/profile/reset", postJson({ model: "gpt-retired" }));
      expect(unserved.status).toBe(409);
      expect(await unserved.json()).toMatchObject({ error: { code: "BOT_MODEL_UNAVAILABLE" } });
    });

    test("without a runtime selection, the reset takes the host's current default", async () => {
      const calls: string[] = [];
      const deps = modellessDeps(calls, { provider: "anthropic", model: "claude-sonnet-4" });
      const status = await mount(profileDb(nova, "repair"), owner, deps).request("/bot-1/profile/status");
      expect(await status.json()).toMatchObject({ needsModel: { transfer: false, reset: false } });
      const reset = await mount(profileDb(nova, "repair"), owner, deps).request("/bot-1/profile/reset", post("/"));
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({ model: "claude-sonnet-4" });
      expect(calls).toContain("create-profile:anthropic:claude-sonnet-4");
    });
  });

  test("expose la portée profil et relaie les deux bascules", async () => {
    const calls: string[] = [];
    const deps = runtimeDeps(calls);
    const read = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, deps).request("/bot-1/capabilities");
    expect(read.status).toBe(200);
    const capabilities = await read.json();
    expect(capabilities.scope).toBe("profile");
    expect(capabilities.skills).toEqual([{
      name: "research",
      description: "Find sources.",
      category: "research",
      enabled: true,
      writable: true,
    }]);
    const toolset = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, deps).request("/bot-1/capabilities/toolsets/web", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    expect(toolset.status).toBe(200);
    const mcp = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, deps).request("/bot-1/capabilities/mcp/linear", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    expect(mcp.status).toBe(200);
    expect(calls).toContain("toolset:atlas:web:false");
    expect(calls).toContain("mcp:atlas:linear:true");
    const skill = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, deps).request("/bot-1/capabilities/skills/research", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    expect(skill.status).toBe(200);
    expect(calls).toContain("skill:atlas:research:false");
    const cred = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, deps).request("/bot-1/credentials/anthropic", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "sk-test" }),
    });
    expect(cred.status).toBe(200);
    const credBody = await cred.json();
    expect(credBody).toEqual({ provider: "anthropic", profile: "atlas", verification: "confirmed", detail: null });
    expect(JSON.stringify(credBody)).not.toContain("sk-test");
    expect(calls).toContain("cred-set:atlas:anthropic");
  });

  test("les lectures de capacités partent ensemble, pas l'une après l'autre", async () => {
    const deps = runtimeDeps([], ["profile_management", "profile_capabilities", "toolset_management"]);
    if (!deps.clientFactory) throw new Error("runtimeDeps fournit toujours un client");
    const base = deps.clientFactory({} as never) as unknown as Record<string, unknown>;
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Aucune lecture ne répond tant que les quatre n'ont pas démarré : une
    // lecture enchaînée derrière une autre ne démarre jamais et le test expire.
    const held = <T>(name: string, value: T) => async () => {
      started.push(name);
      if (started.length === 4) release();
      await gate;
      return value;
    };
    const client = {
      ...base,
      capabilityInventory: held("inventory", await (base.capabilityInventory as () => Promise<unknown>)()),
      hostToolsets: held("hostToolsets", { platform: "api_server", settable: ["web"], availability: null }),
      hostProfileInventory: held("profiles", await (base.hostProfileInventory as () => Promise<unknown>)()),
      mcpInventory: held("mcp", await (base.mcpInventory as () => Promise<unknown>)()),
    };
    const read = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, {
      ...deps,
      clientFactory: () => client as never,
    }).request("/bot-1/capabilities");

    expect(read.status).toBe(200);
    expect(started.toSorted()).toEqual(["hostToolsets", "inventory", "mcp", "profiles"]);
    expect((await read.json()).scope).toBe("profile");
  });

  test("DELETE retire une clé du profil et renvoie le résultat relu", async () => {
    const calls: string[] = [];
    const response = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/credentials/anthropic", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "anthropic", profile: "atlas", verification: "confirmed", detail: null });
    expect(calls).toContain("cred-del:atlas:anthropic");
  });

  test("refuse les clés de profil quand le runtime n'annonce pas profile_credentials", async () => {
    const calls: string[] = [];
    const response = await mount(
      profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"),
      owner,
      runtimeDeps(calls, ["profile_management", "profile_capabilities"]),
    ).request("/bot-1/credentials/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "PROFILE_CREDENTIALS_UNAVAILABLE" } });
    expect(calls).not.toContain("cred-set:atlas:anthropic");
  });

  test("refuse une clé fournisseur vide avant tout appel au profil", async () => {
    const calls: string[] = [];
    const response = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/credentials/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "RUNTIME_PROVIDER_KEY_INVALID" } });
    expect(calls).not.toContain("cred-set:atlas:anthropic");
  });

  test("refuse un toolset toujours interdit avant l'appel hôte, et laisse memory sur un profil", async () => {
    const calls: string[] = [];
    const refused = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/capabilities/toolsets/cronjob", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "TOOLSET_FORBIDDEN" } });
    expect(calls).toEqual([]);

    const allowed = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/capabilities/toolsets/memory", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    expect(allowed.status).toBe(200);
    expect(calls).toContain("toolset:atlas:memory:true");
  });

  test("lit et écrit la mémoire du runtime par le magasin du profil", async () => {
    const calls: string[] = [];
    const read = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/runtime-memory");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      available: true, profile: "atlas", enabled: true,
      limits: { memory: 2200, user: 1375 },
      entries: { memory: ["Le projet est un monorepo Bun."], user: [] },
      usedChars: { memory: 30, user: 0 },
      message: null,
    });
    expect(calls).toEqual(["memory-get:atlas"]);

    const write = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/runtime-memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "user", action: "add", content: "  Elodie,  CTO, Paris. " }),
    });
    expect(write.status).toBe(200);
    expect((await write.json()).message).toBe("Entry added.");
    expect(calls).toContain("memory-write:atlas:user:add:Elodie, CTO, Paris.:");

    // Une action ou une cible hors grammaire ne part jamais vers l'hôte.
    const refused = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/runtime-memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "soul", action: "add", content: "x" }),
    });
    expect(refused.status).toBe(400);
    expect(calls.filter((call) => call.startsWith("memory-write")).length).toBe(1);

    // Sans profil, la mémoire openedbot reste le magasin : l'écran doit le savoir.
    const noProfile = await mount(profileDb({ ...storedBotRow, hermesProfile: null }, "capabilities"), owner, runtimeDeps(calls)).request("/bot-1/runtime-memory");
    expect(await noProfile.json()).toEqual({ available: false, reason: "no_profile" });
    // Un hôte qui n'annonce pas `profile_memory` ne reçoit aucun appel.
    const noFeature = await mount(profileDb({ ...storedBotRow, hermesProfile: "atlas" }, "capabilities"), owner, runtimeDeps(calls, ["profile_management", "profile_capabilities"])).request("/bot-1/runtime-memory");
    expect(await noFeature.json()).toEqual({ available: false, reason: "feature_missing" });
    expect(calls.filter((call) => call === "memory-get:atlas").length).toBe(1);
  });

  test("met en file le profil géré et les sessions sans appel hôte", async () => {
    const calls: string[] = [];
    const response = await mount(deletionDb(calls, false, false, true), owner, runtimeDeps(calls)).request("/bot-1?purge=1&force=1", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).hostCleanup).toBe("queued");
    expect(calls.some((sql) => sql.includes("insert into bot_host_cleanups"))).toBe(true);
    expect(calls.some((call) => call.startsWith("delete-profile:") || call.startsWith("delete-session:"))).toBe(false);
  });

  test("purge après corbeille conserve la tâche programmée sans nouvel appel hôte", async () => {
    const calls: string[] = [];
    const deps = runtimeDeps(calls);
    const client = deps.clientFactory!({} as never) as unknown as Record<string, unknown>;
    client.hostDeleteProfile = async () => {
      throw new HermesClientError("no profile named scout exists", 404, "PROFILE_NOT_FOUND");
    };
    const response = await mount(deletionDb(calls, false, false, true), owner, deps).request("/bot-1?purge=1&force=1", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).hostCleanup).toBe("queued");
    expect(calls.some((call) => call.startsWith("delete-profile:") || call.startsWith("delete-session:"))).toBe(false);
  });

  test("purge ne tente pas la suppression du profil dans la requête", async () => {
    const calls: string[] = [];
    const deps = runtimeDeps(calls);
    const client = deps.clientFactory!({} as never) as unknown as Record<string, unknown>;
    client.hostDeleteProfile = async () => {
      throw new HermesClientError("operator unavailable", 503, "HERMES_OPERATOR_UNAVAILABLE");
    };
    const response = await mount(deletionDb(calls, false, false, true), owner, deps).request("/bot-1?purge=1&force=1", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).hostCleanup).toBe("queued");
    expect(calls.some((call) => call.startsWith("delete-profile:"))).toBe(false);
  });
});

describe("brouillon de persona d'un bot", () => {
  function draftDb(calls: Array<{ statement: string; values: unknown[] }>, busy = false): SQL {
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = [...strings].join(" ");
      calls.push({ statement, values });
      if (statement.includes('t.id as "threadId"') && statement.includes("for update of b")) {
        return Promise.resolve([{ id: "bot-1", name: "Scout", threadId: "thread-1" }]);
      }
      if (statement.includes("step_kind = 'persona_draft'") && statement.includes("status in")) {
        return Promise.resolve(busy ? [{ id: "run-9" }] : []);
      }
      if (statement.includes("hermes_session_id =")) {
        return Promise.resolve([{ id: "thread-draft-1" }]);
      }
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }

  test("insère le brouillon sur un fil dédié sans bloquer le fil principal", async () => {
    const calls: Array<{ statement: string; values: unknown[] }> = [];
    const response = await mount(draftDb(calls)).request("/bot-1/persona-drafts", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "queued", runId: expect.any(String), draft: null, hash: null });
    const thread = calls.find(({ statement }) => statement.includes("insert into threads"));
    expect(thread?.statement).toContain("is_default");
    expect(thread?.statement).toMatch(/, false\)/);
    expect(thread?.statement).toContain("on conflict (organization_id, hermes_session_id) do nothing");
    expect(thread?.values).toEqual(expect.arrayContaining(["org-1", "bot-1", "Scout", personaDraftSessionKey("org-1", "bot-1")]));
    const run = calls.find(({ statement }) => statement.includes("insert into runs") && statement.includes("persona_draft"));
    expect(run?.values).toContain("thread-draft-1");
    expect(run?.values).not.toContain("thread-1");
    expect(calls.some(({ statement }) => statement.includes("from runs") && statement.includes("thread_id =") && statement.includes("status in"))).toBe(false);
  });

  test("lit toujours le transcript sur le fil principal du bot", async () => {
    const calls: Array<{ statement: string; values: unknown[] }> = [];
    const response = await mount(draftDb(calls)).request("/bot-1/persona-drafts", { method: "POST" });
    expect(response.status).toBe(202);
    const history = calls.find(({ statement }) => statement.includes("select role, content from messages"));
    expect(history?.values).toContain("thread-1");
  });

  test("refuse un brouillon concurrent avec BOT_BUSY", async () => {
    const response = await mount(draftDb([], true)).request("/bot-1/persona-drafts", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "BOT_BUSY" } });
  });
});

describe("création atomique et rejouable (0135)", () => {
  const requestId = "3c3c3c3c-0000-4000-8000-000000000001";

  function creationDb(statements: string[], values: unknown[][], replay: { botId: string; deletedAt: Date | null } | null = null): SQL {
    const tx = ((strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = [...strings].join(" ");
      statements.push(sql);
      values.push(params);
      if (sql.includes("creation_request_id =")) return Promise.resolve(replay ? [replay] : []);
      if (sql.includes("select id from sections")) return Promise.resolve([{ id: "section-1" }]);
      if (sql.includes("coalesce(greatest(")) return Promise.resolve([{ next: 0 }]);
      if (sql.includes('t.id as "threadId"')) {
        return Promise.resolve([{ ...storedBotRow, archivedAt: null, deletedAt: null, permissionMode: "auto", label: "Recherche" }]);
      }
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }

  function deps(hostCalls: string[], runtime = true): BotRouteDeps {
    return {
      readRuntime: (async () => runtime ? {
        id: "runtime-1",
        name: "Hermes",
        capacity: 4,
        linkFeatures: [],
        client: {} as never,
        selectedProvider: null,
        selectedModel: null,
        reasoningEffort: null,
      } : null) as BotRouteDeps["readRuntime"],
      clientFactory: () => ({
        modelOptions: async () => { hostCalls.push("model-options"); return { providers: [] }; },
        probeProfileIsolation: async () => { hostCalls.push("probe"); return "isolated" as const; },
      }) as never,
    };
  }

  const post = (db: SQL, routeDeps: BotRouteDeps, body: Record<string, unknown>) => mount(db, owner, routeDeps).request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  test("les réglages de l'éditeur partent dans l'insert du bot, pas dans un PATCH", async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const response = await post(creationDb(statements, values), deps([]), {
      name: "Atlas",
      label: "Recherche",
      permissionMode: "auto",
      notifyOnFinish: false,
      replyLanguage: "fr",
      clientRequestId: requestId,
    });
    expect(response.status).toBe(201);
    const insert = statements.findIndex((sql) => sql.includes("insert into bots"));
    expect(statements[insert]).toContain("permission_mode");
    expect(statements[insert]).toContain("creation_request_id");
    expect(values[insert]).toContain("Recherche");
    expect(values[insert]).toContain("auto");
    expect(values[insert]).toContain("fr");
    expect(values[insert]).toContain(false);
    expect(values[insert]).toContain(requestId);
    expect(statements.some((sql) => sql.includes("update bots set"))).toBe(false);
  });

  test("un réglage invalide refuse toute la création, rien n'est écrit", async () => {
    const statements: string[] = [];
    const response = await post(creationDb(statements, []), deps([]), { name: "Atlas", permissionMode: "yolo" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "BOT_PERMISSION_MODE_INVALID" } });
    expect(statements.some((sql) => sql.includes("insert into bots"))).toBe(false);
  });

  test("un identifiant déjà servi rend le même bot en 200, sans insert ni appel hôte", async () => {
    const statements: string[] = [];
    const hostCalls: string[] = [];
    const response = await post(creationDb(statements, [], { botId: "bot-1", deletedAt: null }), deps(hostCalls), {
      name: "Atlas",
      hermesProfile: "atlas",
      clientRequestId: requestId,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; creationReplayed?: boolean };
    expect(body.id).toBe("bot-1");
    expect(body.creationReplayed).toBe(true);
    expect(statements.some((sql) => sql.includes("insert into bots"))).toBe(false);
    expect(hostCalls).toEqual([]);
  });

  test("le rejeu répond même si le runtime a disparu entre-temps", async () => {
    const response = await post(creationDb([], [], { botId: "bot-1", deletedAt: null }), deps([], false), {
      name: "Atlas",
      clientRequestId: requestId,
    });
    expect(response.status).toBe(200);
  });

  test("une demande dont le bot a été supprimé depuis est refusée, pas recréée", async () => {
    const statements: string[] = [];
    const response = await post(creationDb(statements, [], { botId: "bot-1", deletedAt: new Date("2026-10-01T00:00:00Z") }), deps([]), {
      name: "Atlas",
      clientRequestId: requestId,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "BOT_CREATION_REQUEST_CONSUMED" } });
    expect(statements.some((sql) => sql.includes("insert into bots"))).toBe(false);
  });

  test("the request id is bound to its body: same body replays, another body is refused (0136)", async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const body = { name: "Atlas", label: "Recherche", instructions: "# Atlas", clientRequestId: requestId };
    expect((await post(creationDb(statements, values), deps([]), body)).status).toBe(201);
    const insert = statements.findIndex((sql) => sql.includes("insert into bots"));
    expect(statements[insert]).toContain("creation_request_digest");
    const digest = values[insert]!.find((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) as string;
    expect(digest).toBeDefined();

    const stored = { botId: "bot-1", deletedAt: null, digest };
    // Same frozen request, keys in another order: the replay answers the first bot.
    const replayed = await post(creationDb([], [], stored), deps([]), {
      clientRequestId: requestId, instructions: "# Atlas", label: "Recherche", name: "Atlas",
    });
    expect(replayed.status).toBe(200);
    expect(((await replayed.json()) as { id: string }).id).toBe("bot-1");

    // The operator renamed the bot after a lost answer: never the old bot under the new name.
    const renamedStatements: string[] = [];
    const renamed = await post(creationDb(renamedStatements, [], stored), deps([]), { ...body, name: "Atlas bis" });
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toEqual({ error: { code: "BOT_CREATION_REQUEST_REUSED" } });
    expect(renamedStatements.some((sql) => sql.includes("insert into bots"))).toBe(false);
  });

  test("un identifiant qui n'est pas un UUID est refusé", async () => {
    const response = await post(creationDb([], []), deps([]), { name: "Atlas", clientRequestId: "1234" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "BOT_CREATE_REQUEST_ID_INVALID" } });
  });
});

describe("PERM2-8: the organization ceiling on bot mode writes", () => {
  function ceilingDb(ceiling: string | null, row: BotRow, statements: string[] = []): SQL {
    const tx = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      statements.push(sql);
      if (sql.includes("from organization_permission_policies")) {
        return Promise.resolve(ceiling === null ? [] : [{
          maxMode: ceiling, enforceReview: false, rulesMode: "adds", commandBlocklist: [], version: 1, updatedAt: new Date(0),
        }]);
      }
      if (sql.includes("update bots")) return Promise.resolve([{ id: row.id }]);
      if (sql.includes('t.id as "threadId"')) return Promise.resolve([row]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }
  const patch = (db: SQL, permissionMode: string) => mount(db).request("/bot-1", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode }),
  });
  const row = (permissionMode: BotRow["permissionMode"]): BotRow => ({ ...storedBotRow, archivedAt: null, deletedAt: null, permissionMode } as unknown as BotRow);

  test("PATCH refuses a raise above the ceiling before writing the bot", async () => {
    const statements: string[] = [];
    const response = await patch(ceilingDb("auto", row("manual"), statements), "bypass");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "PERMISSION_MODE_ABOVE_CEILING", details: { ceiling: "auto" } } });
    expect(statements.some((sql) => sql.includes("update bots"))).toBe(false);
  });

  test("PATCH allows plan, a mode under the ceiling, and lowering a bot already above it", async () => {
    expect((await patch(ceilingDb("manual", row("manual")), "plan")).status).toBe(200);
    expect((await patch(ceilingDb("auto", row("manual")), "auto")).status).toBe(200);
    expect((await patch(ceilingDb("manual", row("bypass")), "auto")).status).toBe(200);
  });

  test("POST refuses a creation above the ceiling before any runtime or host call", async () => {
    const statements: string[] = [];
    const response = await mount(ceilingDb("manual", row("manual"), statements)).request("/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Atlas", permissionMode: "auto" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "PERMISSION_MODE_ABOVE_CEILING" } });
    expect(statements.some((sql) => sql.includes("insert into bots") || sql.includes("from runtimes"))).toBe(false);
  });

  // PERM2-3 matrix: a member never writes a bot's mode, on PATCH or on creation,
  // and nothing is read or written before the role is refused.
  test("a member is refused on PATCH and on creation, before any statement", async () => {
    const member: AuthContext = { ...owner, role: "member" };
    for (const mode of ["manual", "plan", "auto", "bypass"]) {
      const statements: string[] = [];
      const response = await mount(ceilingDb(null, row("manual"), statements), member).request("/bot-1", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: mode }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ROLE_REQUIRED" } });
      expect(statements).toEqual([]);
    }
    const statements: string[] = [];
    const created = await mount(ceilingDb(null, row("manual"), statements), member).request("/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Atlas", permissionMode: "bypass" }),
    });
    expect(created.status).toBe(403);
    expect(statements).toEqual([]);
  });

  test("a mandated agency operator is held to the same ceiling as an owner", async () => {
    const agency: AuthContext = { ...owner, role: "agency" };
    const refused = await mount(ceilingDb("auto", row("manual")), agency).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "bypass" }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "PERMISSION_MODE_ABOVE_CEILING" } });
    const allowed = await mount(ceilingDb("bypass", row("manual")), agency).request("/bot-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "bypass" }),
    });
    expect(allowed.status).toBe(200);
  });

  test("without a policy row nothing is capped", async () => {
    expect((await patch(ceilingDb(null, row("manual")), "bypass")).status).toBe(200);
  });
});
