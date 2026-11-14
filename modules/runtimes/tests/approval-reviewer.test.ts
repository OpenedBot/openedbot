import { afterEach, describe, expect, test } from "bun:test";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import {
  approvalReviewerInstalled,
  effectivePermissionModeFor,
  effectivePermissionModeTx,
  installApprovalReviewer,
  reviewerReady,
} from "../src/application/approval-reviewer";

/**
 * A pool whose `begin` opens a transaction, with savepoints, holding the
 * transaction-local `app.organization_id` the way PostgreSQL does: it lives
 * only inside a transaction, and a savepoint rolled back undoes its setting.
 */
function fakePool() {
  type Tx = TransactionDb & { readonly inTransaction: true; readonly tenant: string };
  let tenant = "";
  let open = 0;
  const tagged = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    if (open === 0) return Promise.reject(new Error("statement outside a transaction"));
    if (sql.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: tenant }]);
    if (sql.includes("set_config('app.organization_id'")) { tenant = String(values[0]); return Promise.resolve([]); }
    return Promise.resolve([]);
  });
  Object.defineProperty(tagged, "tenant", { get: () => tenant });
  const tx = Object.assign(tagged, {
    inTransaction: true as const,
    savepoint: async <T>(work: (sp: TransactionDb) => Promise<T>) => {
      const before = tenant;
      try { return await work(tx as unknown as TransactionDb); } catch (error) { tenant = before; throw error; }
    },
  }) as unknown as Tx;
  const pool = {
    begin: async <T>(work: (inner: TransactionDb) => Promise<T>) => {
      open += 1;
      const before = tenant;
      try { return await work(tx); } finally { open -= 1; tenant = before; }
    },
  } as unknown as Db;
  return { pool, tx, tenantNow: () => tenant, open: <T>(work: (inner: Tx) => Promise<T>) => (pool as unknown as { begin: (w: (inner: Tx) => Promise<T>) => Promise<T> }).begin(work) };
}

/** One truth for display and execution: `auto` needs a ready reviewer, otherwise it is `manual`. */
afterEach(() => installApprovalReviewer(null));

describe("the effective permission mode", () => {
  test("solo (no reviewer installed): auto is manual, every other mode is itself", async () => {
    const { pool } = fakePool();
    expect(approvalReviewerInstalled()).toBe(false);
    for (const mode of ["manual", "plan", "bypass", null]) expect(await effectivePermissionModeFor(pool, "org-1", mode)).toBe(mode);
    expect(await effectivePermissionModeFor(pool, "org-1", "auto")).toBe("manual");
  });

  test("a reviewer installed: auto stays auto only for an organization it is ready for", async () => {
    const { pool } = fakePool();
    const asked: string[] = [];
    installApprovalReviewer({ ready: async (_tx, organizationId) => { asked.push(organizationId); return organizationId === "org-ready"; } });
    expect(await effectivePermissionModeFor(pool, "org-ready", "auto")).toBe("auto");
    expect(await effectivePermissionModeFor(pool, "org-cold", "auto")).toBe("manual");
    // Only `auto` asks the reviewer.
    expect(await effectivePermissionModeFor(pool, "org-cold", "manual")).toBe("manual");
    expect(asked).toEqual(["org-ready", "org-cold"]);
  });

  test("the hook runs in a transaction bound to the organization asked about, from the pool or a caller's transaction", async () => {
    const { pool, open, tenantNow } = fakePool();
    const seen: Array<{ organizationId: string; inTransaction: boolean; tenant: string }> = [];
    installApprovalReviewer({
      ready: async (hookTx, organizationId) => {
        const tx = hookTx as { inTransaction?: boolean; tenant?: string };
        seen.push({ organizationId, inTransaction: tx.inTransaction === true, tenant: tx.tenant ?? "" });
        // A conforming hook reads under RLS: it must see its own organization.
        return tx.inTransaction === true && tx.tenant === organizationId;
      },
    });
    // The run context holds the pool: the readiness opens its own tenant transaction.
    expect(await effectivePermissionModeFor(pool, "org-run", "auto")).toBe("auto");
    // A caller's transaction bound to another tenant (or none): bound for the hook, then put back.
    await open(async (tx) => {
      await tx`select set_config('app.organization_id', ${"org-other"}, true)`;
      expect(await effectivePermissionModeTx(tx, "org-run", "auto")).toBe("auto");
      expect(tenantNow()).toBe("org-other");
    });
    expect(seen).toEqual([
      { organizationId: "org-run", inTransaction: true, tenant: "org-run" },
      { organizationId: "org-run", inTransaction: true, tenant: "org-run" },
    ]);
  });

  test("a readiness that throws reads as not ready, in a savepoint, leaving the caller's tenant as it was", async () => {
    const { open, tenantNow } = fakePool();
    const errors: unknown[] = [];
    installApprovalReviewer({ ready: async () => { throw new Error("plug-in down"); } }, (error) => errors.push(error));
    await open(async (tx) => {
      await tx`select set_config('app.organization_id', ${"org-caller"}, true)`;
      expect(await reviewerReady(tx, "org-1")).toBe(false);
      expect(await effectivePermissionModeTx(tx, "org-1", "auto")).toBe("manual");
      expect(tenantNow()).toBe("org-caller");
    });
    expect(errors).toHaveLength(2);
  });
});
