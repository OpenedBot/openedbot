import { describe, expect, test } from "bun:test";
import {
  EVENT_ENVELOPE_VERSION,
  organizationEventEnvelope,
  runTurnId,
  type OrganizationEvent,
  type RunEventRecord,
} from "@openedbot/contracts-events";

const occurredAt = new Date("2026-10-03T12:00:00.000Z");

/** What `insert … returning` yields on the worker side: bigint cursor, Date. */
const returned: RunEventRecord = {
  cursor: "42",
  organizationId: "org-1",
  threadId: "thread-1",
  runId: "run-1",
  botId: "bot-1",
  turnId: "run-root",
  sessionKey: "openedbot:org-1:workflow:wf-1:bot:bot-1",
  leaseGeneration: "3",
  sequence: 7,
  type: "agent.message",
  payload: { delta: "salut" },
  occurredAt,
};

describe("organizationEventEnvelope", () => {
  test("normalise les types SQL et porte toute l identité", () => {
    expect(organizationEventEnvelope(returned)).toEqual({
      version: EVENT_ENVELOPE_VERSION,
      cursor: 42,
      organizationId: "org-1",
      threadId: "thread-1",
      runId: "run-1",
      botId: "bot-1",
      turnId: "run-root",
      sessionKey: "openedbot:org-1:workflow:wf-1:bot:bot-1",
      leaseGeneration: 3,
      sequence: 7,
      type: "agent.message",
      payload: { delta: "salut" },
      occurredAt: "2026-10-03T12:00:00.000Z",
    });
  });

  test("une ligne écrite et sa relecture donnent la même trame, octet pour octet", () => {
    // Reread: the driver may return the cursor as a number, the lease as a bigint
    // and the timestamp as a non-ISO string.
    const replayed: RunEventRecord = {
      ...returned,
      cursor: 42n,
      leaseGeneration: 3n,
      occurredAt: "2026-10-03 14:00:00+02",
    };
    expect(JSON.stringify(organizationEventEnvelope(replayed)))
      .toBe(JSON.stringify(organizationEventEnvelope(returned)));
  });

  test("avant le commit le curseur est absent, le reste de l'enveloppe tient", () => {
    const { cursor: _cursor, ...pending } = returned;
    const live = organizationEventEnvelope(pending);
    expect(live).not.toHaveProperty("cursor");
    expect(live).toMatchObject({
      version: EVENT_ENVELOPE_VERSION,
      organizationId: "org-1",
      runId: "run-1",
      botId: "bot-1",
      turnId: "run-root",
      sequence: 7,
      type: "agent.message",
    });
    expect(Object.keys(organizationEventEnvelope(returned)).filter((key) => key !== "cursor"))
      .toEqual(Object.keys(live));
  });

  test("une ligne antérieure à 0092 sort avec une identité nulle, pas absente", () => {
    const legacy = organizationEventEnvelope({
      ...returned, botId: null, turnId: null, sessionKey: null, leaseGeneration: null,
    });
    expect(legacy.leaseGeneration).toBeNull();
    expect(legacy.turnId).toBeNull();
    expect(Object.keys(legacy)).toContain("botId");
  });

  test("un client d avant la version 1 lit encore la trame", () => {
    // The type keeps the new optional fields: a v0 frame stays valid.
    const v0: OrganizationEvent = {
      cursor: 1, organizationId: "org-1", threadId: null, runId: "run-1",
      sequence: 0, type: "run.completed", payload: {}, occurredAt: occurredAt.toISOString(),
    };
    expect(v0.version).toBeUndefined();
  });
});

describe("runTurnId", () => {
  test("une étape de workflow appartient au tour de son run racine", () => {
    expect(runTurnId({ runId: "step-2", workflowRootRunId: "root" })).toBe("root");
  });

  test("un run hors workflow est son propre tour", () => {
    expect(runTurnId({ runId: "dm-run", workflowRootRunId: null })).toBe("dm-run");
  });
});
