import { describe, expect, test } from "bun:test";
import { HermesClientError, RelayDialError, type HermesClient } from "@openedbot/hermes";
import {
  MAX_RUN_STEER_ATTEMPTS,
  STEER_TARGET_POISON_ATTEMPTS,
  expireUnacknowledgedRunSteers,
  forwardNextRunSteer,
  recoverRunSteersBeforeClaim,
  reconcileRunSteerEvent,
  replayUndeliveredRunSteers,
  undeliveredSteerTail,
} from "../src/application/run-steering";
import { MAX_RUN_ATTEMPTS } from "../src/application/queue";
import { withRunReceiptJournalTx } from "../src/application/run-receipts";

type Query = { sql: string; values: unknown[] };
const fakeFragment = Symbol("fake SQL fragment");
type FakeFragment = {
  [fakeFragment]: true;
  sql: string;
  values: unknown[];
};
type FakeQuery<T = unknown> = FakeFragment & PromiseLike<T>;

function fakeDb(respond: (sql: string) => unknown): { db: Bun.SQL; queries: Query[] } {
  const queries: Query[] = [];
  const tx = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!("raw" in strings)) {
      const items = Array.isArray(strings) ? strings : [strings];
      return {
        [fakeFragment]: true,
        sql: `(${items.map(() => "?").join(", ")})`,
        values: items,
      } satisfies FakeFragment;
    }

    const parts = strings as TemplateStringsArray;
    let sql = parts[0] ?? "";
    const parameters: unknown[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value && typeof value === "object" && fakeFragment in value) {
        const fragment = value as FakeFragment;
        sql += fragment.sql;
        parameters.push(...fragment.values);
      } else {
        sql += "?";
        parameters.push(value);
      }
      sql += parts[index + 1] ?? "";
    }

    return {
      [fakeFragment]: true,
      sql,
      values: parameters,
      then(resolve, reject) {
        queries.push({ sql, values: parameters });
        return Promise.resolve(respond(sql)).then(resolve, reject);
      },
    } satisfies FakeQuery;
  }) as unknown as Bun.SQL;
  const db = tx as Bun.SQL & { begin: (callback: (transaction: Bun.SQL) => Promise<unknown>) => Promise<unknown> };
  db.begin = (async (callback: (transaction: Bun.SQL) => Promise<unknown>) => callback(tx)) as Bun.SQL["begin"];
  return { db, queries };
}

const org = "org-1";
const target = "target-1";
const source = "source-1";
const workflow = "workflow-1";
const attempt = "attempt-1";

