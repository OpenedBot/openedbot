import { expect, test } from "bun:test";
import type { AgencyAuditEventDto } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { readAgencyAuditPage } from "../src/application/agency-audit";

const userId = "91000000-0000-4000-8000-000000000001";
const agencyId = "91000000-0000-4000-8000-000000000002";
const otherAgencyId = "91000000-0000-4000-8000-000000000003";
const clientId = "91000000-0000-4000-8000-000000000004";

type Access = { role: string | null; kind: string; viaAgencyIds: string[] };
type Statement = { sql: string; values: unknown[] };

function event(id: string, kind: AgencyAuditEventDto["kind"], occurredAt: string): AgencyAuditEventDto {
  return { id, kind, role: "agency", actorUserId: userId, occurredAt };
}

function fakeDb(input: { access: Access | null; events?: AgencyAuditEventDto[] }) {
  const statements: Statement[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql, values });
    if (sql.startsWith("select set_config")) return [];
    if (sql.includes("workspace_access(")) return input.access ? [input.access] : [];
    if (sql.includes("from membership_events")) return input.events ?? [];
    throw new Error(`Unexpected SQL: ${sql}`);
  }) as unknown as Bun.TransactionSQL;
  const db = {
    begin: (callback: (tx: Bun.TransactionSQL) => Promise<unknown>) => callback(tx),
  } as unknown as Db;
  return { db, statements };
}

test("the selected live agency mandate is revalidated before reading history", async () => {
  const invalidAccesses: Access[] = [
    { role: "owner", kind: "personal", viaAgencyIds: [] },
    { role: "agency", kind: "personal", viaAgencyIds: [otherAgencyId] },
  ];

  for (const access of invalidAccesses) {
    const { db, statements } = fakeDb({ access });
    let failure: { code?: unknown; status?: unknown } | undefined;
    try {
      await readAgencyAuditPage(db, { userId, agencyId, clientId });
    } catch (error) {
      failure = error as { code?: unknown; status?: unknown };
    }
    expect(failure?.code).toBe("WORKSPACE_ACCESS_REVOKED");
    expect(failure?.status).toBe(403);
    expect(statements.some(({ sql }) => sql.includes("from membership_events"))).toBe(false);
  }
});

test("history is constrained to the client, selected agency and grant event kinds", async () => {
  const events = [
    event("91000000-0000-4000-8000-000000000011", "agency_revoked", "2026-10-03T13:00:00.000000Z"),
    event("91000000-0000-4000-8000-000000000010", "agency_granted", "2026-10-03T12:00:00.000000Z"),
  ];
  const { db, statements } = fakeDb({ access: { role: "agency", kind: "personal", viaAgencyIds: [agencyId] }, events });

  const page = await readAgencyAuditPage(db, { userId, agencyId, clientId });
  const query = statements.find(({ sql }) => sql.includes("from membership_events"));

  expect(page).toEqual({ events, nextCursor: null, hasMore: false, limit: 50 });
  expect(query?.sql).toContain("organization_id = ?");
  expect(query?.values).toContain(clientId);
  expect(query?.sql).toContain("subject_organization_id = ?");
  expect(query?.values).toContain(agencyId);
  expect(query?.sql).toContain("kind in ('agency_granted', 'agency_revoked')");
  expect(query?.sql).toContain("order by occurred_at desc, id desc");
  expect(query?.sql).not.toContain("content");
});

test("pagination returns a bounded page and a validated stable cursor", async () => {
  const rows = [
    event("91000000-0000-4000-8000-000000000013", "agency_revoked", "2026-10-03T13:00:00.000003Z"),
    event("91000000-0000-4000-8000-000000000012", "agency_granted", "2026-10-03T12:00:00.000002Z"),
    event("91000000-0000-4000-8000-000000000011", "agency_revoked", "2026-10-03T11:00:00.000001Z"),
  ];
  const access = { role: "agency", kind: "personal", viaAgencyIds: [agencyId] };
  const first = fakeDb({ access, events: rows });
  const page = await readAgencyAuditPage(first.db, { userId, agencyId, clientId, limit: 2 });

  expect(page.events).toEqual(rows.slice(0, 2));
  expect(page.limit).toBe(2);
  expect(page.hasMore).toBe(true);
  expect(page.nextCursor).toBeTruthy();

  const second = fakeDb({ access, events: [rows[2]!] });
  const nextPage = await readAgencyAuditPage(second.db, { userId, agencyId, clientId, limit: 2, after: page.nextCursor });
  const query = second.statements.find(({ sql }) => sql.includes("from membership_events"));
  expect(nextPage.events).toEqual([rows[2]!]);
  expect(nextPage.hasMore).toBe(false);
  expect(query?.sql).toContain("(occurred_at, id) < (?::timestamptz, ?::uuid)");
  expect(query?.values).toContain(rows[1]!.occurredAt);
  expect(query?.values).toContain(rows[1]!.id);
});

test("malformed cursors and limits are rejected before any database read", async () => {
  const { db, statements } = fakeDb({ access: { role: "agency", kind: "personal", viaAgencyIds: [agencyId] } });
  let cursorFailure: { code?: unknown; status?: unknown } | undefined;
  try {
    await readAgencyAuditPage(db, { userId, agencyId, clientId, after: "not-a-cursor" });
  } catch (error) {
    cursorFailure = error as { code?: unknown; status?: unknown };
  }
  expect(cursorFailure?.code).toBe("AGENCY_AUDIT_CURSOR_INVALID");
  expect(cursorFailure?.status).toBe(400);

  let limitFailure: { code?: unknown; status?: unknown } | undefined;
  try {
    await readAgencyAuditPage(db, { userId, agencyId, clientId, limit: 51 });
  } catch (error) {
    limitFailure = error as { code?: unknown; status?: unknown };
  }
  expect(limitFailure?.code).toBe("AGENCY_AUDIT_LIMIT_INVALID");
  expect(limitFailure?.status).toBe(400);
  expect(statements).toHaveLength(0);
});
