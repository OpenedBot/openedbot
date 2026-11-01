import { describe, expect, test } from "bun:test";
import { backfillToolErrorMessageTx, insertToolErrorTx, purgeOldToolErrors, toolErrorRow } from "../src/application/tool-errors";

const at = new Date("2026-09-03T10:00:00.000Z");

describe("toolErrorRow", () => {
  test("un tool.result en échec devient une ligne, message null quand le runtime s'est tu", () => {
    expect(toolErrorRow({
      type: "tool.result",
      occurredAt: at,
      payload: { tool: "skill_manage", toolCallId: "tc_6", error: true, durationMs: 27, errorMessage: null, hasResultPayload: false },
    })).toEqual({ tool: "skill_manage", toolCallId: "tc_6", errorMessage: null, durationMs: 27, occurredAt: at });
  });

  test("un succès, ou un autre événement, ne produit rien", () => {
    expect(toolErrorRow({ type: "tool.result", occurredAt: at, payload: { tool: "terminal", toolCallId: "tc_0", error: false } })).toBeNull();
    expect(toolErrorRow({ type: "tool.call", occurredAt: at, payload: { tool: "terminal", toolCallId: "tc_0" } })).toBeNull();
  });

  test("le message est rebordé à 500 et la durée arrondie", () => {
    const row = toolErrorRow({
      type: "tool.result",
      occurredAt: at,
      payload: { tool: "terminal", toolCallId: "tc_1", error: true, durationMs: 12.6, errorMessage: "x".repeat(900) },
    });
    expect(row?.errorMessage?.length).toBe(500);
    expect(row?.durationMs).toBe(13);
  });

  test("garde le motif connu d'un échec remonté pendant le run", () => {
    expect(toolErrorRow({
      type: "tool.result",
      occurredAt: at,
      payload: { tool: "execute_code", toolCallId: "tc_2", error: true, errorMessage: "kernel unavailable" },
    })?.errorMessage).toBe("kernel unavailable");
  });
});

describe("backfillToolErrorMessageTx", () => {
  test("remplit uniquement une ligne sans motif, dans le contexte du run", async () => {
    let sql = "";
    let bindings: unknown[] = [];
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      sql = [...strings].join(" ");
      bindings = values;
      return Promise.resolve([]);
    }) as unknown as Bun.SQL;
    await backfillToolErrorMessageTx(tx, { id: "run-1", organizationId: "org-1" }, "tc_2", "kernel unavailable");
    expect(sql).toContain("update tool_errors set error_message =");
    expect(sql).toContain("and error_message is null");
    expect(bindings).toEqual(["kernel unavailable", "org-1", "run-1", "tc_2"]);
  });
});

describe("insertToolErrorTx", () => {
  test("écrit dans tool_errors et relit l'auteur dans message_ingress, sans autre requête", async () => {
    const statements: string[] = [];
    const bindings: unknown[][] = [];
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push([...strings].join(" "));
      bindings.push(values);
      return Promise.resolve([]);
    }) as unknown as Bun.SQL;

    await insertToolErrorTx(
      tx,
      { id: "run-1", organizationId: "org-1", threadId: "thread-1", botId: "bot-1" },
      { tool: "skill_manage", toolCallId: "tc_6", errorMessage: null, durationMs: 27, occurredAt: at },
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("insert into tool_errors");
    expect(statements[0]).toContain("from message_ingress");
    expect(bindings[0]).toEqual(["org-1", "bot-1", "thread-1", "run-1", "org-1", "run-1", "skill_manage", "tc_6", null, 27, at]);
  });
});

describe("purgeOldToolErrors", () => {
  test("supprime par occurred_at avec une borne concrète et rend le compte", async () => {
    let sql = "";
    let bound: unknown[] = [];
    const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      sql = [...strings].join(" ");
      bound = values;
      return Promise.resolve([{ count: "3" }]);
    }) as unknown as Bun.SQL;
    const purged = await purgeOldToolErrors(db, 90, new Date("2026-09-03T00:00:00.000Z"));
    expect(purged).toBe(3);
    expect(sql).toContain("delete from tool_errors where occurred_at <");
    expect(bound[0]).toEqual(new Date("2026-06-05T00:00:00.000Z"));
  });
});
