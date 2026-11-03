import { describe, expect, test } from "bun:test";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import { readTerminalCompletion } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { TransactionDb } from "@openedbot/platform-db";
import { attachTerminalCompletions, completionEligible } from "../src/application/terminal-event-completion";

type Call = { sql: string; values: unknown[] };

type Fixture = {
  messages?: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
  workflows?: Array<Record<string, unknown>>;
};

function fakeTx(calls: Call[], fixture: Fixture): TransactionDb {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    // `tx(list)` : l'aide de Bun pour une liste `in (…)`. Elle ne lit pas la
    // base : elle rend un fragment interpolable. Le stub rend la liste
    // elle-même, ce qui la fait apparaître dans les `values` de l'appel.
    if (!(strings as TemplateStringsArray & { raw?: readonly string[] }).raw) return strings;
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.includes("from messages m")) return Promise.resolve(fixture.messages ?? []);
    if (sql.includes("from runs where")) return Promise.resolve(fixture.runs ?? []);
    if (sql.includes("from workflows w")) return Promise.resolve(fixture.workflows ?? []);
    return Promise.resolve([]);
  }) as unknown as TransactionDb;
  return tag;
}

function event(overrides: Partial<OrganizationEvent> = {}): OrganizationEvent {
  return {
    cursor: 12,
    organizationId: "org_1",
    threadId: "thr_1",
    runId: "run_1",
    sequence: 3,
    type: "run.completed",
    payload: { output: "Voilà.", usage: null },
    occurredAt: "2026-01-01T00:00:05.000Z",
    ...overrides,
  } as OrganizationEvent;
}

const assistantRow = {
  id: "msg_final",
  role: "assistant",
  content: [{ type: "text", text: "Voilà." }],
  runId: "run_1",
  authorBotId: null,
  authorBotName: null,
  authorBotSlug: null,
  authorBotFace: null,
  replyToId: null,
  replyToRole: null,
  replyToContent: null,
  replyAuthorBotId: null,
  replyAuthorBotName: null,
  replyAuthorBotSlug: null,
  replyAuthorBotFace: null,
  createdAt: new Date("2026-01-01T00:00:05.000Z"),
};

const runRow = {
  id: "run_1",
  status: "completed",
  output: "Voilà.",
  usage: { inputTokens: 10, outputTokens: 2 },
  error: null,
  endedAt: new Date("2026-01-01T00:00:05.000Z"),
  lastEventAt: new Date("2026-01-01T00:00:05.000Z"),
  workflowId: null,
  completionKind: "normal",
  recoveryState: null,
};

describe("completionEligible", () => {
  test.each([
    ["run.completed", { type: "run.completed", payload: {} }, true],
    ["run.error", { type: "run.error", payload: { message: "boom" } }, true],
    ["annulation", { type: "system.notice", payload: { kind: "cancelled" } }, true],
    ["avis de salon", { type: "system.notice", payload: { kind: "group.pass" } }, false],
    ["delta", { type: "agent.message", payload: { text: "Voi" } }, false],
    ["gate", { type: "approval.requested", payload: {} }, false],
    ["type inconnu d'un serveur plus récent", { type: "future.thing", payload: {} }, false],
  ])("%s", (_label, overrides, expected) => {
    expect(completionEligible(event(overrides as Partial<OrganizationEvent>))).toBe(expected);
  });

  test("charge utile absente : aucun accès sur `undefined`", () => {
    expect(completionEligible({ ...event(), payload: undefined } as unknown as OrganizationEvent)).toBe(true);
  });
});