describe("steering Hermes", () => {
  test("un ACK SSE confirme la tentative ambiguous", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: workflow }];
      }
      if (sql.includes("select id, status from runs")) {
        return [{ id: source, status: "queued" }, { id: target, status: "running" }];
      }
      if (sql.includes("select status from workflows")) return [{ status: "queued" }];
      if (sql.includes("select status from run_steering_attempts")) return [{ status: "ambiguous" }];
      return [];
    });

    await reconcileRunSteerEvent(db, { id: target, organizationId: org }, true);

    expect(queries.some((query) => query.sql.includes("set status = 'confirmed'"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("completion_kind = 'steered_into_active'"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("set status = 'completed'"))).toBe(true);
  });

  test("la fin du run cible expire l'ACK sans débloquer autrement le repli", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer")) {
        return [{
          organizationId: org,
          sourceRunId: source,
          sourceWorkflowId: workflow,
          targetRunId: target,
          attemptId: attempt,
        }];
      }
      return [];
    });

    await expireUnacknowledgedRunSteers(db, { id: target, organizationId: org });

    expect(queries.some((query) => query.sql.includes("set status = 'expired'"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("STEER_UNACKED_FALLBACK"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("update runs set") && query.sql.includes(source))).toBe(false);
    expect(queries.some((query) => query.sql.includes("update workflows set"))).toBe(false);
  });

  test("une fence refusée empêche le POST et n'émet aucun reçu", async () => {
    const posts: string[] = [];
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("select id from runs") && sql.includes("status = 'running' and external_state = 'streaming'")) return [{ id: target }];
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: workflow, text: "focus" }];
      }
      if (sql.includes('as "canSteer"')) {
        return [
          { id: source, status: "queued", canSteer: false },
          { id: target, status: "running", canSteer: false },
        ];
      }
      if (sql.includes("select status from workflows")) return [{ status: "queued" }];
      if (sql.includes("select status from run_steering_attempts")) return [{ status: "pending" }];
      return [];
    });
    const client = {
      steerRun: async () => {
        posts.push("dispatched");
        return 202;
      },
    } as unknown as HermesClient;

    await expect(forwardNextRunSteer(
      db,
      client,
      { workerId: "worker-1", leaseSeconds: 10 },
      { id: target, organizationId: org, threadId: "thread-1", leaseGeneration: 3 },
      "hermes-target-1",
      new AbortController().signal,
    )).resolves.toBe("none");

    expect(posts).toEqual([]);
    expect(queries.some((query) => query.sql.includes("update runs set") && query.sql.includes("steered_into_active"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("update workflows set"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("set status = 'sending'"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("insert into run_events"))).toBe(false);
  });

  test("un lease perdu après dispatch conserve le repli et journalise une issue ambiguë", async () => {
    let attemptStatus = "pending";
    let posts = 0;
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("jsonb_build_object")) {
        return [{ runId: source, threadId: "thread-1", payload: { status: attemptStatus } }];
      }
      if (sql.includes("select id from runs") && sql.includes("status = 'running' and external_state = 'streaming'")) return [{ id: target }];
      if (sql.includes("from run_steering_attempts steer")) return [{ id: attempt, sourceRunId: source, sourceWorkflowId: null, text: "focus" }];
      if (sql.includes('as "canSteer"')) return [{ id: source, status: "queued", canSteer: false }, { id: target, status: "running", canSteer: true }];
      if (sql.includes("select id, status, remote_stop_state")) return [
        { id: source, status: "queued" },
        { id: target, status: "running", remoteStopState: null, leaseOwner: "worker-1", leaseGeneration: 4 },
      ];
      if (sql.includes("select status from run_steering_attempts")) return [{ status: attemptStatus }];
      if (sql.includes("select status, forwarding_owner")) return [{ status: attemptStatus, forwardingOwner: "worker-1", forwardingEpoch: 1 }];
      if (sql.includes("returning forwarding_epoch")) { attemptStatus = "sending"; return [{ forwardingEpoch: 1 }]; }
      if (sql.includes("set status = 'ambiguous'")) { attemptStatus = "ambiguous"; return [{ id: attempt }]; }
      return [];
    });
    const client = { steerRun: async () => { posts++; return 202; } } as unknown as HermesClient;
    await expect(forwardNextRunSteer(db, client, { workerId: "worker-1", leaseSeconds: 10 },
      { id: target, organizationId: org, threadId: "thread-1", leaseGeneration: 3 },
      "hermes-target-1", new AbortController().signal)).resolves.toBe("ambiguous");
    expect(posts).toBe(1);
    expect(attemptStatus).toBe("ambiguous");
    expect(queries.some((query) => query.sql.includes("update runs set"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("set status = 'confirmed'"))).toBe(false);
    const receipts = queries.filter((query) => query.sql.includes("insert into run_events"));
    expect(receipts).toHaveLength(2);
    expect(receipts.map((query) => (query.values[4] as { status: string }).status)).toEqual(["sending", "ambiguous"]);
  });

  test("le repli d'un DM simple, sans workflow, se steere puis se confirme (OHB-113)", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("select id from runs") && sql.includes("status = 'running' and external_state = 'streaming'")) return [{ id: target }];
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: null, text: "focus" }];
      }
      if (sql.includes('as "canSteer"')) {
        const rows = [
          { id: source, status: "queued", canSteer: false },
          { id: target, status: "running", canSteer: true },
        ];
        return rows;
      }
      if (sql.includes("select id, status, remote_stop_state")) {
        return [
          { id: source, status: "queued" },
          { id: target, status: "running", remoteStopState: null, leaseOwner: "worker-1", leaseGeneration: 3 },
        ];
      }
      if (sql.includes("select status from workflows")) throw new Error("aucun workflow à verrouiller");
      if (sql.includes("select status from run_steering_attempts")) return [{ status: "pending" }];
      if (sql.includes("select status, forwarding_owner")) {
        return [{ status: "sending", forwardingOwner: "worker-1", forwardingEpoch: 1 }];
      }
      if (sql.includes("returning forwarding_epoch")) return [{ forwardingEpoch: 1 }];
      return [];
    });
    const client = { steerRun: async () => 202 } as unknown as HermesClient;

    const outcome = await forwardNextRunSteer(
      db,
      client,
      { workerId: "worker-1", leaseSeconds: 10 },
      { id: target, organizationId: org, threadId: "thread-1", leaseGeneration: 3 },
      "hermes-target-1",
      new AbortController().signal,
    );

    expect(outcome).toBe("confirmed");

    const claim = queries.find((query) => query.sql.includes("from run_steering_attempts steer"))!;
    expect(claim.sql).toContain("left join workflows workflow");
    expect(claim.sql).toContain("source.workflow_id is null or workflow.status = 'queued'");
    expect(claim.sql).toContain("coalesce(workflow.created_at, source.created_at)");
    expect(queries.some((query) => query.sql.includes("completion_kind = 'steered_into_active'"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("update workflows set"))).toBe(false);
  });

  test("un ACK SSE confirme aussi le repli d'un DM simple sans toucher aux workflows", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: null }];
      }
      if (sql.includes("select id, status from runs")) {
        return [{ id: source, status: "queued" }, { id: target, status: "running" }];
      }
      if (sql.includes("select status from workflows")) throw new Error("aucun workflow à verrouiller");
      if (sql.includes("select status from run_steering_attempts")) return [{ status: "ambiguous" }];
      return [];
    });

    await expect(reconcileRunSteerEvent(db, { id: target, organizationId: org }, true)).resolves.toBe("confirmed");
    expect(queries.find((query) => query.sql.includes("from run_steering_attempts steer"))!.sql)
      .not.toContain("source.workflow_id is not null");
    expect(queries.some((query) => query.sql.includes("completion_kind = 'steered_into_active'"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("update workflows set"))).toBe(false);
  });

  test("l'ACK SSE confirmé avant la réponse HTTP n'est pas appliqué deux fois", async () => {
    let attemptStatus = "pending";
    let sourceStatus = "queued";
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("select id from runs") && sql.includes("status = 'running' and external_state = 'streaming'")) {
        return [{ id: target }];
      }
      if (sql.includes('as "canSteer"')) {
        return [
          { id: source, status: sourceStatus, canSteer: false },
          { id: target, status: "running", canSteer: true },
        ];
      }
      if (sql.includes("select steer.id, steer.source_run_id as \"sourceRunId\"")) {
        return attemptStatus === "pending" || attemptStatus === "sending"
          ? [{ id: attempt, sourceRunId: source, sourceWorkflowId: null, text: "focus" }]
          : [];
      }
      if (sql.includes("select id, status, remote_stop_state")) {
        return [
          { id: source, status: sourceStatus },
          { id: target, status: "running", remoteStopState: null, leaseOwner: "worker-1", leaseGeneration: 3 },
        ];
      }
      if (sql.includes("select id, status from runs")) {
        return [{ id: source, status: sourceStatus }, { id: target, status: "running" }];
      }
      if (sql.includes("select status, forwarding_owner")) {
        return [{ status: attemptStatus, forwardingOwner: null, forwardingEpoch: 1 }];
      }
      if (sql.includes("select status from run_steering_attempts")) return [{ status: attemptStatus }];
      if (sql.includes("update run_steering_attempts set status = 'sending'")) {
        attemptStatus = "sending";
        return [{ forwardingEpoch: 1 }];
      }
      if (sql.includes("update run_steering_attempts set status = 'confirmed'")) {
        attemptStatus = "confirmed";
        return [];
      }
      if (sql.includes("update runs set status = 'cancelled'")) {
        sourceStatus = "cancelled";
        return [];
      }
      if (sql.includes('select steer.source_run_id as "runId"')) {
        return [{ runId: source, threadId: "thread-1", payload: { attemptId: attempt } }];
      }
      return [];
    });
    const client = {
      steerRun: async () => {
        await reconcileRunSteerEvent(db, { id: target, organizationId: org }, true);
        return 202;
      },
    } as unknown as HermesClient;

    await expect(forwardNextRunSteer(
      db,
      client,
      { workerId: "worker-1", leaseSeconds: 10 },
      { id: target, organizationId: org, threadId: "thread-1", leaseGeneration: 3 },
      "hermes-target-1",
      new AbortController().signal,
    )).resolves.toBe("confirmed");

    expect(attemptStatus).toBe("confirmed");
    expect(sourceStatus).toBe("cancelled");
    expect(queries.filter((query) => query.sql.includes("update run_steering_attempts set status = 'confirmed'")).length).toBe(1);
    expect(queries.filter((query) => query.sql.includes("update runs set status = 'cancelled'")).length).toBe(1);
  });

  test("une erreur Hermes ambiguë conserve son code et celui du relais", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("select id from runs") && sql.includes("status = 'running' and external_state = 'streaming'")) return [{ id: target }];
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: workflow, text: "focus" }];
      }
      if (sql.includes('as "canSteer"')) {
        return [
          { id: source, status: "queued", canSteer: false },
          { id: target, status: "running", canSteer: true },
        ];
      }
      if (sql.includes("select status from workflows")) return [{ status: "queued" }];
      if (sql.includes("select status from run_steering_attempts")) return [{ status: "pending" }];
      if (sql.includes("returning forwarding_epoch")) return [{ forwardingEpoch: 1 }];
      if (sql.includes("select id from run_steering_attempts")) return [{ id: attempt }];
      return [];
    });
    const error = new HermesClientError(
      "x".repeat(250),
      502,
      "HERMES_UNREACHABLE",
      {
        requestDelivery: "ambiguous",
        cause: new RelayDialError("timeout", "after_dispatch", "LINK_TIMEOUT"),
      },
    );
    const client = { steerRun: async () => { throw error; } } as unknown as HermesClient;

    await forwardNextRunSteer(
      db,
      client,
      { workerId: "worker-1", leaseSeconds: 10 },
      { id: target, organizationId: org, threadId: "thread-1", leaseGeneration: 3 },
      "hermes-target-1",
      new AbortController().signal,
    );

    const ambiguousUpdate = queries.find((query) => query.sql.includes("set status = 'ambiguous'"));
    expect(ambiguousUpdate?.values).toContain("HERMES_STEER_OUTCOME_UNKNOWN:HERMES_UNREACHABLE:LINK_TIMEOUT");
    expect(ambiguousUpdate?.values).toContain(502);
  });
});

