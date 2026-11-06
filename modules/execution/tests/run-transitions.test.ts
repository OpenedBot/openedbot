import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  EXTERNAL_STATES,
  externalStateTransitionAllowed,
  REMOTE_STOP_STATES,
  remoteStopTransitionAllowed,
  RUN_STATUSES,
  runTransitionViolation,
  statusEdgeCondition,
  statusTransitionAllowed,
} from "../src/domain/run-transitions";
import { leaseFence, templateStrings, transitionRuns, type RunTransitionChange } from "../src/sql/run-transitions";

/**
 * S2d: the tables of `domain/run-transitions.ts`, every pair, against the
 * moves the code writes (inventory 0002 section 7), restated here on purpose:
 * a new move changes both, in review.
 */
const LEGAL_STATUS = new Set([
  "queued>queued", "queued>starting", "queued>cancelled", "queued>failed", "queued>unknown",
  ...["starting", "running", "awaiting_approval"].flatMap((from) =>
    ["completed", "failed", "cancelled", "queued", "unknown", "running", "awaiting_approval"].map((to) => `${from}>${to}`)),
  "relaying>completed", "relaying>cancelled",
  "unknown>unknown", "unknown>queued", "unknown>failed", "unknown>cancelled",
  "cancelled>queued", "cancelled>unknown",
]);
LEGAL_STATUS.delete("starting>starting");

const LEGAL_EXTERNAL = new Set([
  ...EXTERNAL_STATES.map((state) => `${state}>${state}`),
  ...EXTERNAL_STATES.map((state) => `${state}>ambiguous`),
  "not_started>creating", "not_started>settled",
  "creating>not_started", "creating>streaming", "creating>polling", "creating>stopping", "creating>settled",
  "streaming>creating", "streaming>polling", "streaming>stopping", "streaming>settled",
  "polling>creating", "polling>streaming", "polling>stopping", "polling>settled",
  "stopping>polling", "stopping>settled",
  "settled>not_started",
  "ambiguous>polling", "ambiguous>settled",
]);

const remote = (state: (typeof REMOTE_STOP_STATES)[number]) => state ?? "null";
const LEGAL_REMOTE = new Set([
  ...REMOTE_STOP_STATES.map((state) => `${remote(state)}>${remote(state)}`),
  "null>requested", "null>confirmed", "null>ambiguous",
  "requested>confirmed", "requested>ambiguous",
  "confirmed>requested", "confirmed>ambiguous",
  "ambiguous>requested", "ambiguous>confirmed",
  "failed>requested", "failed>ambiguous",
]);