describe("attachTerminalCompletions", () => {
  test("aucun événement terminal : aucune requête supplémentaire", async () => {
    const calls: Call[] = [];
    const delta = event({ type: "agent.message", payload: { text: "Voi" } });
    const events = await attachTerminalCompletions(fakeTx(calls, {}), "org_1", [delta]);

    expect(calls).toHaveLength(0);
    expect(events[0]).toBe(delta);
  });

  test("le bloc joint est exactement ce que le client sait relire", async () => {
    const calls: Call[] = [];
    const [enriched] = await attachTerminalCompletions(fakeTx(calls, {
      messages: [assistantRow],
      runs: [runRow],
    }), "org_1", [event()]);

    const completion = readTerminalCompletion(enriched as unknown as StoredProductEvent);
    expect(completion).not.toBeNull();
    expect(completion?.messages.map((message) => message.id)).toEqual(["msg_final"]);
    expect(completion?.messages[0]?.createdAt).toBe("2026-01-01T00:00:05.000Z");
    expect(completion?.run.status).toBe("completed");
    expect(completion?.run.endedAt).toBe("2026-01-01T00:00:05.000Z");
    expect(completion?.workflow).toBeNull();
    // La charge utile d'origine reste intacte : `payload.output` est lu par la
    // recherche dans le fil et par les tests de contrat.
    expect(enriched?.payload.output).toBe("Voilà.");
  });

  test("une seule paire de requêtes pour tous les runs conclus de la page", async () => {
    const calls: Call[] = [];
    const events = [
      event({ cursor: 10, runId: "run_a", sequence: 2 }),
      event({ cursor: 11, runId: "run_b", sequence: 2 }),
      event({ cursor: 12, runId: "run_a", type: "agent.message", payload: { text: "x" } }),
    ];
    await attachTerminalCompletions(fakeTx(calls, {}), "org_1", events);

    expect(calls).toHaveLength(3);
    const runIds = calls[0]?.values.find((value) => Array.isArray(value));
    expect(runIds).toEqual(["run_a", "run_b"]);
  });

  test("l'invite de l'opérateur est exclue de la lecture", async () => {
    const calls: Call[] = [];
    await attachTerminalCompletions(fakeTx(calls, { runs: [runRow] }), "org_1", [event()]);

    const messagesQuery = calls.find((call) => call.sql.includes("from messages m"));
    expect(messagesQuery?.sql).toContain("m.role = 'assistant' or m.author_bot_id is not null");
  });

  test("run introuvable (purge, fil supprimé) : rien n'est joint", async () => {
    const calls: Call[] = [];
    const [enriched] = await attachTerminalCompletions(
      fakeTx(calls, { messages: [assistantRow], runs: [] }),
      "org_1",
      [event()],
    );

    expect(enriched?.payload.completion).toBeUndefined();
    expect(readTerminalCompletion(enriched as unknown as StoredProductEvent)).toBeNull();
  });

  test("étape de workflow : le workflow du run part avec l'événement", async () => {
    const calls: Call[] = [];
    const [enriched] = await attachTerminalCompletions(fakeTx(calls, {
      messages: [assistantRow],
      runs: [{ ...runRow, workflowId: "wf_1" }],
      workflows: [{
        id: "wf_1",
        kind: "dm",
        status: "completed",
        rootRunId: "run_1",
        rootBotId: "bot_1",
        usedSteps: 1,
        maxSteps: 8,
        usedHandoffs: 0,
        maxHandoffs: 3,
        usedTokens: "1200",
        tokenBudget: "50000",
        notificationSequence: "4",
        deadlineAt: new Date("2026-01-01T01:00:00.000Z"),
        errorCode: null,
        errorMessage: null,
        finalOutput: "Voilà.",
        recoveryState: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:05.000Z"),
      }],
    }), "org_1", [event()]);

    const completion = readTerminalCompletion(enriched as unknown as StoredProductEvent);
    expect(completion?.workflow?.status).toBe("completed");
    // Les compteurs arrivent de PostgreSQL en `bigint`, donc en chaîne : les
    // laisser tels quels ferait diverger le patch du snapshot rechargé.
    expect(completion?.workflow?.usedTokens).toBe(1_200);
    expect(completion?.workflow?.tokenBudget).toBe(50_000);
    expect(completion?.workflow?.updatedAt).toBe("2026-01-01T00:00:05.000Z");
  });

  test("run.error : pas de message, mais l'erreur et le statut sont là", async () => {
    const calls: Call[] = [];
    const [enriched] = await attachTerminalCompletions(fakeTx(calls, {
      runs: [{ ...runRow, status: "failed", output: null, error: "Hermes injoignable." }],
    }), "org_1", [event({ type: "run.error", payload: { message: "Hermes injoignable." } })]);

    const completion = readTerminalCompletion(enriched as unknown as StoredProductEvent);
    expect(completion?.messages).toEqual([]);
    expect(completion?.run.status).toBe("failed");
    expect(completion?.run.error).toBe("Hermes injoignable.");
  });

  test("statut interne : le client ne voit que le vocabulaire public", async () => {
    const calls: Call[] = [];
    const [enriched] = await attachTerminalCompletions(fakeTx(calls, {
      runs: [{ ...runRow, status: "unknown", recoveryState: "needs_review" }],
    }), "org_1", [event()]);

    const completion = readTerminalCompletion(enriched as unknown as StoredProductEvent);
    expect(completion?.run.status).toBe("failed");
    expect(completion?.run.recoveryState).toBe("needs_review");
  });
});
