import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SQL } from "bun";
import { Hono } from "hono";
import { accessLogMiddleware } from "@openedbot/platform-observability";
import { unhandledErrorBody } from "../src/interfaces/http/unhandled-error";
import {
  createUnhandledErrorJournal,
  redactRequestPath,
  respondToUnhandledError,
  unhandledErrorJournalWriter,
  type UnhandledErrorJournal,
  type UnhandledErrorRecord,
} from "../src/interfaces/http/unhandled-error-journal";

/**
 * The durable journal of 500s (0161) without PostgreSQL: the same body and the same
 * status as before, a row keyed by the body's reference, nothing of what
 * the caller sent, and a write that can neither break nor hold back the
 * response. Real RLS is proved by `make db-migrate` on the local database.
 */

const ORG = "10000000-0000-4000-8000-000000000001";
const USER = "10000000-0000-4000-8000-000000000002";
const THREAD = "20000000-0000-4000-8000-000000000003";
const LINK_TOKEN = "Zq3v9XlYk2Rr7TtUuPpWwAaBbCcDdEeFfGg_hh-ii";
const SECRETS = ["sk-live-SUPERSECRET123456", "cookie-value-42", "Bearer eyJhbGciOi", "query-secret-77", "body-secret-99", LINK_TOKEN];

type Call = { text: string; values: unknown[] };

function fakeDb(calls: Call[], fail?: Error): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: [...strings].join("?").replace(/\s+/g, " ").trim(), values });
    return fail ? Promise.reject(fail) : Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(query);
  return query;
}

const silent = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

function pgError(): Error {
  // What Bun SQL throws: the SQLSTATE in `errno`, a detail carrying values.
  return Object.assign(new Error('column "inventory_changed_at" does not exist (api_key=sk-live-SUPERSECRET123456)'), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "42703",
    detail: "Key (email)=(someone@example.com) already exists.",
    constraint: "runtimes_pkey",
  });
}

function mount(journal: UnhandledErrorJournal, options: { auth?: boolean; error?: () => unknown; environment?: string } = {}) {
  const app = new Hono();
  app.use("*", accessLogMiddleware({ log: silent }));
  app.use("*", async (context, next) => {
    if (options.auth) context.set("auth" as never, { organizationId: ORG, userId: USER } as never);
    await next();
  });
  app.onError((error, context) => respondToUnhandledError(context, error, {
    environment: options.environment ?? "development",
    journal,
    log: silent,
    now: () => new Date("2026-11-02T10:00:00.000Z"),
  }));
  const fail = () => { throw (options.error ?? pgError)(); };
  app.post("/api/one-shot-links/:token/register", fail);
  app.get("/api/threads/:threadId", fail);
  return app;
}

const hostile = (path: string, method = "POST") => new Request(`http://api.test${path}?access_token=query-secret-77&page=2`, {
  method,
  headers: {
    authorization: "Bearer eyJhbGciOi.payload.signature",
    cookie: "openedbot_session=cookie-value-42",
    "content-type": "application/json",
  },
  ...(method === "POST" ? { body: JSON.stringify({ password: "body-secret-99" }) } : {}),
});

function insertOf(calls: Call[]): Call {
  const insert = calls.find((call) => call.text.startsWith("insert into api_errors"));
  if (!insert) throw new Error(`no insert into api_errors among ${calls.map((call) => call.text).join(" | ")}`);
  return insert;
}

