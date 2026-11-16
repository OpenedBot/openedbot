import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { HermesClient } from "@openedbot/hermes";
import { RunTrace } from "@openedbot/platform-observability/run-trace";
import { buildRuntimeMemoryBlock } from "@openedbot/roster/domain/bot-memory";
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
