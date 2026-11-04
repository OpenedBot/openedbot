import { describe, expect, test } from "bun:test";
import { prepareGroupTurn } from "../../src/application/runner/rooms";
import type { RunContext } from "../../src/application/runner/types";

type Line = {
  role: string;
  content: unknown;
  sequence: number;
  runId: string | null;
  authorBotId: string | null;
  authorName: string | null;
  authorSlug: string | null;
  runStatus: string | null;
  workflowId: string | null;
};

const text = (value: string) => [{ type: "text", text: value }];

/**
 * Le salon en base. Le faux moteur applique le filtre de statut seulement si
 * la requête le porte : sans lui, la consigne annulée revient telle quelle.
 */
function fakeDb(lines: Line[], context: { id: string; workflowId: string }): Bun.SQL {
  return ((strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ");
    if (sql.includes("from bot_groups")) return Promise.resolve([{ name: "Salon", instructions: "" }]);
    if (sql.includes("from group_members")) return Promise.resolve([]);
    if (sql.includes("from messages m")) {
      const filtered = sql.includes("message_run.status = 'completed'")
        ? lines.filter((line) => line.role !== "user" || line.runId === null || line.runId === context.id
          || line.runStatus === "completed" || line.workflowId === context.workflowId)
        : lines;
      return Promise.resolve([...filtered].sort((left, right) => right.sequence - left.sequence));
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
}

const context = {
  id: "run-2",
  organizationId: "org-1",
  threadId: "thread-1",
  groupId: "group-1",
  workflowId: "workflow-2",
  botId: "bot-1",
  botName: "Ada",
  botSlug: "ada",
  botDescription: null,
  stepIndex: 0,
  groupState: null,
  operator: { username: "Camille" },
  instructions: "",
  webToolsEnabled: false,
} as unknown as RunContext;

describe("prepareGroupTurn", () => {
  test("une consigne annulée avant exécution ne revient pas comme entrée à traiter", async () => {
    const turn = await prepareGroupTurn(fakeDb([
      {
        role: "user", content: text("Supprime rapport.txt"), sequence: 1, runId: "run-1",
        authorBotId: null, authorName: null, authorSlug: null, runStatus: "cancelled", workflowId: "workflow-1",
      },
      {
        role: "user", content: text("Résume le compte rendu"), sequence: 2, runId: "run-2",
        authorBotId: null, authorName: null, authorSlug: null, runStatus: "running", workflowId: "workflow-2",
      },
    ], { id: context.id, workflowId: context.workflowId! }), context);

    expect(turn?.kind).toBe("speak");
    const input = turn && turn.kind === "speak" ? turn.input : "";
    expect(input).toContain("Résume le compte rendu");
    expect(input).not.toContain("Supprime rapport.txt");
  });
});