describe("table des transitions de runs (S2d)", () => {
  test("statut : chacune des 81 paires", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect({ pair: `${from}>${to}`, allowed: statusTransitionAllowed(from, to) })
          .toEqual({ pair: `${from}>${to}`, allowed: LEGAL_STATUS.has(`${from}>${to}`) });
      }
    }
  });

  test("état externe : chacune des 49 paires", () => {
    for (const from of EXTERNAL_STATES) {
      for (const to of EXTERNAL_STATES) {
        expect({ pair: `${from}>${to}`, allowed: externalStateTransitionAllowed(from, to) })
          .toEqual({ pair: `${from}>${to}`, allowed: LEGAL_EXTERNAL.has(`${from}>${to}`) });
      }
    }
  });

  test("arrêt distant : chacune des 25 paires, jamais de retour à null", () => {
    for (const from of REMOTE_STOP_STATES) {
      for (const to of REMOTE_STOP_STATES) {
        const pair = `${remote(from)}>${remote(to)}`;
        expect({ pair, allowed: remoteStopTransitionAllowed(from, to) }).toEqual({ pair, allowed: LEGAL_REMOTE.has(pair) });
      }
    }
  });

  test("completed et failed sont finaux ; seul un repli replié revient de cancelled à queued", () => {
    for (const to of RUN_STATUSES) {
      expect(statusTransitionAllowed("completed", to)).toBe(false);
      expect(statusTransitionAllowed("failed", to)).toBe(false);
    }
    expect(statusEdgeCondition("cancelled", "queued")).toBe("steered_into_active");
    expect(statusEdgeCondition("unknown", "queued")).toBeNull();
  });

  test("une transition illégale est refusée avant d'écrire", () => {
    expect(runTransitionViolation({ from: ["completed"], to: { status: "running" } })).toBe("completed is final");
    expect(runTransitionViolation({ from: ["failed"], to: { externalState: "settled" } })).toBe("failed is final");
    expect(runTransitionViolation({ from: ["cancelled"], to: { status: "cancelled" } })).toBe("status cancelled -> cancelled");
    expect(runTransitionViolation({ from: ["queued"], to: { status: "running" } })).toBe("status queued -> running");
    expect(runTransitionViolation({ from: ["relaying"], to: { status: "failed" } })).toBe("status relaying -> failed");
    expect(runTransitionViolation({ from: ["unknown"], to: { status: "running" } })).toBe("status unknown -> running");
    expect(runTransitionViolation({ from: ["running", "relaying"], to: { status: "queued" } })).toBe("status relaying -> queued");
    expect(runTransitionViolation({ from: [], to: { status: "queued" } })).toBe("no origin status");
    expect(runTransitionViolation({ from: ["running"], to: {} })).toContain("nothing to write");
    expect(runTransitionViolation({ from: ["running"], fromExternalState: ["ambiguous"], to: { externalState: "streaming" } }))
      .toBe("external_state ambiguous -> streaming");
    expect(runTransitionViolation({ from: ["running"], to: { externalState: { map: { settled: "polling" } } } }))
      .toBe("external_state settled -> polling");
    expect(runTransitionViolation({ from: ["running"], fromRemoteStopState: ["requested"], to: { remoteStopState: null } }))
      .toBe("remote_stop_state requested -> null");
    expect(runTransitionViolation({ from: ["running"], to: { remoteStopState: { map: { confirmed: null } } } }))
      .toBe("remote_stop_state confirmed -> null");
    expect(runTransitionViolation({ from: ["running"], fromExternalState: ["settled"], to: { externalState: { withHermesRun: "polling", withoutHermesRun: "streaming" } } }))
      .toBe("external_state settled -> polling | streaming");
    expect(runTransitionViolation({ from: ["running"], to: { status: "bogus" as never } })).toBe("unknown status bogus");
  });

  test("les transitions écrites par le code sont toutes légales", () => {
    const active = ["starting", "running", "awaiting_approval"] as const;
    for (const transition of [
      { from: ["queued"], to: { status: "starting" } },
      { from: ["starting"], fromExternalState: ["creating"], to: { status: "running", externalState: "streaming" } },
      { from: active, to: { status: "queued", externalState: { withHermesRun: "polling", withoutHermesRun: "not_started" } } },
      { from: active, to: { status: "unknown", externalState: "ambiguous", remoteStopState: { map: { requested: "ambiguous", confirmed: "ambiguous", failed: "ambiguous" } } } },
      { from: [...active, "cancelled"], to: { status: "unknown", externalState: "ambiguous", remoteStopState: { map: { requested: "ambiguous" } } } },
      { from: ["cancelled"], fromExternalState: ["settled"], to: { status: "queued", externalState: "not_started" } },
      { from: ["unknown"], to: { status: "failed", externalState: "settled" } },
      { from: ["relaying"], to: { status: "completed" } },
      { from: ["queued"], to: { externalState: "stopping", remoteStopState: "requested" } },
    ] as const) {
      expect(runTransitionViolation(transition)).toBeNull();
    }
  });
});

type Call = { sql: string; values: unknown[] };
function fakeSql(calls: Call[], rows: unknown[] = []): SQL {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: [...strings].join("?").replace(/\s+/g, " ").trim(), values });
    return Promise.resolve(rows);
  }) as unknown as SQL;
}

