import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import {
  readAgencyA2APolicy,
  requestAgencyA2APolicyHost,
  writeAgencyA2APolicy,
  type A2APolicyScope,
} from "../src/application/a2a-policy";

const scope: A2APolicyScope = {
  userId: "83000000-0000-4000-8000-000000000001",
  agencyId: "83000000-0000-4000-8000-000000000002",
  clientId: "83000000-0000-4000-8000-000000000003",
};
const runtimeId = "83000000-0000-4000-8000-000000000004";

function fixture() {
  let mandate = true;
  let runtimeActive = true;
  let inTransaction = false;
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("set_config('app.organization_id'")) return [];
    if (query.includes("workspace_access(")) return mandate ? [{ viaAgencyIds: [scope.agencyId] }] : [];
    if (query.includes("from runtimes")) return runtimeActive ? [{ id: runtimeId }] : [];
    return [];
  }) as unknown as SQL;
  sql.begin = (async (callback: (tx: SQL) => Promise<unknown>) => {
    inTransaction = true;
    try { return await callback(sql); }
    finally { inTransaction = false; }
  }) as SQL["begin"];
  return {
    db: sql as unknown as Db,
    revoke() { mandate = false; },
    deactivateRuntime() { runtimeActive = false; },
    hasMandate() { return mandate; },
    inTransaction() { return inTransaction; },
  };
}

const view = {
  accessMode: "trusted_peers" as const,
  trustedPeersSource: "config" as const,
  processObserved: true,
  peers: [],
};
const status = { persisted: true, effective: false, needsGatewayRestart: true };

describe("agency A2A policy authorization", () => {
  test("checks selected mandate and active runtime before and after each host call without holding SQL", async () => {
    const state = fixture();
    const observedTransactions: boolean[] = [];
    const result = await readAgencyA2APolicy(state.db, scope, runtimeId, async () => {
      observedTransactions.push(state.inTransaction());
      return view;
    });
    expect(result).toEqual(view);
    expect(observedTransactions).toEqual([false]);
  });

  test("revocation during an in-flight request denies both read and write results", async () => {
    for (const operation of [
      (db: Db, request: () => Promise<unknown>) => requestAgencyA2APolicyHost(db, scope, runtimeId, request),
      (db: Db, request: () => Promise<unknown>) => writeAgencyA2APolicy(db, scope, runtimeId, request as () => Promise<typeof status>),
    ]) {
      const state = fixture();
      let networkWasOutsideTransaction = false;
      await expect(operation(state.db, async () => {
        networkWasOutsideTransaction = !state.inTransaction();
        state.revoke();
        return status;
      })).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_REVOKED", status: 403 });
      expect(networkWasOutsideTransaction).toBe(true);
    }

    const failed = fixture();
    await expect(requestAgencyA2APolicyHost(failed.db, scope, runtimeId, async () => {
      failed.revoke();
      throw new Error("host token must not win over revocation");
    })).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_REVOKED", status: 403 });
  });

  test("host failure is sanitized only after the mandate is revalidated", async () => {
    const state = fixture();
    let networkWasOutsideTransaction = false;
    await expect(requestAgencyA2APolicyHost(state.db, scope, runtimeId, async () => {
      networkWasOutsideTransaction = !state.inTransaction();
      throw new Error("secret-host-token");
    })).rejects.toMatchObject({ code: "A2A_POLICY_UNAVAILABLE", status: 502 });
    expect(networkWasOutsideTransaction).toBe(true);
    expect(state.hasMandate()).toBe(true);
  });

  test("rejects an inactive runtime before contacting the host", async () => {
    const state = fixture();
    state.deactivateRuntime();
    let called = false;
    await expect(readAgencyA2APolicy(state.db, scope, runtimeId, async () => {
      called = true;
      return view;
    })).rejects.toMatchObject({ code: "A2A_POLICY_NO_RUNTIME", status: 404 });
    expect(called).toBe(false);
  });
});
