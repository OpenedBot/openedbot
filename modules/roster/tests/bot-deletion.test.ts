import { describe, expect, test } from "bun:test";
import { workflowSessionKey } from "../src/domain/autonomous-workflow";
import { botRuntimeSessionIds } from "../src/domain/bot-deletion";
import { personaDraftSessionKey } from "../src/domain/persona-draft";
import { compactionSessionKey } from "@openedbot/conversation/domain/thread-compaction";

/**
 * Ce que la purge doit viser sur le runtime du client. Quatre des cinq
 * familles ne sont nommées nulle part dans `threads` : les oublier laisserait
 * sur son VPS la mémoire extraite de son bot et ses brouillons de persona,
 * c'est-à-dire précisément ce qu'il croit avoir effacé.
 */
describe("botRuntimeSessionIds", () => {
  const ids = botRuntimeSessionIds("org-1", "bot-1", {
    threads: [
      { sessionId: "ohb:org-1:thread-1", threadId: "thread-1" },
      { sessionId: "ohb:org-1:thread-2", threadId: "thread-2" },
    ],
    workflows: [{ workflowId: "wf-1" }],
  });

  test("couvre les familles de sessions qu'OHB ouvre pour un bot, accueil compris", () => {
    expect(new Set(ids)).toEqual(new Set([
      "ohb:org-1:thread-1",
      "ohb:org-1:thread-2",
      "ohb:org-1:compact:thread:thread-1",
      "ohb:org-1:compact:thread:thread-2",
      "ohb:org-1:thread-1:greeting",
      "ohb:org-1:thread-2:greeting",
      "ohb:org-1:workflow:wf-1:bot:bot-1",
      "ohb:org-1:persona-draft:bot:bot-1",
    ]));
  });

  test("dédoublonne : un DELETE rejoué compterait deux effacements pour une session", () => {
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("réutilise les fabriques partagées plutôt que de redire la forme des clés", () => {
    expect(ids).toContain(compactionSessionKey("org-1", "thread-1"));
    expect(ids).toContain(personaDraftSessionKey("org-1", "bot-1"));
    expect(ids).toContain(workflowSessionKey("org-1", "wf-1", "bot-1"));
  });

  test("un bot sans fil ni workflow garde sa session de service", () => {
    expect(botRuntimeSessionIds("org-1", "bot-1", { threads: [], workflows: [] })).toEqual([
      "ohb:org-1:persona-draft:bot:bot-1",
    ]);
  });

  test("un fil passé à d'autres générations de session (0163) les efface toutes", () => {
    const rotated = botRuntimeSessionIds("org-1", "bot-1", {
      threads: [{ sessionId: "ohb:org-1:thread-1", threadId: "thread-1", sessionGeneration: 2 }],
      workflows: [],
    });
    expect(rotated).toContain("ohb:org-1:thread-1");
    expect(rotated).toContain("ohb:org-1:thread-1:gen1");
    expect(rotated).toContain("ohb:org-1:thread-1:gen2");
    expect(rotated).not.toContain("ohb:org-1:thread-1:gen3");
  });
});