describe("primitive de transition (S2d)", () => {
  const run = { organizationId: "org-1", id: "run-1" };

  test("une seule instruction : cible, origines, garde des états, fencing du bail, et ce qui a bougé", async () => {
    const calls: Call[] = [];
    const moved = await transitionRuns(fakeSql(calls, [{ id: "run-1", organizationId: "org-1", threadId: "t", workflowId: null, leaseGeneration: "3" }]), {
      target: run, fence: leaseFence("worker-a", 3),
      transition: { from: ["starting", "running", "awaiting_approval"], to: { status: "unknown", externalState: "ambiguous" } },
      set: { errorCode: "X", eventsComplete: false },
    });
    expect(moved).toEqual([{ id: "run-1", organizationId: "org-1", threadId: "t", workflowId: null, leaseGeneration: 3 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(
      "update runs set status = 'unknown', external_state = 'ambiguous', error_code = ?, events_complete = ?, updated_at = now()"
      + " where organization_id = ? and id = ? and status in ('starting', 'running', 'awaiting_approval')"
      + " and lease_owner = ? and lease_generation = ? and lease_expires_at > now()"
      + ' returning id, organization_id as "organizationId", thread_id as "threadId", workflow_id as "workflowId", lease_generation as "leaseGeneration"',
    );
    expect(calls[0]!.values).toEqual(["X", false, "org-1", "run-1", "worker-a", 3]);
  });

  test("la garde de l'état externe vient de ses origines légales ; la condition d'une arête est ajoutée", async () => {
    const calls: Call[] = [];
    await transitionRuns(fakeSql(calls), {
      target: run, fence: "unleased",
      transition: { from: ["cancelled"], to: { status: "queued", externalState: "not_started" } },
    });
    expect(calls[0]!.sql).toContain("and status in ('cancelled') and (status <> 'cancelled' or completion_kind = 'steered_into_active')");
    expect(calls[0]!.sql).toContain("and external_state in ('not_started', 'creating', 'settled')");
    expect(calls[0]!.sql).not.toContain("lease_owner");
  });

  test("un balayage prend un bail expiré ; un choix selon l'id Hermes garde chaque branche", async () => {
    const calls: Call[] = [];
    await transitionRuns(fakeSql(calls), {
      target: { sweep: true }, fence: "lease_expired",
      transition: { from: ["running"], to: { status: "queued", externalState: { withHermesRun: "polling", withoutHermesRun: "not_started" } } },
    });
    const sql = calls[0]!.sql;
    expect(sql).toContain("external_state = case when hermes_run_id is null then 'not_started' else 'polling' end");
    expect(sql).toContain("where true and status in ('running')");
    expect(sql).toContain("((hermes_run_id is not null and external_state in ('creating', 'streaming', 'polling', 'stopping', 'ambiguous'))"
      + " or (hermes_run_id is null and external_state in ('not_started', 'creating', 'settled')))");
    expect(sql).toContain("and (lease_expires_at < now() or lease_owner is null or lease_expires_at is null)");
  });

  test("l'arrêt distant garde null explicitement ; une carte laisse les autres origines en place", async () => {
    const calls: Call[] = [];
    await transitionRuns(fakeSql(calls), {
      target: { organizationId: "org-1", ids: ["a", "b"] }, fence: "unleased",
      transition: { from: ["queued"], fromRemoteStopState: [null, "confirmed"], to: { remoteStopState: { map: { none: "ambiguous" } } } },
    });
    expect(calls[0]!.sql).toContain("remote_stop_state = case when remote_stop_state is null then 'ambiguous' else remote_stop_state end");
    expect(calls[0]!.sql).toContain("and id in (?, ?)");
    expect(calls[0]!.sql).toContain("and (remote_stop_state in ('confirmed') or remote_stop_state is null)");
  });

  test("refuse une transition illégale sans rien envoyer, et une cible vide n'écrit rien", async () => {
    const calls: Call[] = [];
    const illegal: RunTransitionChange = { target: run, fence: "unleased", transition: { from: ["completed"], to: { status: "running" } } };
    await expect(transitionRuns(fakeSql(calls), illegal)).rejects.toThrow("run transition refused before writing: completed is final");
    await expect(transitionRuns(fakeSql(calls), {
      target: run, fence: "unleased", transition: { from: ["cancelled"], to: { status: "queued" } }, set: { bogus: 1 } as never,
    })).rejects.toThrow("unknown column bogus");
    expect(await transitionRuns(fakeSql(calls), {
      target: { organizationId: "org-1", ids: [] }, fence: "unleased", transition: { from: ["queued"], to: { status: "cancelled" } },
    })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("templateStrings", () => {
  // Bun 1.4.4's sql rejects a template object whose raw is enumerable.
  test("is shaped like a tagged literal's template object", () => {
    const strings = templateStrings(["select ", " from runs"]);
    expect([...strings]).toEqual(["select ", " from runs"]);
    expect(strings.raw).toEqual(["select ", " from runs"]);
    expect(Object.keys(strings)).toEqual(["0", "1"]);
    expect(Object.getOwnPropertyDescriptor(strings, "raw")?.enumerable).toBe(false);
    expect(Object.isFrozen(strings)).toBe(true);
    expect(Object.isFrozen(strings.raw)).toBe(true);
  });
});