describe("rejeu des steers non lus", () => {
  const attempts = [
    { id: "a-7", text: "message 7" },
    { id: "a-8", text: "message 8" },
    { id: "a-9", text: " message 9 " },
  ];

  test("la queue non lue est celle que Hermes rend, concaténée par un saut de ligne", () => {
    expect(undeliveredSteerTail(attempts, "message 8\nmessage 9").map((a) => a.id)).toEqual(["a-8", "a-9"]);
    expect(undeliveredSteerTail(attempts, "message 7\nmessage 8\nmessage 9\n").map((a) => a.id))
      .toEqual(["a-7", "a-8", "a-9"]);
    expect(undeliveredSteerTail(attempts, "message 9").map((a) => a.id)).toEqual(["a-9"]);
    expect(undeliveredSteerTail(attempts, "")).toEqual([]);
  });

  test("sans correspondance exacte, toute tentative dont le texte figure dans le rendu", () => {
    expect(undeliveredSteerTail(attempts, "message 7\n[retouché]\nmessage 9").map((a) => a.id)).toEqual(["a-7", "a-9"]);
    expect(undeliveredSteerTail(attempts, "tout autre chose")).toEqual([]);
  });

  test("un pending_steer réactive le run de repli et son workflow à leur rang", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer")) {
        return [
          { id: "a-7", sourceRunId: "source-7", sourceWorkflowId: "wf-7", text: "message 7" },
          { id: attempt, sourceRunId: source, sourceWorkflowId: workflow, text: "message 9" },
        ];
      }
      if (sql.includes("select id, status, completion_kind")) {
        return [
          { id: source, status: "cancelled", completionKind: "steered_into_active" },
          { id: target, status: "completed", completionKind: "final" },
        ];
      }
      if (sql.includes("select id, status, error_code")) return [{ id: attempt, status: "confirmed", errorCode: null }];
      return [];
    });

    const replayed = await replayUndeliveredRunSteers(db, { id: target, organizationId: org }, "message 9");

    expect(replayed).toBe(1);
    const requeues = queries.filter((query) => query.sql.includes("update runs set status = 'queued'"));
    expect(requeues).toHaveLength(1);
    expect(requeues[0]!.values).toContain(source);
    expect(requeues[0]!.values).not.toContain("source-7");
    expect(queries.some((query) => query.sql.includes("update workflows set status = 'queued'")
      && query.values.includes(workflow))).toBe(true);
    // Les identifiants passent par `tx([...])`, que le faux rend en « (a,b) ».
    expect(queries.some((query) => query.sql.includes("HERMES_STEER_UNDELIVERED")
      && query.values.some((value) => String(value).includes(attempt)))).toBe(true);
  });

  test("plusieurs non-lus donnent UN run fusionné, les autres replis se replient dedans", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer")) {
        return [
          { id: "a-7", sourceRunId: "source-7", sourceWorkflowId: "wf-7", text: "message 7" },
          { id: "a-8", sourceRunId: "source-8", sourceWorkflowId: "wf-8", text: "message 8" },
          { id: attempt, sourceRunId: source, sourceWorkflowId: workflow, text: "message 9" },
        ];
      }
      if (sql.includes("select id, status, completion_kind")) {
        return [
          { id: "source-8", status: "cancelled", completionKind: "steered_into_active" },
          { id: source, status: "cancelled", completionKind: "steered_into_active" },
          { id: target, status: "completed", completionKind: "final" },
        ];
      }
      if (sql.includes("select id, status, error_code")) {
        return [{ id: "a-8", status: "confirmed", errorCode: null }, { id: attempt, status: "confirmed", errorCode: null }];
      }
      return [];
    });

    const replayed = await replayUndeliveredRunSteers(db, { id: target, organizationId: org }, "message 8\nmessage 9");

    expect(replayed).toBe(2);
    const requeues = queries.filter((query) => query.sql.includes("update runs set status = 'queued'"));
    expect(requeues).toHaveLength(1);
    expect(requeues[0]!.values).toContain("source-8");
    expect(requeues[0]!.values).toContain("message 8\n\nmessage 9");
    expect(queries.some((query) => query.sql.includes("update workflows set status = 'queued'")
      && query.values.includes("wf-8"))).toBe(true);
    const folded = queries.find((query) => query.sql.includes("completion_kind = ") && query.sql.includes("update runs set completion_kind"));
    expect(folded).toBeDefined();
    expect(folded!.values).toContain("folded_into_followup");
    expect(folded!.values).toContain(source);
  });

  test("un pending_steer réactive le repli d'un DM simple, sans workflow à relancer", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: null, text: "message 9" }];
      }
      if (sql.includes("select id, status, completion_kind")) {
        return [
          { id: source, status: "cancelled", completionKind: "steered_into_active" },
          { id: target, status: "completed", completionKind: "final" },
        ];
      }
      if (sql.includes("select id, status, error_code")) return [{ id: attempt, status: "confirmed", errorCode: null }];
      if (sql.includes("from workflows")) throw new Error("aucun workflow à verrouiller");
      return [];
    });

    expect(await replayUndeliveredRunSteers(db, { id: target, organizationId: org }, "message 9")).toBe(1);
    const requeue = queries.find((query) => query.sql.includes("update runs set status = 'queued'"));
    expect(requeue?.values).toContain(source);
    expect(queries.some((query) => query.sql.includes("update workflows set"))).toBe(false);
  });

  test("une tentative déjà rejouée ou un repli déjà relancé ne bougent plus", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: workflow, text: "message 9" }];
      }
      if (sql.includes("select id, status, completion_kind")) {
        return [{ id: source, status: "queued", completionKind: null }, { id: target, status: "completed", completionKind: "final" }];
      }
      if (sql.includes("select id, status, error_code")) return [{ id: attempt, status: "confirmed", errorCode: "HERMES_STEER_UNDELIVERED" }];
      return [];
    });

    expect(await replayUndeliveredRunSteers(db, { id: target, organizationId: org }, "message 9")).toBe(0);
    expect(queries.some((query) => query.sql.includes("update runs set"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("update workflows set"))).toBe(false);
  });

  test("un pending_steer vide ne touche pas la base", async () => {
    const { db, queries } = fakeDb(() => []);
    expect(await replayUndeliveredRunSteers(db, { id: target, organizationId: org }, "   ")).toBe(0);
    expect(queries).toHaveLength(0);
  });
});

