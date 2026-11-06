import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { failRunsOnDisconnectedRuntimes } from "../src/application/disconnected-runtime-runs";

type Captured = { sql: string; values: unknown[] };

function fakeDb(captured: Captured[], failed: unknown[] = []): SQL {
  const tx = (strings: TemplateStringsArray | unknown, ...values: unknown[]) => {
    if (!(Array.isArray(strings) && "raw" in strings)) return strings;
    const sql = [...strings].join("?");
    captured.push({ sql, values });
    if (sql.includes("insert into run_events")) {
      return Promise.resolve([{ cursor: "1", botId: null, turnId: "run-1", sessionKey: null, leaseGeneration: "0", occurredAt: new Date() }]);
    }
    return Promise.resolve(sql.startsWith("update runs set status = 'failed'") ? failed : []);
  };
  return { begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as SQL;
}

describe("failRunsOnDisconnectedRuntimes", () => {
  test("n'échoue pas un runtime dont l'instance est vivante et last_seen frais", async () => {
    const captured: Captured[] = [];
    expect(await failRunsOnDisconnectedRuntimes(fakeDb(captured), 900_000)).toBe(0);
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;
    expect(sql).toStartWith("update runs set status = 'failed', external_state = 'settled'");
    expect(sql).toContain("left join api_instances inst");
    expect(sql).toContain("interval '60 seconds'");
    expect(sql).toContain("inst.instance_id is not null");
    expect(sql).toContain("and not (");
    expect(sql).toContain("rt.link_last_seen_at > now() - interval '45 seconds'");
    // Le run.error n'est plus calculé dans l'instruction qui attend le curseur (D2).
    expect(sql).not.toContain("run_events");
  });

  test("numérote le run.error de chaque run échoué par la primitive, après le verrou du run puis du curseur", async () => {
    const captured: Captured[] = [];
    const failed = [{ id: "run-1", organizationId: "org-1", threadId: "thread-1", workflowId: null, leaseGeneration: 0 }];
    expect(await failRunsOnDisconnectedRuntimes(fakeDb(captured, failed), 900_000)).toBe(1);
    const steps = captured.map(({ sql }) => sql.includes("for no key update") ? "run"
      : sql.includes("pg_advisory_xact_lock") ? "cursor"
      : sql.includes("max(sequence)") ? "max"
      : sql.includes("insert into run_events") ? "insert" : "sweep");
    expect(steps).toEqual(["sweep", "run", "cursor", "max", "insert"]);
    expect(captured.at(-1)!.values).toContain("run.error");
  });
});
