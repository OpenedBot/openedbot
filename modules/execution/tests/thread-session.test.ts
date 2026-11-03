import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { pinThreadSession, type ThreadSessionRow } from "../src/application/runner/thread-session";

type Call = { sql: string; values: unknown[] };

/** Une base factice : `threads` tient la génération, `runs` accepte la clé tant que le bail tient. */
function fakeDb(state: { generation: number; leaseHeld?: boolean; rotatedByOther?: boolean }, calls: Call[]): SQL {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.startsWith("update threads set hermes_session_generation = hermes_session_generation + 1")) {
      if (state.rotatedByOther) {
        state.generation += 1;
        return Promise.resolve([]);
      }
      state.generation += 1;
      return Promise.resolve([{ generation: state.generation }]);
    }
    if (sql.startsWith("select hermes_session_generation")) return Promise.resolve([{ generation: state.generation }]);
    if (sql.startsWith("update runs set execution_session_key")) {
      return Promise.resolve(state.leaseHeld === false ? [] : [{ id: "run-1" }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
}

const claimed = { id: "run-1", organizationId: "org-1", leaseGeneration: 1 };

function row(overrides: Partial<ThreadSessionRow> = {}): ThreadSessionRow {
  return {
    organizationId: "org-1",
    threadId: "thread-1",
    threadSessionId: "ohb:org-1:thread-1",
    threadSessionGeneration: 0,
    threadSessionOpenedAt: new Date("2026-11-02T10:00:00Z"),
    threadCreatedAt: new Date("2026-11-01T00:00:00Z"),
    rootCapabilitiesChangedAt: null,
    profileCapabilitiesChangedAt: null,
    ...overrides,
  };
}

describe("pinThreadSession (0163)", () => {
  test("rien n'a changé : la session du fil, sans écriture", async () => {
    const calls: Call[] = [];
    expect(await pinThreadSession(fakeDb({ generation: 0 }, calls), claimed, "worker-1", row())).toBe("ohb:org-1:thread-1");
    expect(calls).toEqual([]);
  });

  test("un skill basculé sur le profil après l'ouverture : génération suivante, clé posée sur le run", async () => {
    const calls: Call[] = [];
    const state = { generation: 0 };
    const session = await pinThreadSession(fakeDb(state, calls), claimed, "worker-1", row({
      profileCapabilitiesChangedAt: "2026-11-02T10:05:00+00:00",
    }));
    expect(session).toBe("ohb:org-1:thread-1:gen1");
    expect(calls[0]!.sql).toContain("and hermes_session_generation =");
    expect(calls[0]!.values).toContain(0);
    const pin = calls.find((call) => call.sql.startsWith("update runs set execution_session_key"));
    expect(pin?.values).toEqual(["ohb:org-1:thread-1:gen1", "run-1", "org-1", "worker-1", 1]);
  });

  test("un changement de la racine compte aussi pour un bot à profil", async () => {
    const calls: Call[] = [];
    const session = await pinThreadSession(fakeDb({ generation: 2 }, calls), claimed, "worker-1", row({
      threadSessionGeneration: 2,
      rootCapabilitiesChangedAt: new Date("2026-11-02T11:00:00Z"),
    }));
    expect(session).toBe("ohb:org-1:thread-1:gen3");
  });

  test("un autre run a déjà fait avancer le fil : on prend sa génération, sans avancer deux fois", async () => {
    const calls: Call[] = [];
    const state = { generation: 0, rotatedByOther: true };
    const session = await pinThreadSession(fakeDb(state, calls), claimed, "worker-1", row({
      rootCapabilitiesChangedAt: new Date("2026-11-02T11:00:00Z"),
    }));
    expect(session).toBe("ohb:org-1:thread-1:gen1");
    expect(calls.filter((call) => call.sql.includes("hermes_session_generation + 1"))).toHaveLength(1);
  });

  test("première ouverture d'une génération : l'instant est noté, la clé reste celle du fil", async () => {
    const calls: Call[] = [];
    const session = await pinThreadSession(fakeDb({ generation: 0 }, calls), claimed, "worker-1", row({ threadSessionOpenedAt: null }));
    expect(session).toBe("ohb:org-1:thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("set hermes_session_opened_at = now()");
    expect(calls[0]!.sql).toContain("hermes_session_opened_at is null");
  });

  test("bail perdu : null, le run n'est pas lancé sur une clé non posée", async () => {
    const calls: Call[] = [];
    const session = await pinThreadSession(fakeDb({ generation: 1, leaseHeld: false }, calls), claimed, "worker-1", row({
      threadSessionGeneration: 1,
    }));
    expect(session).toBeNull();
  });

  test("une date illisible vaut « inconnu », jamais une panne du run", async () => {
    const calls: Call[] = [];
    const session = await pinThreadSession(fakeDb({ generation: 0 }, calls), claimed, "worker-1", row({
      profileCapabilitiesChangedAt: "pas une date",
    }));
    expect(session).toBe("ohb:org-1:thread-1");
  });
});
