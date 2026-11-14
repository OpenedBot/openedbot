import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import {
  listDecisions,
  miscRoutes,
  readDecisionFilters,
  toDecisionDto,
  usageByModel,
  usageByBot,
  usageSeries,
} from "../src/routes/overview/misc-routes";

/** Fake SQL tag: records statements and bindings, returns fixtures. */
function fakeTx(rows: unknown[], statements: string[], bindings: unknown[][]): Bun.TransactionSQL {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push([...strings].join(" "));
    bindings.push(values);
    return Promise.resolve(rows);
  }) as unknown as Bun.TransactionSQL;
  return tag;
}

describe("usageSeries", () => {
  test("utilise le ledger métier partagé avec des périodes UTC", async () => {
    const statements: string[] = [];
    await usageSeries(fakeTx([], statements, []), "org-1", "day", 90);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("generate_series");
    expect(statements[0]).toContain("workspace_run_activity");
    expect(statements[0]).toContain("at time zone 'UTC'");
    expect(statements[0]).toContain("order by s.bucket");
  });

  test("passe l'organisation et l'unité en bindings, jamais par concaténation", async () => {
    const bindings: unknown[][] = [];
    await usageSeries(fakeTx([], [], bindings), "org-42", "month", 24);
    expect(bindings[0]).toContain("org-42");
    expect(bindings[0]).toContain("month");
    // 23 = buckets - 1, the bound of generate_series and of the range predicate.
    expect(bindings[0]).toContain(23);
  });

  test("coerce les bigint-string du driver en number et neutralise les null", async () => {
    const rows = [
      { date: "2026-08-01", inputTokens: "1234", outputTokens: "56", totalTokens: "1290" },
      { date: "2026-08-02", inputTokens: null, outputTokens: null, totalTokens: null },
    ];
    const series = await usageSeries(fakeTx(rows, [], []), "org-1", "day", 2);
    expect(series).toEqual([
      { date: "2026-08-01", inputTokens: 1234, outputTokens: 56, totalTokens: 1290 },
      { date: "2026-08-02", inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ]);
  });
});

describe("usageByModel", () => {
  test("pose la plage sur coalesce(ended_at, created_at) et groupe par modèle", async () => {
    const statements: string[] = [];
    await usageByModel(fakeTx([], statements, []), "org-1");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("coalesce(ended_at, created_at) >=");
    expect(statements[0]).toContain("group by 1");
    expect(statements[0]).toContain("status in ('completed', 'failed')");
  });

  test("passe l'organisation et la fenêtre en bindings", async () => {
    const bindings: unknown[][] = [];
    await usageByModel(fakeTx([], [], bindings), "org-42", 30);
    expect(bindings[0]).toContain("org-42");
    expect(bindings[0]).toContain(30);
  });

  test("coerce les bigint et mappe le modèle vide vers null", async () => {
    const lastAt = new Date("2026-08-31T12:00:00.000Z");
    const rows = [
      { model: "gpt-5.6-luna", runs: "12", inputTokens: "40000", outputTokens: "8000", tokens: "48000", lastAt },
      { model: "", runs: "3", inputTokens: "0", outputTokens: "0", tokens: "0", lastAt },
      { model: null, runs: 1, inputTokens: null, outputTokens: null, tokens: null, lastAt: "2026-08-20T10:00:00.000Z" },
    ];
    const usage = await usageByModel(fakeTx(rows, [], []), "org-1");
    expect(usage).toEqual({
      windowDays: 90,
      models: [
        { model: "gpt-5.6-luna", runs: 12, inputTokens: 40000, outputTokens: 8000, tokens: 48000, lastAt: "2026-08-31T12:00:00.000Z" },
        { model: null, runs: 3, inputTokens: 0, outputTokens: 0, tokens: 0, lastAt: "2026-08-31T12:00:00.000Z" },
        { model: null, runs: 1, inputTokens: 0, outputTokens: 0, tokens: 0, lastAt: "2026-08-20T10:00:00.000Z" },
      ],
    });
  });
});

describe("usageByBot", () => {
  test("part des bots, garde ceux à zéro et borne les runs à la fenêtre achevée", async () => {
    const statements: string[] = [];
    await usageByBot(fakeTx([], statements, []), "org-1", 7);
    expect(statements[0]).toContain("from bots b");
    expect(statements[0]).toContain("left join runs r");
    expect(statements[0]).toContain("r.status in ('completed', 'failed')");
    expect(statements[0]).toContain("coalesce(r.ended_at, r.created_at) >=");
    expect(statements[0]).toContain("b.archived_at is null");
  });

  test("normalise bigint, modèle courant et bot sans activité", async () => {
    const rows = [{
      botId: "bot-1", name: "Atlas", slug: "atlas", model: "gpt-5", lastModel: "gpt-5",
      runs: "2", inputTokens: "12", outputTokens: "34", tokens: "46", lastAt: new Date("2026-09-02T10:00:00Z"),
    }, {
      botId: "bot-2", name: "Béa", slug: "bea", model: null, lastModel: null,
      runs: "0", inputTokens: "0", outputTokens: "0", tokens: "0", lastAt: null,
    }];
    await expect(usageByBot(fakeTx(rows, [], []), "org-1", 7)).resolves.toEqual({
      windowDays: 7,
      bots: [
        { botId: "bot-1", name: "Atlas", slug: "atlas", model: "gpt-5", lastModel: "gpt-5", runs: 2, inputTokens: 12, outputTokens: 34, tokens: 46, lastAt: "2026-09-02T10:00:00.000Z" },
        { botId: "bot-2", name: "Béa", slug: "bea", model: null, lastModel: null, runs: 0, inputTokens: 0, outputTokens: 0, tokens: 0, lastAt: null },
      ],
    });
  });
});

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

function fakeDecisionDb(rows: unknown[]) {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    statements.push(sql);
    bindings.push(values);
    if (!sql.includes("with entries")) return Promise.resolve(rows);
    const origin = values.find((value): value is string => value === "human" || value === "policy");
    const filtered = origin ? rows.filter((row) => (row as { origin?: string }).origin === origin) : rows;
    return Promise.resolve([...filtered].sort((left, right) =>
      new Date(String((right as { issuedAt: Date | string }).issuedAt)).getTime()
      - new Date(String((left as { issuedAt: Date | string }).issuedAt)).getTime()));
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return { db: tx, statements, bindings };
}

function mountDecisions(db: SQL) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", owner);
    await next();
  });
  app.onError((error, context) =>
    error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED" } }, 500),
  );
  app.route("/", miscRoutes(db, { environment: "test" }));
  return app;
}

