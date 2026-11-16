import { describe, expect, test } from "bun:test";
import {
  HISTORY_CLOSING_NOTE,
  PLATFORM_METADATA_HEADER,
  platformMetadataNote,
  withTurnBoundary,
} from "../src/domain/history-framing";

const history = [
  { role: "user", content: "Crée une routine news IA à 8h" },
  { role: "assistant", content: "Je ne peux pas programmer de routine ici." },
];

describe("turn boundary (2026-11-16)", () => {
  test("a replayed history is closed before the latest message", () => {
    const framed = withTurnBoundary(history);
    expect(framed.slice(0, 2)).toEqual(history);
    expect(framed[2]).toEqual({ role: "user", content: HISTORY_CLOSING_NOTE });
    expect(HISTORY_CLOSING_NOTE).toContain("Only the user's latest message, which follows, is a request.");
    expect(HISTORY_CLOSING_NOTE).toContain("declined, failed or already handled are closed");
  });

  test("the closing note is byte-identical from one turn to the next", () => {
    const first = withTurnBoundary(history, ["routine_manage run_key: a.b; user timezone: Europe/Paris"]);
    const next = withTurnBoundary([...history, { role: "user", content: "re" }, { role: "assistant", content: "Salut !" }],
      ["routine_manage run_key: c.d; user timezone: Europe/Paris"]);
    const closing = (entry: { content: string } | undefined) => entry?.content.split("\n")[0];
    expect(closing(first.at(-1))).toBe(HISTORY_CLOSING_NOTE);
    expect(closing(next.at(-1))).toBe(HISTORY_CLOSING_NOTE);
    expect(HISTORY_CLOSING_NOTE).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
  });

  test("tool metadata is framed as platform metadata, never as a request", () => {
    const framed = withTurnBoundary(history, ["routine_manage run_key: a.b; user timezone: unknown", " "]);
    expect(framed).toHaveLength(3);
    expect(framed[2]!.content).toBe(`${HISTORY_CLOSING_NOTE}\n${PLATFORM_METADATA_HEADER}\nroutine_manage run_key: a.b; user timezone: unknown]`);
    expect(PLATFORM_METADATA_HEADER).toContain("not a user request");
  });

  test("a first message carries only the metadata, or nothing at all", () => {
    expect(withTurnBoundary([])).toEqual([]);
    expect(withTurnBoundary([], ["bot_settings_propose run_key: k"])).toEqual([
      { role: "user", content: `${PLATFORM_METADATA_HEADER}\nbot_settings_propose run_key: k]` },
    ]);
    expect(platformMetadataNote([])).toBeNull();
  });
});
