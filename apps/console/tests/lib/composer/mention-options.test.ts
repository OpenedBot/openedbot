import { expect, test } from "bun:test";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import { applyMentionPick } from "../../../src/lib/composer/mention-options";

const neo = { id: "b1", slug: "neo" } as unknown as MentionableBot;
const range = { start: 4, end: 7 };

test("applyMentionPick turns a bot pick, bare or wrapped, into @slug", () => {
  const expected = { text: "hey @neo  ok", caret: 9 };
  expect(applyMentionPick("hey @ne ok", range, neo)).toEqual(expected);
  expect(applyMentionPick("hey @ne ok", range, { kind: "bot", bot: neo })).toEqual(expected);
});

test("applyMentionPick names a connector in plain text, without an @", () => {
  expect(applyMentionPick("use @gi now", { start: 4, end: 7 }, { kind: "plugin", name: "github" })).toEqual({
    text: "use github  now",
    caret: 11,
  });
});
