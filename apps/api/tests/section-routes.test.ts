import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { sectionRoutes } from "../src/routes/roster/bot-routes";
import { HttpError } from "../src/interfaces/http/http-error";

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

function mount(db: SQL): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", owner);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", sectionRoutes(db));
  return app;
}

/** Les sections de l'organisation, par rang : `sec-default` est la première. */
function sectionsDb(calls: Array<{ sql: string; values: unknown[] }>, currentPosition = 2): SQL {
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?");
    calls.push({ sql, values });
    if (sql.includes("select id from sections")) {
      return Promise.resolve([{ id: "sec-default" }, { id: "sec-a" }, { id: "sec-b" }]);
    }
    if (sql.includes("select position from sections")) return Promise.resolve([{ position: currentPosition }]);
    if (sql.includes("returning id, name, position, collapsed, context")) {
      return Promise.resolve([{ id: "sec-b", name: "Shipper", position: 1, collapsed: false, context: "" }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

describe("sections : supprimer", () => {
  test("la section par défaut (première par rang) ne se supprime pas", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(sectionsDb(calls)).request("/sec-default", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "SECTION_IS_DEFAULT" } });
    expect(calls.some((call) => call.sql.includes("delete from sections"))).toBe(false);
  });

  test("les bots et les salons rejoignent la section par défaut avant l'effacement", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(sectionsDb(calls)).request("/sec-b", { method: "DELETE" });

    expect(response.status).toBe(204);
    const bots = calls.findIndex((call) => call.sql.includes("update bots set section_id"));
    const groups = calls.findIndex((call) => call.sql.includes("update bot_groups set section_id"));
    // `team_imports.section_id` référence la section sans `on delete` : sans
    // ce rapatriement, supprimer une section qui a reçu un import cassait en
    // 23503 : l'« Erreur interne » vue en recette.
    const imports = calls.findIndex((call) => call.sql.includes("update team_imports set section_id"));
    const deletion = calls.findIndex((call) => call.sql.includes("delete from sections"));
    expect(bots).toBeGreaterThan(-1);
    expect(groups).toBeGreaterThan(bots);
    expect(imports).toBeGreaterThan(groups);
    expect(deletion).toBeGreaterThan(imports);
    expect(calls[bots]?.values).toEqual(["sec-default", "org-1", "sec-b"]);
    expect(calls[groups]?.values).toEqual(["sec-default", "org-1", "sec-b"]);
    expect(calls[imports]?.values).toEqual(["sec-default", "org-1", "sec-b"]);
  });
});

describe("sections : ordre", () => {
  const BOT = "11111111-2222-4333-8444-555555555551";
  const GROUP = "11111111-2222-4333-8444-555555555552";

  test("chaque ligne citée rejoint la section à son index, bots et salons entrelacés", async () => {
    const SEC = "11111111-2222-4333-8444-555555555550";
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join("?");
      calls.push({ sql, values });
      if (sql.includes("select id from sections")) return Promise.resolve([{ id: SEC }]);
      if (sql.includes("returning id")) return Promise.resolve([{ id: values[3] }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);

    const response = await mount(tx).request(`/${SEC}/order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: [{ kind: "group", id: GROUP }, { kind: "bot", id: BOT }] }),
    });
    expect(response.status).toBe(204);
    // Après l'écriture, les sections restées vides disparaissent : la
    // requête épargne la section par défaut et exige ni bot ni salon.
    const prune = calls.find((call) => call.sql.includes("select s.id from sections s"));
    expect(prune?.sql).toContain("order by position asc limit 1");
    expect(prune?.sql).toContain("not exists (select 1 from bots b");
    expect(prune?.sql).toContain("not exists (select 1 from bot_groups g");
    const updates = calls.filter((call) => call.sql.includes("returning id") && !call.sql.includes("select s.id"));
    expect(updates.map((call) => [call.sql.includes("update bot_groups") ? "group" : "bot", ...call.values])).toEqual([
      ["group", SEC, 0, "org-1", GROUP],
      ["bot", SEC, 1, "org-1", BOT],
    ]);
  });

  test("un ordre sans uuid, avec doublon ou d'un genre inconnu est refusé", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    for (const order of [[{ kind: "bot", id: "" }], [{ kind: "bot", id: BOT }, { kind: "bot", id: BOT }], [{ kind: "thing", id: BOT }]]) {
      const response = await mount(sectionsDb(calls)).request(`/${BOT}/order`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order }),
      });
      expect(response.status).toBe(400);
    }
    expect(calls.some((call) => call.sql.includes("update bots"))).toBe(false);
  });
});

describe("sections : créer", () => {
  test("la création prend le verrou d'organisation avant de lire max(position)", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(sectionsDb(calls)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Shipper" }),
    });

    expect(response.status).toBe(201);
    const lock = calls.findIndex((call) => call.sql.includes("pg_advisory_xact_lock"));
    const insert = calls.findIndex((call) => call.sql.includes("insert into sections"));
    expect(lock).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(lock);
    expect(calls[lock]?.values).toEqual(["org-1"]);
  });
});

describe("sections : réordonner", () => {
  test("changer de rang échange avec la section qui l'occupe, via un rang temporaire", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(sectionsDb(calls, 2)).request("/sec-b", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ position: 1 }),
    });

    expect(response.status).toBe(200);
    const updates = calls.filter((call) => call.sql.includes("update sections set position"));
    expect(updates.map((call) => call.values)).toEqual([
      ["org-1", 1],
      [1, "org-1", "sec-b"],
      [2, "org-1"],
    ]);
    // Aucun `position = coalesce(...)` : le rang ne se pose jamais en dehors de l'échange.
    const final = calls.find((call) => call.sql.includes("returning id, name, position, collapsed, context"));
    expect(final?.sql).not.toContain("position = coalesce");
  });

  test("un rang identique au rang courant ne touche à rien", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const response = await mount(sectionsDb(calls, 1)).request("/sec-b", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ position: 1, name: "Shipper" }),
    });

    expect(response.status).toBe(200);
    expect(calls.some((call) => call.sql.includes("update sections set position"))).toBe(false);
  });
});
