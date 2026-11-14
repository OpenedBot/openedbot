import { describe, expect, test } from "bun:test";
import {
  enqueueQuotaReachedEmail,
  recordProviderIncident,
} from "../src/application/provider-fallback";

function sqlMock() {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    statements.push(sql);
    bindings.push(values);
    if (sql.includes("from memberships")) {
      return Promise.resolve([
        { userId: "user-owner", email: "owner@openedbot.local" },
        { userId: "user-admin", email: "admin@openedbot.local" },
      ]);
    }
    if (sql.includes("insert into email_outbox")) {
      const key = String(values[1] ?? "");
      if (key.includes("dup")) return Promise.resolve([]);
      return Promise.resolve([{ id: "outbox-1" }]);
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (db as unknown as { begin: (work: (tx: Bun.SQL) => unknown) => unknown }).begin = (work) => work(db);
  return { db, statements, bindings };
}

describe("recordProviderIncident", () => {
  test("upserts the incident with quota TTL and fallback", async () => {
    const { db, statements, bindings } = sqlMock();
    const now = new Date("2026-09-04T20:03:00.000Z");
    const recorded = await recordProviderIncident(db, {
      organizationId: "org-1",
      runtimeId: "rt-1",
      provider: "openai-codex",
      kind: "quota",
      runId: "run-1",
      message: "HTTP 429: The usage limit has been reached",
      fallbackProvider: "opencode-free",
      fallbackModel: "nemotron",
      now,
    });
    // La policy tenant du worker (0082) : l'organisation est posée d'abord.
    expect(statements[0]).toContain("set_config('app.organization_id'");
    expect(bindings[0]).toEqual(["org-1"]);
    expect(statements[1]).toContain("insert into runtime_provider_incidents");
    expect(statements[1]).toContain("on conflict (organization_id, runtime_id, provider)");
    expect(statements[2]).toContain("delete from runtime_model_proven");
    expect(statements[2]).toContain("provider =");
    expect(bindings[1]).toContain("openai-codex");
    expect(bindings[1]).toContain("opencode-free");
    expect(recorded.until.getTime()).toBe(now.getTime() + 6 * 3_600_000);
  });
});

describe("enqueueQuotaReachedEmail", () => {
  test("enqueues one mail per owner/admin", async () => {
    const { db, statements, bindings } = sqlMock();
    const inserted = await enqueueQuotaReachedEmail(db, {
      organizationId: "org-1",
      runtimeId: "rt-1",
      provider: "openai-codex",
      occurredAt: new Date("2026-09-04T20:03:00.000Z"),
      fallbackProvider: "opencode-free",
      fallbackModel: "nemotron",
      settingsUrl: "http://localhost:1420/settings/models",
      webAppUrl: "http://localhost:1420",
    });
    expect(inserted).toBe(2);
    expect(statements.some((sql) => sql.includes("insert into email_outbox"))).toBe(true);
    expect(bindings.some((values) => values.includes("provider_quota_reached"))).toBe(true);
  });

  test("dedupes on conflict do nothing", async () => {
    const seen = new Set<string>();
    const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join(" ");
      if (sql.includes("from memberships")) {
        return Promise.resolve([{ userId: "user-owner", email: "owner@openedbot.local" }]);
      }
      if (sql.includes("insert into email_outbox")) {
        const key = String(values.find((value) => typeof value === "string" && value.startsWith("provider-quota:")) ?? "");
        if (seen.has(key)) return Promise.resolve([]);
        seen.add(key);
        return Promise.resolve([{ id: "outbox-1" }]);
      }
      return Promise.resolve([]);
    }) as unknown as Bun.SQL;

    const input = {
      organizationId: "org-1",
      runtimeId: "rt-1",
      provider: "openai-codex",
      occurredAt: new Date("2026-09-04T20:03:00.000Z"),
      fallbackProvider: null,
      fallbackModel: null,
      settingsUrl: "http://localhost:1420/settings/models",
      webAppUrl: "http://localhost:1420",
    };
    expect(await enqueueQuotaReachedEmail(db, input)).toBe(1);
    expect(await enqueueQuotaReachedEmail(db, { ...input, occurredAt: new Date("2026-09-04T21:00:00.000Z") })).toBe(0);
  });
});
