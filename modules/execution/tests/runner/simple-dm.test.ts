import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { simpleDmStep } from "../../src/application/runner/handoff";
import { dmInstructions } from "../../src/application/runner/instructions";
import { workflowAutonomyAllowsDelegation } from "../../src/application/runner/workflows";

const base = {
  organizationId: "org-1",
  botId: "bot-neo",
  botName: "Neo",
  botSlug: "neo",
  botDescription: null,
  instructions: "Tu es Neo.",
  operator: null,
  groupId: null,
  groupTurnPosition: null,
  originRunId: null,
};

describe("tour de DM simple sans workflow", () => {
  test.each([[false, false, false], [false, true, false], [true, false, false], [true, true, true]])(
    "the workflow snapshot (%s) and current flag (%s) must both authorize delegation",
    (snapshot, current, permitted) => {
      expect(workflowAutonomyAllowsDelegation(snapshot, current)).toBe(permitted);
    },
  );
  test("seul un tour racine d'opérateur sans workflow est un DM simple", () => {
    expect(simpleDmStep({ ...base, workflowId: null, stepKind: "root" })).toBe(true);
    expect(simpleDmStep({ ...base, workflowId: "wf-1", stepKind: "root" })).toBe(false);
    expect(simpleDmStep({ ...base, workflowId: null, stepKind: "delegated" })).toBe(false);
    // Les runs historiques sans `step_kind` gardent leur chemin d'origine.
    expect(simpleDmStep({ ...base, workflowId: null, stepKind: null })).toBe(false);
    expect(simpleDmStep({ ...base, workflowId: null, stepKind: "root", groupId: "group-1" })).toBe(false);
    expect(simpleDmStep({ ...base, workflowId: null, stepKind: "root", originRunId: "courier-1" })).toBe(false);
  });

  test("ses instructions ne lisent ni roster ni compteurs de workflow, et n'annoncent aucun bot", async () => {
    const db = (() => {
      throw new Error("aucune requête attendue");
    }) as unknown as SQL;
    const prompt = await dmInstructions(db, { ...base, workflowId: null, stepKind: "root", memoryToolEnabled: true });
    expect(prompt.limitsLine).toBeNull();
    expect(prompt.instructions.startsWith("Tu es Neo.")).toBe(true);
    expect(prompt.instructions).toContain("## Bot mode");
    expect(prompt.instructions).toContain("No other bot is reachable right now.");
    expect(prompt.instructions).not.toContain("Durable bot workflow");
    expect(prompt.instructions).toContain("You cannot schedule anything");
    expect(prompt.instructions).toContain("\"Routines…\"");
  });

  test("routine_manage activé : le bot planifie par l'outil, sans clé dans les instructions (DEV-209)", async () => {
    const db = (() => {
      throw new Error("aucune requête attendue");
    }) as unknown as SQL;
    const prompt = await dmInstructions(db, { ...base, workflowId: null, stepKind: "root", routineToolEnabled: true });
    expect(prompt.instructions).toContain("mcp_openedbot_routines_routine_manage");
    expect(prompt.instructions).not.toContain("You cannot schedule anything");
    expect(prompt.instructions).not.toMatch(/run_key: [0-9a-f]{8}-/);
  });

  test("une étape de workflow relit toujours son budget durable", async () => {
    const queries: string[] = [];
    const db = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      queries.push(sql);
      if (sql.includes("from workflows")) {
        return Promise.resolve([{ maxDepth: 3, maxSteps: 8, maxHandoffs: 4, usedSteps: 1, usedHandoffs: 0 }]);
      }
      return Promise.resolve([]);
    }) as unknown as SQL;
    const prompt = await dmInstructions(db, {
      ...base, workflowId: "wf-1", stepKind: "root", stackDepth: 0, callerBotId: null,
      autonomyEnabled: true, workflowAutonomyEnabled: true,
    });
    expect(queries.some((sql) => sql.includes("from workflows"))).toBe(true);
    expect(prompt.instructions).toContain("Durable bot workflow");
    expect(prompt.limitsLine).toContain("step 1 of at most 8");
  });

  test.each([false, true])("the prompt uses the current flag (%s), not the stale run context", async (enabled) => {
    const db = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      if (sql.includes("autonomy_enabled as enabled")) return Promise.resolve([{ enabled }]);
      if (sql.includes("from workflows")) return Promise.resolve([
        { maxDepth: 3, maxSteps: 8, maxHandoffs: 4, usedSteps: 1, usedHandoffs: 0 },
      ]);
      if (sql.includes("from bots b")) return Promise.resolve([
        { id: "bot-bravo", name: "Bravo", slug: "bravo", description: null, threadId: "bravo-thread" },
      ]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    const prompt = await dmInstructions(db, {
      ...base, workflowId: "wf-1", stepKind: "root", stackDepth: 0, callerBotId: null,
      autonomyEnabled: !enabled, workflowAutonomyEnabled: true,
    });
    expect(prompt.instructions.includes("@bravo")).toBe(enabled);
    expect(prompt.instructions).not.toContain("[Workflow limits] step");
    expect(prompt.limitsLine).toContain("[Workflow limits] step");
  });
});