describe("respondToUnhandledError", () => {
  test("même corps et même statut, et une ligne clefée par la référence du corps", async () => {
    const calls: Call[] = [];
    const journal = createUnhandledErrorJournal(unhandledErrorJournalWriter(fakeDb(calls)), { log: silent });
    const response = await mount(journal, { auth: true }).request(hostile(`/api/one-shot-links/${LINK_TOKEN}/register`));
    expect(response.status).toBe(500);
    const body = await response.json() as { error: ReturnType<typeof unhandledErrorBody> };
    const reference = body.error.details.reference;
    expect(response.headers.get("X-Request-Id")).toBe(reference);
    expect(body).toEqual({ error: unhandledErrorBody(pgError(), reference, "development") });

    await journal.idle();
    expect(journal.stats()).toEqual({ inFlight: 0, written: 1, failed: 0, dropped: 0 });
    // An organization row is written under `withTenant`, for the `with check` of 0161.
    expect(calls[0]).toEqual({ text: "select set_config('app.organization_id', ?, true)", values: [ORG] });
    const [ref, occurredAt, organizationId, userId, method, route, path, code, pgCode, cause, message, stack] = insertOf(calls).values;
    expect(ref).toBe(reference);
    expect(occurredAt).toEqual(new Date("2026-11-02T10:00:00.000Z"));
    expect([organizationId, userId, method, route, code, pgCode]).toEqual([
      ORG, USER, "POST", "/api/one-shot-links/:token/register", "INTERNAL_ERROR", "42703",
    ]);
    expect(path).toBe("/api/one-shot-links/[redacted]/register");
    // The same cause as the body; the SQLSTATE, for its part, is read from `errno`.
    expect(cause).toBe(body.error.details.cause);
    expect(message).toContain('column "inventory_changed_at" does not exist');
    expect(message).toContain("constraint runtimes_pkey");
    expect(typeof stack).toBe("string");
  });

  test("ni query string, ni en-têtes, ni corps, ni secret du message, ni détail PostgreSQL", async () => {
    const calls: Call[] = [];
    const journal = createUnhandledErrorJournal(unhandledErrorJournalWriter(fakeDb(calls)), { log: silent });
    await mount(journal, { auth: true }).request(hostile(`/api/one-shot-links/${LINK_TOKEN}/register`));
    await journal.idle();
    const stored = JSON.stringify(insertOf(calls).values);
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
    expect(stored).not.toContain("access_token");
    expect(stored).not.toContain("page=2");
    expect(stored).not.toContain("someone@example.com");
    expect(stored).toContain("api_key=[redacted]");
  });

  test("sans session : organisation et compte NULL, aucun réglage de tenant ; un UUID du chemin reste", async () => {
    const calls: Call[] = [];
    const journal = createUnhandledErrorJournal(unhandledErrorJournalWriter(fakeDb(calls)), { log: silent });
    const response = await mount(journal, { error: () => new TypeError("x is not a function") })
      .request(hostile(`/api/threads/${THREAD}`, "GET"));
    expect(response.status).toBe(500);
    await journal.idle();
    expect(calls.some((call) => call.text.includes("set_config"))).toBe(false);
    const values = insertOf(calls).values;
    expect([values[2], values[3], values[4], values[5], values[6], values[8]]).toEqual([
      null, null, "GET", "/api/threads/:threadId", `/api/threads/${THREAD}`, null,
    ]);
    expect(values[10]).toBe("TypeError: x is not a function");
  });

  test("une écriture qui échoue ne change pas la réponse, elle est comptée et journalisée", async () => {
    const warnings: unknown[] = [];
    const calls: Call[] = [];
    const journal = createUnhandledErrorJournal(
      unhandledErrorJournalWriter(fakeDb(calls, new Error("connection refused"))),
      { log: { warn: (fields: unknown) => { warnings.push(fields); } } as never },
    );
    const response = await mount(journal, { auth: true, environment: "production" })
      .request(hostile(`/api/one-shot-links/${LINK_TOKEN}/register`));
    expect(response.status).toBe(500);
    const body = await response.json() as { error: ReturnType<typeof unhandledErrorBody> };
    expect(body).toEqual({ error: unhandledErrorBody(pgError(), body.error.details.reference, "production") });
    await journal.idle();
    expect(journal.stats()).toEqual({ inFlight: 0, written: 0, failed: 1, dropped: 0 });
    expect(warnings).toEqual([expect.objectContaining({
      event: "api.unhandled_error_journal_failed",
      reference: body.error.details.reference,
      error: "Error: connection refused",
    })]);
  });

  test("une écriture qui lève de façon synchrone, ou une rédaction qui lève, ne sort pas du handler", async () => {
    const throwing = createUnhandledErrorJournal(() => { throw new Error("sync boom"); }, { log: silent });
    const response = await mount(throwing).request(hostile("/api/threads/x", "GET"));
    expect(response.status).toBe(500);
    await throwing.idle();
    expect(throwing.stats().failed).toBe(1);

    const journal = createUnhandledErrorJournal(async () => undefined, { log: silent });
    journal.record("ref", () => { throw new Error("build boom"); });
    await journal.idle();
    expect(journal.stats()).toEqual({ inFlight: 0, written: 0, failed: 1, dropped: 0 });
  });

  test("la réponse n'attend pas l'écriture : une base qui ne répond pas ne retient pas le 500", async () => {
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => { release = resolve; });
    const journal = createUnhandledErrorJournal(() => stuck, { log: silent });
    const response = await mount(journal).request(hostile("/api/threads/x", "GET"));
    expect(response.status).toBe(500);
    expect(journal.stats().inFlight).toBe(1);
    release();
    await journal.idle();
    expect(journal.stats()).toEqual({ inFlight: 0, written: 1, failed: 0, dropped: 0 });
  });
});