/** Fake privileged connection for the `scope: "full"` wipe. */
function fakeResetDb(truncated: string[], onClose: () => void): SQL {
  const queues: unknown[][] = [[{ name: "bots" }], [], [], []];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings;
    void values;
    return Promise.resolve(queues.shift() ?? []);
  };
  const fake = Object.assign(tag, {
    unsafe: (text: string) => {
      truncated.push(text);
      return Promise.resolve([]);
    },
    begin: (callback: (tx: SQL) => Promise<unknown>) => callback(fake as unknown as SQL),
    close: () => {
      onClose();
      return Promise.resolve();
    },
  }) as unknown as SQL;
  return fake;
}

function mountOnboarding(
  rows: unknown[],
  environment: "development" | "test" | "production",
  devReset?: { devResetDatabaseUrl?: string | null; openDevResetDb?: (url: string) => SQL },
) {
  const fake = fakeDecisionDb(rows);
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", owner);
    await next();
  });
  app.onError((error, context) =>
    error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED" } }, 500),
  );
  app.route("/", miscRoutes(fake.db, { environment, ...devReset }));
  return { app, statements: fake.statements, bindings: fake.bindings };
}

function mountUsageBots(role: AuthContext["role"]) {
  const fake = fakeDecisionDb([]);
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", { ...owner, role });
    await next();
  });
  app.onError((error, context) =>
    error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED" } }, 500),
  );
  app.route("/", miscRoutes(fake.db, { environment: "test" }));
  return { app, statements: fake.statements };
}

describe("GET /usage/bots", () => {
  test("refuse un membre avant d'ouvrir la transaction RLS", async () => {
    const { app, statements } = mountUsageBots("member");
    const response = await app.request("/usage/bots?days=7");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "ROLE_REQUIRED" } });
    expect(statements).toEqual([]);
  });
});

