import { describe, expect, test } from "bun:test";
import type { AccountWorkspace, WorkspaceBusinessMetrics } from "@openedbot/contracts-api";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { readFleetClient, readFleetPage } from "../src/application/fleet";

const userId = "00000000-0000-4000-8000-000000000001";
const agencyA = "00000000-0000-4000-8000-000000000002";
const agencyB = "00000000-0000-4000-8000-000000000003";
const workspace: AccountWorkspace = {
  id: "00000000-0000-4000-8000-000000000004", name: "Client", slug: "client",
  kind: "personal", role: "owner", viaAgencyIds: [agencyA, agencyB],
};
const metrics: WorkspaceBusinessMetrics = {
  activeBots: 2, archivedBots: 1, runsTotal: 4, runsRunning: 1, runsQueued: 0,
  pendingApprovals: 1, completed: 2, failed: 1, tokens: 123, tokensMeasuredRuns: 3,
  tokensUnknownRuns: 0, successRate: 67, providerIncidents: 0, runtimeIncidents: 0,
};

function fixture(accessReads: string[][]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let reads = 0;
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ? ");
    calls.push({ sql, values });
    if (sql.includes("workspace_access")) return [{ viaAgencyIds: accessReads[Math.min(reads++, accessReads.length - 1)] ?? [] }];
    if (sql.includes("workspace_business_metrics")) return [{ metrics }];
    return [];
  }) as unknown as TransactionDb;
  const db = { begin: async (callback: (tx: TransactionDb) => Promise<unknown>) => callback(tx) } as unknown as Db;
  return { db, calls };
}

describe("fleet mandate observations", () => {
  test("returns the exact mandate and data-read time for a directly owned client", async () => {
    const { db, calls } = fixture([[agencyA, agencyB]]);
    const result = await readFleetClient(db, userId, agencyA, workspace, true);
    expect(result.metrics).toEqual(metrics);
    expect(result.agentCount).toBe(3);
    expect(result.mandate).toMatchObject({
      agencyOrganizationId: agencyA, clientOrganizationId: workspace.id,
      state: "active",
    });
    expect(result.mandate?.verifiedAt).toBe(result.observedAt);
    expect(Number.isFinite(Date.parse(result.observedAt!))).toBe(true);
    expect(calls.filter((call) => call.sql.includes("workspace_access")).map((call) => call.values))
      .toEqual([[userId, workspace.id], [userId, workspace.id]]);
  });

  test("rejects a revoked acting mandate despite another agency and direct membership", async () => {
    const { db } = fixture([[agencyA, agencyB], [agencyB]]);
    await expect(readFleetClient(db, userId, agencyA, workspace, true))
      .rejects.toMatchObject({ status: 403, code: "WORKSPACE_ACCESS_REVOKED" });
  });

  test("does not read observations for a client outside the acting mandate", async () => {
    const { db, calls } = fixture([[agencyB]]);
    await expect(readFleetClient(db, userId, agencyA, workspace, true))
      .rejects.toMatchObject({ status: 403, code: "WORKSPACE_ACCESS_REVOKED" });
    expect(calls.some((call) => call.sql.includes("from runtimes"))).toBe(false);
  });

  test("keeps the acting agency's observations when only the other agency is removed", async () => {
    const { db } = fixture([[agencyA, agencyB], [agencyA]]);
    expect((await readFleetClient(db, userId, agencyA, workspace, true)).mandate?.agencyOrganizationId).toBe(agencyA);
  });

  test("omits a revoked client from its fleet rather than turning its data into zeroes", async () => {
    const { db } = fixture([[agencyA], []]);
    expect(await readFleetPage(db, userId, agencyA, [workspace])).toEqual([]);
  });
});