describe("file d'un tour occupé (OHB-117)", () => {
  test("le plafond d'un steer est 3, celui d'un run empoisonné reste celui de la file", () => {
    expect(MAX_RUN_STEER_ATTEMPTS).toBe(3);
    expect(STEER_TARGET_POISON_ATTEMPTS).toBe(MAX_RUN_ATTEMPTS);
  });

  test("un redémarrage relit un pending une fois, clé = id de tentative", async () => {
    let claimed = false;
    const posts: string[] = [];
    const { db } = fakeDb((sql) => {
      if (sql.includes("select id from runs") && sql.includes("status = 'running' and external_state = 'streaming'")) return [{ id: target }];
      if (sql.includes("from run_steering_attempts steer")) {
        return claimed ? [] : [{ id: attempt, sourceRunId: source, sourceWorkflowId: null, text: "focus" }];
      }
      if (sql.includes('as "canSteer"')) {
        return [
          { id: source, status: "queued", canSteer: false },
          { id: target, status: "running", canSteer: true },
        ];
      }
      if (sql.includes("select id, status, remote_stop_state")) {
        return [
          { id: source, status: "queued" },
          { id: target, status: "running", remoteStopState: null, leaseOwner: "worker-1", leaseGeneration: 3 },
        ];
      }
      if (sql.includes("select status from workflows")) throw new Error("aucun workflow à verrouiller");
      if (sql.includes("select status from run_steering_attempts")) return [{ status: "pending" }];
      if (sql.includes("select status, forwarding_owner")) {
        return [{ status: "sending", forwardingOwner: "worker-1", forwardingEpoch: 1 }];
      }
      if (sql.includes("returning forwarding_epoch")) {
        claimed = true;
        return [{ forwardingEpoch: 1 }];
      }
      return [];
    });
    const client = {
      steerRun: async (_hermesRunId: string, input: { idempotencyKey?: string }) => {
        posts.push(input.idempotencyKey ?? "");
        return 202;
      },
    } as unknown as HermesClient;
    const config = { workerId: "worker-1", leaseSeconds: 10 };
    const context = { id: target, organizationId: org, threadId: "thread-1", leaseGeneration: 3 };
    await expect(forwardNextRunSteer(db, client, config, context, "hermes-target-1", new AbortController().signal))
      .resolves.toBe("confirmed");
    await expect(forwardNextRunSteer(db, client, config, context, "hermes-target-1", new AbortController().signal))
      .resolves.toBe("none");
    expect(posts).toEqual([attempt]);
  });

  test("une livraison non partie se replie, puis s'épuise au plafond", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("select id from runs") && sql.includes("status = 'running' and external_state = 'streaming'")) return [{ id: target }];
      if (sql.includes("from run_steering_attempts steer")) {
        return [{ id: attempt, sourceRunId: source, sourceWorkflowId: workflow, text: "focus" }];
      }
      if (sql.includes('as "canSteer"')) {
        return [
          { id: source, status: "queued", canSteer: false },
          { id: target, status: "running", canSteer: true },
        ];
      }
      if (sql.includes("select status from workflows")) return [{ status: "queued" }];
      if (sql.includes("select status from run_steering_attempts")) return [{ status: "pending" }];
      if (sql.includes("returning forwarding_epoch")) return [{ forwardingEpoch: 1 }];
      return [];
    });
    const error = new HermesClientError("down", 503, "HERMES_UNREACHABLE", { requestDelivery: "not_sent" });
    const client = { steerRun: async () => { throw error; } } as unknown as HermesClient;
    await expect(forwardNextRunSteer(
      db, client, { workerId: "worker-1", leaseSeconds: 10 },
      { id: target, organizationId: org, threadId: "thread-1", leaseGeneration: 3 },
      "hermes-target-1", new AbortController().signal,
    )).resolves.toBe("retry");
    const retry = queries.find((query) => query.sql.includes("STEER_ATTEMPTS_EXHAUSTED"));
    expect(retry?.sql).toContain("attempts >= ");
    expect(retry?.values).toContain(MAX_RUN_STEER_ATTEMPTS);
    expect(queries.find((query) => query.sql.includes("from run_steering_attempts steer"))?.sql)
      .toContain("steer.attempts < ");
  });

  test("expiration, échec et lien coupé terminalisent le pending, pas un tour encore réclamé", async () => {
    const { db, queries } = fakeDb((sql) => {
      if (sql.includes("from run_steering_attempts steer cross join runs target")) {
        return [{ id: attempt, organizationId: org, targetRunId: target, sourceRunId: source }];
      }
      return [];
    });
    await db.begin((tx) => withRunReceiptJournalTx(tx, recoverRunSteersBeforeClaim));
    const expiry = queries.find((query) => query.sql.includes("update run_steering_attempts steer set status = 'expired'"));
    expect(expiry).toBeDefined();
    expect(expiry?.sql).toContain("STEER_RUNTIME_DISCONNECTED");
    expect(expiry?.sql).toContain("STEER_TARGET_INACTIVE");
    expect(expiry?.sql).toContain("coalesce(target_workflow.deadline_at, target.deadline_at)");
    expect(expiry?.sql).toContain("target.error_code = 'RUNTIME_DISCONNECTED'");
    expect(expiry?.sql).toContain("source.workflow_id is not null and source_workflow.status is distinct from 'queued'");
    expect(expiry?.sql).not.toContain("target.hermes_run_id is null");
    expect(expiry?.values).toContain(STEER_TARGET_POISON_ATTEMPTS);
    expect(expiry?.values).toContain(MAX_RUN_STEER_ATTEMPTS);
  });
});
