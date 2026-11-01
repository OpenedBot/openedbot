import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import {
  isGlobalSearchSchemaMissing,
  readGlobalSearchLimit,
  readGlobalSearchQuery,
  searchRoutes,
} from "../src/routes/conversation/search-routes";

const auth: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "member",
  kind: "web",
  credentialHash: "credential",
};

function mount(db: SQL) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", searchRoutes(db));
  return app;
}

function searchDb(input: { missing?: boolean } = {}) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    statements.push(sql);
    parameters.push(values);
    if (sql.includes("select id, name, slug, face from bots")) {
      return Promise.resolve([{ id: "bot-neo", name: "Neo", slug: "neo", face: null }]);
    }
    if (sql.includes("from operator_profiles")) {
      return Promise.resolve([{ username: "elodie", updatedAt: "2026-08-26T09:00:00.000Z" }]);
    }
    if (sql.includes("with search_query as")) {
      if (input.missing) return Promise.reject(Object.assign(
        new Error("function public.ohb_global_search_normalize(text) does not exist"),
        { errno: "42883" },
      ));
      return Promise.resolve([
        {
          kind: "message", threadId: "thread-neo", messageId: "message-1", role: "assistant",
          content: [{ type: "text", text: "Résultat public sur Mars\n@neo SECRET_HANDOFF" }],
          botSlug: "neo", groupId: null, conversationName: "Neo", authorName: "Neo",
          searchText: "Résultat public sur Mars @neo SECRET_HANDOFF",
          occurredAt: "2026-08-26T10:00:00.000Z",
        },
      ]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tag as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (tx: SQL) => unknown) => callback(tag);
  return { db: tag, statements, parameters };
}

describe("global search route", () => {
  test("bounds query and result count", () => {
    expect(readGlobalSearchQuery("  mars  ")).toBe("mars");
    expect(readGlobalSearchLimit(undefined)).toBe(12);
    expect(readGlobalSearchLimit("40")).toBe(40);
    expect(() => readGlobalSearchLimit("0")).toThrow(HttpError);
    expect(() => readGlobalSearchLimit("41")).toThrow(HttpError);
    expect(() => readGlobalSearchQuery("x".repeat(201))).toThrow(HttpError);
  });

  test("is tenant/member scoped, bounded to mounted messages, and returns only public text", async () => {
    const fixture = searchDb();
    const response = await mount(fixture.db).request("/search?q=Mars&limit=5");
    expect(response.status).toBe(200);
    const body = await response.json() as { hits: Array<Record<string, unknown>> };
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({
      threadId: "thread-neo",
      targetId: "message:message-1",
      botSlug: "neo",
      snippet: "Résultat public sur Mars",
    });
    expect(JSON.stringify(body)).not.toContain("SECRET_HANDOFF");
    const sql = fixture.statements.find((statement) => statement.includes("with search_query as")) ?? "";
    expect(sql).toContain("message.organization_id =");
    expect(sql).toContain("hidden.user_id =");
    expect(sql).toContain("not like '%:persona-draft:%'");
    expect(sql).toContain("counter.next_sequence -");
    expect(sql).toContain("ohb_visible_message_search_text");
    expect(sql).toContain("plainto_tsquery");
    expect(sql).toContain("public.ohb_global_search_normalize");
    const operatorSql = fixture.statements.find((statement) => statement.includes("from operator_profiles")) ?? "";
    expect(operatorSql).toContain("where organization_id =");
    expect(operatorSql).not.toContain("user_id");
    expect(fixture.parameters.flat()).toContain("org-1");
    expect(fixture.parameters.flat()).toContain("user-1");
  });

  test("empty search does not touch the database", async () => {
    let calls = 0;
    const db = (() => {
      calls += 1;
      return Promise.resolve([]);
    }) as unknown as SQL;
    const response = await mount(db).request("/search?q=%20%20");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hits: [] });
    expect(calls).toBe(0);
  });

  test("missing indexed-search migration is explicit", async () => {
    for (const functionName of ["ohb_visible_message_search_text", "ohb_global_search_normalize"]) {
      const error = Object.assign(
        new Error(`function public.${functionName}(text) does not exist`),
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "42883" },
      );
      expect(isGlobalSearchSchemaMissing(error)).toBe(true);
    }
    const response = await mount(searchDb({ missing: true }).db).request("/search?q=mars");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "DATABASE_MIGRATION_REQUIRED" } });
  });

  test("schema keeps one immutable normalized allow-list for index and query", async () => {
    const sql = await Bun.file(
      new URL("../../../db/migrations/0006_messaging_search.sql", import.meta.url),
    ).text();
    expect(sql).toContain("create or replace function public.ohb_global_search_normalize(input text)");
    expect(sql).toContain("immutable");
    expect(sql).toContain("NFKD");
    expect(sql).toContain("U&'[\\0300-\\036f]' collate \"C\"");
    expect(sql).toContain("replace(replace(input, 'Œ', 'oe'), 'œ', 'oe')");
    expect(sql).toContain("'Æ', 'ae'), 'æ', 'ae'");
    expect(sql.toLowerCase()).not.toContain("unaccent");
    const asciiFold = /'ABCDEFGHIJKLMNOPQRSTUVWXYZÐð',\s*'([^']+)'/u.exec(sql);
    expect(asciiFold?.[1]).toBe("abcdefghijklmnopqrstuvwxyzdd");
    expect([..."ABCDEFGHIJKLMNOPQRSTUVWXYZÐð"]).toHaveLength([...(asciiFold?.[1] ?? "")].length);
    expect(sql).toContain("when part.value->>'type' = 'text'");
    expect(sql).toContain("when part.value->>'type' = 'attachment'");
    expect(sql).not.toContain("part.value->>'args'");
    expect(sql).toContain("public.ohb_global_search_normalize(coalesce(string_agg(");
    // Les index GIN portent leurs noms finaux et indexent la projection
    // normalisée : messages via l'allow-list, threads via le titre normalisé.
    expect(sql).toContain("create index messages_global_search_idx");
    expect(sql).toContain("create index threads_global_search_idx");
    expect(sql).toMatch(/create index messages_global_search_idx\s+on messages using gin \(\s*to_tsvector\('simple'::regconfig, public\.ohb_visible_message_search_text\(content\)\)/u);
    expect(sql).toMatch(/create index threads_global_search_idx\s+on threads using gin \(\s*to_tsvector\(\s*'simple'::regconfig,\s*public\.ohb_global_search_normalize\(coalesce\(title, ''\)\)/u);
  });
});