describe("createUnhandledErrorJournal : borne des écritures en vol", () => {
  test("au-delà de maxInFlight, la ligne est abandonnée et comptée, sans file d'attente", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const releases: Array<() => void> = [];
    const written: string[] = [];
    const journal = createUnhandledErrorJournal(
      (record) => new Promise<void>((resolve) => { releases.push(() => { written.push(record.reference); resolve(); }); }),
      { maxInFlight: 2, log: { warn: (fields: Record<string, unknown>) => { warnings.push(fields); } } as never },
    );
    const record = (reference: string) => ({ reference } as UnhandledErrorRecord);
    for (const reference of ["a", "b", "c", "d", "e"]) journal.record(reference, () => record(reference));
    expect(journal.stats()).toEqual({ inFlight: 2, written: 0, failed: 0, dropped: 3 });
    expect(warnings.map((fields) => [fields.event, fields.reference, fields.dropped])).toEqual([
      ["api.unhandled_error_journal_dropped", "c", 1],
      ["api.unhandled_error_journal_dropped", "d", 2],
      ["api.unhandled_error_journal_dropped", "e", 3],
    ]);
    await Promise.resolve();
    for (const release of releases) release();
    await journal.idle();
    expect(written).toEqual(["a", "b"]);
    // The freed slot is used again.
    journal.record("f", () => record("f"));
    await Promise.resolve();
    releases.at(-1)!();
    await journal.idle();
    expect(journal.stats()).toEqual({ inFlight: 0, written: 3, failed: 0, dropped: 3 });
  });
});

describe("redactRequestPath", () => {
  test("garde les UUID et les segments courts, masque les jetons, coupe la query string", () => {
    expect(redactRequestPath(`/api/threads/${THREAD}/messages?cursor=abc`)).toBe(`/api/threads/${THREAD}/messages`);
    expect(redactRequestPath(`/api/one-shot-links/${LINK_TOKEN}`)).toBe("/api/one-shot-links/[redacted]");
    expect(redactRequestPath("/x".repeat(600)).length).toBeLessThanOrEqual(512);
  });
});

describe("contrat de la migration 0161_api_errors", () => {
  const sql = readFileSync(new URL("../../../db/migrations/0161_api_errors.sql", import.meta.url), "utf8");

  test("transactionnelle et enregistrée dans schema_migrations", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0161_api_errors')");
  });

  test("RLS forcée ; openedbot_api n'a que l'insertion, sans lecture ; le worker ne voit que l'expiré", () => {
    expect(sql).toContain("alter table api_errors enable row level security;");
    expect(sql).toContain("alter table api_errors force row level security;");
    expect(sql).toContain("create policy api_errors_api_insert on api_errors for insert to openedbot_api");
    expect(sql).toContain("grant insert on api_errors to openedbot_api;");
    expect(sql).not.toMatch(/grant select[^;]*to openedbot_api/);
    expect(sql).not.toMatch(/for select to openedbot_api/);
    expect(sql).toContain("for delete to openedbot_worker\n  using (occurred_at < now() - interval '90 days')");
    expect(sql).toContain("reference       uuid primary key");
  });

  test("les bornes SQL sont celles du code", () => {
    expect(sql).toContain("length(message) <= 1024");
    expect(sql).toContain("length(stack) <= 8192");
    expect(sql).toContain("length(path) <= 512");
  });

  test("db/ownership.json la range sous l'API, que le worker purge (writer)", () => {
    const ownership = JSON.parse(readFileSync(new URL("../../../db/ownership.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(ownership.api_errors).toEqual({ owner: "apps/api", writers: ["apps/worker"] });
  });
});
