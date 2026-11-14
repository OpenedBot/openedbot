import type { ApprovalRequestDto, MessageAuthorBot, ThreadMessageDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type {
  TimelineModelInput,
  TimelineRun,
  TimelineUserInput,
} from "../../src/lib/thread/thread-timeline-model";

/**
 * A synthetic thread that exercises every branch of the model: text
 * fragments, tools (succeeded, failed, with an attachment), events with no render,
 * plans, web searches, approval requests, ask_user, hand-off, steering,
 * delivered mail (`bot.message`), and in a room the passes and the turns with no
 * human message.
 */
export type ThreadFixture = Omit<TimelineModelInput, "running" | "defaultAuthor" | "mentionables" | "operatorUsername" | "activeAskUserRunId" | "toolFallbackLabel"> & {
  events: StoredProductEvent[];
  userInputs: TimelineUserInput[];
  messages: ThreadMessageDto[];
  approvals: ApprovalRequestDto[];
  runs: TimelineRun[];
};

const BASE = Date.parse("2026-09-01T08:00:00.000Z");
const NEO: MessageAuthorBot = { id: "bot-neo", name: "Neo", slug: "neo", face: null };
const TRINITY: MessageAuthorBot = { id: "bot-trinity", name: "Trinity", slug: "trinity", face: null };

const ANSWER = [
  "Voici ce que j'ai trouvé.\n\n",
  "Principes techniques :\n\n- un **domaine** isolé\n- des ",
  "adaptateurs fins\n\n```ts\nconst x = 1;\n\nexport default x;\n",
  "```\n\nDomain : entités, value objects et ",
  "règles.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n",
  "En résumé : ça tient.",
];

export function threadFixture({
  turns,
  group = false,
  toolsPerTurn = 3,
  liveLastTurn = true,
}: {
  turns: number;
  group?: boolean;
  toolsPerTurn?: number;
  liveLastTurn?: boolean;
}): ThreadFixture {
  const events: StoredProductEvent[] = [];
  const userInputs: TimelineUserInput[] = [];
  const messages: ThreadMessageDto[] = [];
  const approvals: ApprovalRequestDto[] = [];
  const runs: TimelineRun[] = [];
  const runAuthors = new Map<string, MessageAuthorBot>();
  let cursor = 0;
  let clock = BASE;
  const at = (offset = 1_000) => {
    clock += offset;
    return new Date(clock);
  };
  const emit = (runId: string, type: StoredProductEvent["type"], payload: Record<string, unknown>) => {
    cursor += 1;
    events.push({ cursor, runId, sequence: cursor, type, payload, occurredAt: at() } as StoredProductEvent);
  };
  const userMessage = (id: string, runId: string | null, text: string, authorBot: MessageAuthorBot | null = null) => {
    const createdAt = at(5_000).toISOString();
    userInputs.push({ id, runId, text, createdAt, authorBot, attachments: [] });
    messages.push({
      id,
      role: "user",
      runId,
      createdAt,
      authorBot,
      content: [{ type: "text", text }],
      ...(id.endsWith("3") ? { reactions: [{ emoji: "👍", count: 1, reactedByMe: true }] } : {}),
    });
  };

  for (let turn = 0; turn < turns; turn += 1) {
    const runId = `run-${turn}`;
    const last = turn === turns - 1;
    const live = last && liveLastTurn;

    if (group && turn % 7 === 3) {
      // An operator message with no run, then a room turn with no human message.
      userMessage(`msg-${turn}`, null, `Salut le salon ${turn}`);
      const groupRun = `grp-${turn}`;
      runs.push({ id: groupRun, status: "completed", stepKind: "group" });
      runAuthors.set(groupRun, turn % 2 ? NEO : TRINITY);
      emit(groupRun, "agent.message", { text: `Tour de salon ${turn}. ` });
      emit(groupRun, "agent.message", { text: "Fin." });
      if (turn % 3 === 0) emit(groupRun, "system.notice", { kind: "group.pass" });
      emit(groupRun, "run.completed", {});
      continue;
    }

    userMessage(`msg-${turn}`, runId, `Question ${turn} : peux-tu regarder @neo ?`);
    if (group) runAuthors.set(runId, turn % 2 ? NEO : TRINITY);
    runs.push({ id: runId, status: live ? "running" : "completed", stepKind: "root" });

    if (turn % 12 === 11 && !last) {
      // A message written during the reply: absorbed by this run.
      const steered = `steer-${turn}`;
      runs.push({ id: steered, status: "cancelled", completionKind: "steered_into_active" });
      userMessage(`msg-steer-${turn}`, steered, `Précision ${turn}`);
    }

    if (turn % 5 === 0) {
      emit(runId, "raw", {
        agentPlan: {
          steps: [
            { id: "s1", content: "Lire", status: "completed" },
            { id: "s2", content: "Écrire", status: live ? "in_progress" : "completed" },
          ],
        },
      });
    }
    if (turn % 6 === 0) {
      emit(runId, "raw", {
        webSearch: {
          queries: [{ id: "q1", query: `requête ${turn}`, sources: [{ title: "Doc", url: "https://example.com", domain: "example.com" }], error: null, resultCount: 3 }],
        },
      });
    }
    emit(runId, "agent.message", { text: "Je regarde " });
    emit(runId, "agent.message", { text: "ça." });
    emit(runId, "agent.reasoning", { text: "hmm" });
    for (let tool = 0; tool < toolsPerTurn; tool += 1) {
      emit(runId, "tool.call", { tool: tool % 2 ? "web_search" : "terminal", toolCallId: `tc_${tool}`, preview: `ls ${tool}` });
      emit(runId, "tool.result", { toolCallId: `tc_${tool}`, error: tool === 1 && turn % 4 === 0, durationMs: 120 + tool });
      if (tool === 0) emit(runId, "tool.result.attached", {
        toolCallId: `tc_${tool}`,
        input: `ls ${tool}`,
        result: `sortie ${turn}`,
      });
      emit(runId, "raw", { note: "bruit" });
    }
    if (turn % 9 === 4) {
      const approvalId = `appr-${turn}`;
      emit(runId, "approval.requested", { approvalRequestId: approvalId, command: "rm -rf /tmp/x" });
      approvals.push({
        id: approvalId,
        runId,
        threadId: "thread-1",
        kind: "command",
        action: "rm -rf /tmp/x",
        detail: null,
        choices: ["once", "deny"],
        status: "pending",
        requestedAt: at().toISOString(),
        respondedAt: null,
      });
      emit(runId, "tool.call", { tool: "terminal", toolCallId: "tc_after", preview: "rm" });
    }
    for (const fragment of ANSWER) emit(runId, "agent.message", { text: fragment });
    if (turn % 8 === 7) emit(runId, "agent.message", { text: "\n\n@user Tu préfères laquelle ?\n- A\n- B" });
    if (turn % 11 === 10) {
      emit(runId, "agent.message", { text: "\n\n@neo vérifie la prod" });
      emit(runId, "system.notice", { kind: "handoff.sent", message: "Transmis à 🤖 Neo (@neo)" });
    }
    if (turn % 13 === 12) {
      const delivered = `delivered-${turn}`;
      userMessage(delivered, runId, `Réponse de Neo ${turn}`, NEO);
      emit(runId, "bot.message", { messageId: delivered });
    }
    if (!live) {
      emit(runId, "run.completed", {});
      messages.push({
        id: `asst-${turn}`,
        role: "assistant",
        runId,
        createdAt: at().toISOString(),
        content: [{ type: "text", text: ANSWER.join("") }],
        ...(turn % 3 === 0 ? { reactions: [{ emoji: "❤️", count: 2, reactedByMe: false }] } : {}),
      });
    }
  }

  return { events, userInputs, messages, approvals, runs, ...(group ? { runAuthors } : {}) };
}

export function modelInput(fixture: ThreadFixture, overrides: Partial<TimelineModelInput> = {}): TimelineModelInput {
  return {
    running: true,
    defaultAuthor: fixture.runAuthors ? null : NEO,
    mentionables: [{ id: NEO.id, slug: "neo", name: "Neo", face: null }],
    operatorUsername: "elodie",
    activeAskUserRunId: null,
    toolFallbackLabel: "outil",
    ...fixture,
    ...overrides,
  };
}

/**
 * The SSE patch as `applyProductEventToSnapshot` does it: a new
 * events array, and only the touched run changes object.
 */
export function appendEvent(input: TimelineModelInput, event: StoredProductEvent): TimelineModelInput {
  return {
    ...input,
    events: [...input.events, event],
    runs: input.runs.map((run) => (run.id === event.runId ? { ...run } : run)),
  };
}