describe("GET /usage/models", () => {
  test("sans `days`, garde la fenêtre historique de 90 jours", async () => {
    const { app } = mountUsageBots("owner");
    const response = await app.request("/usage/models");
    expect(response.status).toBe(200);
    expect((await response.json()).windowDays).toBe(90);
  });

  test("prend une fenêtre de 1 à 90 jours et refuse le reste sans ouvrir de transaction", async () => {
    const { app } = mountUsageBots("owner");
    expect((await (await app.request("/usage/models?days=1")).json()).windowDays).toBe(1);
    for (const days of ["0", "91", "abc", "1.5", ""]) {
      const refused = mountUsageBots("owner");
      const response = await refused.app.request(`/usage/models?days=${days}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "USAGE_DAYS_INVALID" } });
      expect(refused.statements).toEqual([]);
    }
  });
});

const onboardedWorkspace = {
  onboarding: { completionPath: "full" },
  name: "Dev",
  onboardedAt: new Date("2026-08-01T10:00:00.000Z"),
  completed: false,
};

describe("GET /onboarding", () => {
  test("expose `completed`, le flag de la PERSONNE, à côté de la sortie datée de l'espace", async () => {
    const { app, statements, bindings } = mountOnboarding([onboardedWorkspace], "test");
    const response = await app.request("/onboarding");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.completed).toBe(false);
    expect(body.onboardedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(body.completionPath).toBe("full");
    const read = statements.find((statement) => statement.includes("u.onboarding_completed as completed"));
    expect(read).toBeDefined();
    expect(bindings[statements.indexOf(read!)]).toEqual(["user-1", "org-1"]);
  });

  test("`completed` est un booléen strict : un utilisateur introuvable vaut false", async () => {
    const { app } = mountOnboarding([{ ...onboardedWorkspace, completed: null }], "test");
    const body = await (await app.request("/onboarding")).json();
    expect(body.completed).toBe(false);
  });
});

describe("PATCH /onboarding", () => {
  test("le nom d'espace saisi renomme l'ORGANISATION, dans la même instruction que le jsonb", async () => {
    const { app, statements, bindings } = mountOnboarding([onboardedWorkspace], "test");
    const response = await app.request("/onboarding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "  Atelier Acme  " }),
    });
    expect(response.status).toBe(200);
    const update = statements.find((statement) => statement.includes("update organizations set onboarding"));
    expect(update).toBeDefined();
    expect(update).toContain("name = coalesce(");
    // The name leaves TRIMMED for both destinations: the jsonb and the column.
    const values = bindings[statements.indexOf(update!)]!;
    expect(values[0]).toEqual({ workspaceName: "Atelier Acme" });
    expect(values[1]).toBe("Atelier Acme");
  });

  test("un corps sans nom d'espace ne touche pas le nom de l'organisation", async () => {
    const { app, statements, bindings } = mountOnboarding([onboardedWorkspace], "test");
    const response = await app.request("/onboarding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionnaire: { role: "founder" } }),
    });
    expect(response.status).toBe(200);
    const update = statements.find((statement) => statement.includes("update organizations set onboarding"))!;
    // `coalesce(null, name)`: the column keeps its value, with no extra statement.
    expect(bindings[statements.indexOf(update)]![1]).toBeNull();
  });

  test("refuse un nom d'espace au-delà de la borne du signup plutôt que de laisser diverger jsonb et colonne", async () => {
    const { app, statements } = mountOnboarding([onboardedWorkspace], "test");
    const response = await app.request("/onboarding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "x".repeat(81) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "VALIDATION_ERROR" } });
    expect(statements).toEqual([]);
  });

  test("un nom d'espace vide est refusé : l'organisation ne peut pas perdre son nom", async () => {
    const { app, statements } = mountOnboarding([onboardedWorkspace], "test");
    const response = await app.request("/onboarding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "   " }),
    });
    expect(response.status).toBe(400);
    expect(statements).toEqual([]);
  });
});

describe("POST /onboarding/complete", () => {
  test("pose le flag de la personne en plus de la sortie de l'espace", async () => {
    const { app, statements, bindings } = mountOnboarding([{ ...onboardedWorkspace, completed: true }], "test");
    const response = await app.request("/onboarding/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "full" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).completed).toBe(true);
    const userUpdate = statements.find((statement) => statement.includes("update users set onboarding_completed = true"));
    expect(userUpdate).toBeDefined();
    expect(bindings[statements.indexOf(userUpdate!)]).toEqual(["user-1"]);
    expect(statements.some((statement) => statement.includes("onboarded_at = coalesce(onboarded_at, now())"))).toBe(true);
  });
});

describe("POST /onboarding/reset", () => {
  test("en development : remet le flag de la personne et la sortie de l'espace à zéro", async () => {
    const { app, statements, bindings } = mountOnboarding([onboardedWorkspace], "development");
    const response = await app.request("/onboarding/reset", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).completed).toBe(false);
    const userReset = statements.find((statement) => statement.includes("update users set onboarding_completed = false"));
    expect(userReset).toBeDefined();
    expect(bindings[statements.indexOf(userReset!)]).toEqual(["user-1"]);
    const workspaceReset = statements.find((statement) =>
      statement.includes("update organizations set onboarded_at = null, onboarding = null"),
    );
    expect(workspaceReset).toBeDefined();
    expect(bindings[statements.indexOf(workspaceReset!)]).toEqual(["org-1"]);
  });

  test("un corps absent ou `{\"scope\":\"flag\"}` garde le comportement historique, sans vidage", async () => {
    for (const init of [{}, { headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "flag" }) }]) {
      const opened: string[] = [];
      const { app, statements } = mountOnboarding([onboardedWorkspace], "development", {
        devResetDatabaseUrl: "postgres://owner:secret@127.0.0.1:5432/openedbot",
        openDevResetDb: (url) => {
          opened.push(url);
          return {} as never;
        },
      });
      const response = await app.request("/onboarding/reset", { method: "POST", ...init });
      expect(response.status).toBe(200);
      expect(opened).toEqual([]);
      expect(statements.some((statement) => statement.includes("update users set onboarding_completed = false"))).toBe(true);
    }
  });

  test("`{\"scope\":\"full\"}` vide par la connexion privilégiée, jamais par le rôle applicatif", async () => {
    const opened: string[] = [];
    const truncated: string[] = [];
    let closed = false;
    const { app, statements } = mountOnboarding([onboardedWorkspace], "development", {
      devResetDatabaseUrl: "postgres://owner:secret@127.0.0.1:5432/openedbot",
      openDevResetDb: (url) => {
        opened.push(url);
        return fakeResetDb(truncated, () => {
          closed = true;
        });
      },
    });
    const response = await app.request("/onboarding/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "full" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).completed).toBe(false);
    expect(opened).toEqual(["postgres://owner:secret@127.0.0.1:5432/openedbot"]);
    expect(truncated).toEqual(['truncate table "bots" restart identity cascade']);
    expect(closed).toBe(true);
    expect(statements.some((statement) => statement.includes("organizationReset"))).toBe(true);
    // The application role only rereads the state: no truncate through `db`.
    expect(statements.some((statement) => statement.includes("truncate"))).toBe(false);
  });

  test("sans DSN propriétaire, `full` répond 503 et renvoie vers la cible make, sans rien vider", async () => {
    const { app, statements } = mountOnboarding([onboardedWorkspace], "development", { devResetDatabaseUrl: null });
    const response = await app.request("/onboarding/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "full" }),
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("DEV_RESET_UNAVAILABLE");
    expect(statements).toEqual([]);
  });

  test("une portée inconnue est refusée avant toute écriture", async () => {
    const { app, statements } = mountOnboarding([onboardedWorkspace], "development");
    const response = await app.request("/onboarding/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "everything" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_RESET_SCOPE");
    expect(statements).toEqual([]);
  });

  test("hors development la route n'est pas montée : 404, et rien n'est écrit", async () => {
    for (const environment of ["test", "production"] as const) {
      const { app, statements } = mountOnboarding([onboardedWorkspace], environment);
      const response = await app.request("/onboarding/reset", { method: "POST" });
      expect(response.status).toBe(404);
      expect(statements).toEqual([]);
    }
  });
});

describe("readDecisionFilters", () => {
  test("n'accepte que once/deny et un UUID de bot", () => {
    expect(readDecisionFilters({ choice: "once", botId: "71000000-0000-4000-8000-000000000021" })).toEqual({
      choice: "once",
      botId: "71000000-0000-4000-8000-000000000021",
      origin: undefined,
    });
    expect(readDecisionFilters({ choice: "always", botId: "not-a-uuid" })).toEqual({
      choice: undefined,
      botId: undefined,
      origin: undefined,
    });
  });
});

describe("toDecisionDto", () => {
  test("projette issuedAt, bot, action et type : jamais les colonnes brutes du journal", () => {
    expect(toDecisionDto({
      id: "d1",
      runId: "run-1",
      botId: "bot-1",
      botName: "Atlas",
      action: "touch /tmp/x",
      kind: null,
      choice: "deny",
      origin: "human",
      policy: null,
      approverUserId: "user-1",
      approverRole: "owner",
      previousHash: "previous",
      entryHash: "abc",
      chainSequence: 3,
      issuedAt: new Date("2026-08-31T12:00:00.000Z"),
    })).toEqual({
      id: "d1",
      runId: "run-1",
      botId: "bot-1",
      botName: "Atlas",
      action: "touch /tmp/x",
      kind: "shell",
      choice: "deny",
      origin: "human",
      policy: null,
      approverUserId: "user-1",
      approverRole: "owner",
      entryHash: "abc",
      issuedAt: "2026-08-31T12:00:00.000Z",
      trace: null,
    });
  });

  test("PERM2-11: a policy answer given by a grant carries the grant and its author, in closed sets", () => {
    const decision = toDecisionDto({
      id: "a1", runId: "run-1", botId: "bot-1", botName: "Atlas", action: "write_file notes.md", kind: "shell",
      choice: "once", origin: "policy", policy: "auto", approverUserId: null, approverRole: "",
      previousHash: null, entryHash: null, chainSequence: null, issuedAt: new Date("2026-08-31T12:00:00.000Z"),
      traceStage: "grant", decidedByKind: "policy", traceReason: "grant", grantKind: "bot_tool",
      grantAuthorName: "Camille Lefèvre", grantAuthorKind: "member", grantFromAlways: true,
      grantCreatedAt: "2026-08-30T08:00:00.000Z", grantRevoked: false,
    });
    expect(decision.trace).toEqual({
      stage: "grant", decidedBy: "policy", deciderName: null, reason: "grant", heldBy: null,
      grant: { kind: "bot_tool", authorName: "Camille Lefèvre", authorKind: "member", fromAlways: true, createdAt: "2026-08-30T08:00:00.000Z", revoked: false },
      always: null, humanOverridden: null, policyChanged: false,
    });
  });

  test("PERM2-11: a policy mode outside the closed set of 0138 is not shown", () => {
    const decision = toDecisionDto({
      id: "a1", runId: "run-1", botId: "bot-1", botName: "Atlas", action: "", kind: "shell",
      choice: "deny", origin: "policy", policy: "root", approverUserId: null, approverRole: "",
      previousHash: null, entryHash: null, chainSequence: null, issuedAt: new Date("2026-08-31T12:00:00.000Z"),
    });
    expect(decision.policy).toBeNull();
  });
});

describe("listDecisions", () => {
  test("joint bot, commande d'approbation et type, et honore les filtres", async () => {
    const statements: string[] = [];
    const bindings: unknown[][] = [];
    const issuedAt = new Date("2026-08-31T12:00:00.000Z");
    const rows = [{
      id: "d1",
      runId: "run-1",
      botId: "bot-1",
      botName: "Atlas",
      action: "touch /tmp/x",
      kind: "shell",
      choice: "once",
      origin: "human",
      policy: null,
      approverUserId: "user-1",
      approverRole: "owner",
      previousHash: "previous",
      entryHash: "hash",
      chainSequence: 4,
      issuedAt,
    }];
    const decisions = await listDecisions(
      fakeTx(rows, statements, bindings),
      "org-1",
      { botId: "bot-1", choice: "once" },
    );
    expect(statements[0]).toContain("left join bots b");
    expect(statements[0]).toContain("left join approval_requests a");
    expect(statements[0]).toContain("else coalesce(nullif(a.command, ''), nullif(d.envelope->>'action', ''), '') end as action");
    // A routine_manage decision shows the sentence its decider read, kept in the signed envelope.
    expect(statements[0]).toMatch(/case when a\.tool_key =\s+then coalesce\(nullif\(d\.envelope->>'action', ''\), a\.command, ''\)/);
    expect(bindings[0]).toContain("mcp:openedbot_routines:routine_manage");
    expect(statements[0]).toContain("as \"botName\"");
    expect(statements[0]).toContain("as kind");
    expect(bindings[0]).toContain("org-1");
    expect(bindings[0]).toContain("bot-1");
    expect(bindings[0]).toContain("once");
    expect(decisions).toEqual([{
      id: "d1",
      runId: "run-1",
      botId: "bot-1",
      botName: "Atlas",
      action: "touch /tmp/x",
      kind: "shell",
      choice: "once",
      origin: "human",
      policy: null,
      approverUserId: "user-1",
      approverRole: "owner",
      entryHash: "hash",
      issuedAt: "2026-08-31T12:00:00.000Z",
      trace: null,
    }]);
  });

  test("PERM2-11: the trace reads named keys of decision_detail, never the object, and the grant of the answer", async () => {
    const statements: string[] = [];
    await listDecisions(fakeTx([], statements, []), "org-1");
    const sql = statements[0] ?? "";
    expect(sql).toContain("a.decision_detail->>'reason' as \"traceReason\"");
    expect(sql).toContain("from bot_permission_grants g");
    expect(sql).toContain("from runtime_permission_settings s");
    expect(sql).toContain("g.organization_id = a.organization_id");
    // Never the whole detail, the gate arguments, the description or the reviewer's words.
    expect(sql).not.toMatch(/decision_detail\s+as|decision_detail\s*,|gate_args|description|reviewerReason/);
  });
});

describe("GET /decisions", () => {
  const human = {
    id: "d1",
    runId: "run-1",
    botId: "bot-1",
    botName: "Atlas",
    action: "touch /tmp/x",
    kind: "shell",
    choice: "once",
    origin: "human",
    policy: null,
    approverUserId: "user-1",
    approverRole: "owner",
    previousHash: "previous",
    entryHash: "hash",
    chainSequence: 4,
    issuedAt: new Date("2026-08-31T12:00:00.000Z"),
  } as const;
  const policy = {
    id: "a1",
    runId: "run-2",
    botId: "bot-1",
    botName: "Atlas",
    action: "touch /tmp/policy",
    kind: "shell",
    choice: "once",
    origin: "policy",
    policy: "auto",
    approverUserId: null,
    approverRole: "",
    previousHash: null,
    entryHash: null,
    chainSequence: null,
    issuedAt: new Date("2026-08-31T12:01:00.000Z"),
  } as const;

  test("renvoie les décisions humaines et les résolutions de politique", async () => {
    const { db } = fakeDecisionDb([human, policy]);
    const response = await mountDecisions(db).request("/decisions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decisions: [
      { ...toDecisionDto(policy), issuedAt: "2026-08-31T12:01:00.000Z" },
      { ...toDecisionDto(human), issuedAt: "2026-08-31T12:00:00.000Z" },
    ] });
  });

  test("filtre l'origine humaine", async () => {
    const { db } = fakeDecisionDb([human, policy]);
    const response = await mountDecisions(db).request("/decisions?origin=human");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decisions: [{ ...toDecisionDto(human), issuedAt: "2026-08-31T12:00:00.000Z" }] });
  });

  test("exporte l'origine et les maillons de chaîne humains en JSONL", async () => {
    const { db } = fakeDecisionDb([human, policy]);
    const response = await mountDecisions(db).request("/decisions/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("content-disposition")).toContain("decisions.jsonl");
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ origin: "policy", policy: "auto", entryHash: null });
    expect(lines[0]).not.toHaveProperty("previousHash");
    expect(lines[1]).toMatchObject({ origin: "human", entryHash: "hash", previousHash: "previous", chainSequence: 4 });
  });
});
