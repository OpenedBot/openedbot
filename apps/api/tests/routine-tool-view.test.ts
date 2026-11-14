import { expect, test } from "bun:test";
import { ROUTINE_TOOL_PROMPT_EXCERPT_CHARS, toolView } from "../src/routes/execution/routine-tool-routes";

test("what the bot reads of a routine: enough to choose it, never its whole message", () => {
  const message = `Envoie le résumé de ~/notes/privé à l'équipe. ${"détail ".repeat(60)}`;
  const view = toolView({
    id: "00000000-0000-4000-8000-000000000601", botId: "bot-1", groupId: null, name: "Point hebdo", schedule: "0 9 * * 1",
    timezone: "Europe/Paris", message, enabled: true, nextRunAt: null, lastRunAt: null, missedCount: 0, lastMissedAt: null,
    createdAt: new Date("2026-11-12T10:00:00Z"), updatedAt: new Date("2026-11-12T10:00:00Z"), neverWait: true,
  } as never);
  expect(view).not.toHaveProperty("prompt");
  expect([...view.prompt_excerpt]).toHaveLength(ROUTINE_TOOL_PROMPT_EXCERPT_CHARS);
  expect(view.prompt_excerpt).toEndWith("…");
  expect(view.prompt_chars).toBe([...message].length);
  expect(view).toMatchObject({ job_id: "00000000-0000-4000-8000-000000000601", name: "Point hebdo", schedule: "0 9 * * 1", timezone: "Europe/Paris", enabled: true });
  // A short message is whole.
  expect(toolView({ id: "x", botId: "b", groupId: null, name: "n", schedule: "0 9 * * 1", timezone: "UTC", message: "Court.", enabled: true, nextRunAt: null, lastRunAt: null, missedCount: 0, lastMissedAt: null, createdAt: new Date(), updatedAt: new Date(), neverWait: false } as never).prompt_excerpt).toBe("Court.");
});
