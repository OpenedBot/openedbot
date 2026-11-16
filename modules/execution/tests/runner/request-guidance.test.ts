import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { HermesClient } from "@openedbot/hermes";
import { RunTrace } from "@openedbot/platform-observability/run-trace";
import { buildRuntimeMemoryBlock } from "@openedbot/roster/domain/bot-memory";
import { routineToolRule } from "@openedbot/roster/domain/routine-tool-rule";
import { HISTORY_CLOSING_NOTE, PLATFORM_METADATA_HEADER } from "@openedbot/conversation/domain/history-framing";
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { readRoutineRunKey } from "../../src/application/routine-run-key";
import { composeRunRequest } from "../../src/application/runner/creation";
import type { RunContext } from "../../src/application/runner/types";
import type { WorkerConfig } from "../../src/application/worker-config";

// Exercise the real composer, including independent memory guidance and history.
const query = async (strings: TemplateStringsArray) => {
  const sql = strings.join("?");
  if (["from messages", "from message_versions", "from bot_playbooks", "set_config"].some((part) => sql.includes(part))) return [];
  throw new Error(`Unexpected query: ${sql}`);
};
const db = Object.assign(query, { begin: async (fn: (tx: typeof query) => unknown) => fn(query) }) as unknown as SQL;
const client = new HermesClient({ transport: { kind: "direct", send: async () => { throw new Error("No runtime call expected"); } } });

describe("request guidance follows enabled tools", () => {
  test.each([[false, false], [true, false], [false, true], [true, true]])(
    "memory=%s, skills=%s: only announce enabled tools",
    async (memory, skills) => {
      const context = {
        id: "run", organizationId: "org", threadId: "thread", botId: "bot",
        botName: "Bot", botSlug: "bot", botDescription: null, operator: null,
        input: "ça va ti ?", stepKind: "root", workflowId: null, originRunId: null,
        groupId: null, groupTurnPosition: null, groupState: null,
        routineToolEnabled: false, botSettingsToolEnabled: false,
        instructions: buildRuntimeMemoryBlock({ toolEnabled: memory }), memoryToolEnabled: memory,
      } as RunContext;
      const request = await composeRunRequest(db, {} as WorkerConfig, context, client, new AbortController().signal, new RunTrace(), {
        turn: null,
        selection: { model: "test", provider: "test", reasoningEffort: null },
        toolsetInventory: [
          { name: "memory", enabled: memory, label: "Memory", description: null, configured: true, tools: ["memory"] },
          { name: "skills", enabled: skills, label: "Skills", description: null, configured: true, tools: ["skills_list", "skill_view", "skill_manage"] },
        ],
      });
      expect(request.instructions.includes("## Learning")).toBe(skills);
      for (const tool of ["skills_list", "skill_view", "skill_manage"]) {
        expect(request.instructions.includes(tool)).toBe(skills);
      }
      expect(request.instructions.includes("call `memory` (`action: add`) BEFORE replying")).toBe(memory);
      expect(request.input).toBe("ça va ti ?");
    },
  );
});

describe("tool metadata leaves the user's message (2026-11-16)", () => {
  const RUN = "92090000-0000-4000-8000-000000000101";
  const SECRET = "request-guidance-secret";
  const replayed = [
    { role: "user", content: [{ type: "text", text: "Crée une routine news IA à 8h" }], sequence: 1, interruptedStatus: null, interruptedTools: null },
    { role: "assistant", content: [{ type: "text", text: "Je ne peux pas programmer de routine ici." }], sequence: 2, interruptedStatus: null, interruptedTools: null },
  ];
  const withHistory = async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("from messages m")) return replayed;
    if (["from message_versions", "from bot_playbooks", "set_config"].some((part) => sql.includes(part))) return [];
    throw new Error(`Unexpected query: ${sql}`);
  };
  const historyDb = Object.assign(withHistory, { begin: async (fn: (tx: typeof withHistory) => unknown) => fn(withHistory) }) as unknown as SQL;
  const compose = (input: string) => composeRunRequest(historyDb, { internalSecrets: testInternalSecrets("worker", SECRET) } as WorkerConfig, {
    id: RUN, organizationId: "org", threadId: "thread", botId: "bot",
    botName: "Bot", botSlug: "bot", botDescription: null, operator: null,
    input, stepKind: "root", workflowId: null, originRunId: null,
    groupId: null, groupTurnPosition: null, groupState: null,
    routineToolEnabled: true, routineUserTimezone: "Europe/Paris", botSettingsToolEnabled: false,
    instructions: routineToolRule("enabled"), memoryToolEnabled: false,
  } as RunContext, client, new AbortController().signal, new RunTrace(), {
    turn: null,
    selection: { model: "test", provider: "test", reasoningEffort: null },
    toolsetInventory: [],
  });

  test("the user's text travels alone; the run key and timezone close the history", async () => {
    const request = await compose("re");
    expect(request.input).toBe("re");
    expect(request.turnInput).toBe("re");
    expect(request.turnInput).not.toContain("[routine_manage");
    expect(request.history.slice(0, 2).map((entry) => entry.role)).toEqual(["user", "assistant"]);
    const note = request.history.at(-1)!;
    expect(note.role).toBe("user");
    const [closing, header, line] = note.content.split("\n");
    expect(closing).toBe(HISTORY_CLOSING_NOTE);
    expect(header).toBe(PLATFORM_METADATA_HEADER);
    const match = /^routine_manage run_key: (\S+); user timezone: Europe\/Paris\]$/.exec(line ?? "");
    expect(readRoutineRunKey(SECRET, match?.[1] ?? "")).toBe(RUN);
  });

  test("the closing note is the same on every turn; only the key line moves", async () => {
    const first = (await compose("re")).history.at(-1)!.content.split("\n");
    const second = (await compose("Hey")).history.at(-1)!.content.split("\n");
    expect(first.slice(0, 2)).toEqual(second.slice(0, 2));
  });
});
