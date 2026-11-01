import { describe, expect, test } from "bun:test";
import {
  BotSettingsToolInputError,
  readBotSettingsToolArgs,
  withBotSettingsRunKey,
} from "../src/domain/bot-settings-tool";
import { readBotSettingsRunKey, signBotSettingsRunKey } from "../src/application/bot-settings-run-key";
import { readRoutineRunKey, signRoutineRunKey } from "../src/application/routine-run-key";

const RUN = "93190000-0000-4000-8000-000000000101";

describe("bot settings proposal tool", () => {
  test("reads the permitted fields and trims text", () => {
    expect(readBotSettingsToolArgs({
      run_key: " key ",
      reason: " improve clarity ",
      instructions: " Full persona text ",
      label: " Calm helper ",
      reply_language: "fr",
      notify_on_finish: false,
    })).toEqual({
      runKey: "key",
      reason: "improve clarity",
      proposed: {
        instructions: "Full persona text",
        label: "Calm helper",
        replyLanguage: "fr",
        notifyOnFinish: false,
      },
    });
  });

  test("rejects unknown keys and an empty proposal", () => {
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r", model: "new-model" }))
      .toThrow(BotSettingsToolInputError);
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r" }))
      .toThrow(BotSettingsToolInputError);
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r", speech_rate: 1 }))
      .toThrow(BotSettingsToolInputError);
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r", permission_mode: "bypass" }))
      .toThrow(BotSettingsToolInputError);
  });

  test("rejects values outside the editor setting classes", () => {
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r", instructions: " " }))
      .toThrow(BotSettingsToolInputError);
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r", label: "x".repeat(61) }))
      .toThrow(BotSettingsToolInputError);
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r", reply_language: "xx" }))
      .toThrow(BotSettingsToolInputError);
    expect(() => readBotSettingsToolArgs({ run_key: "k", reason: "r", notify_on_finish: "yes" }))
      .toThrow(BotSettingsToolInputError);
  });

  test("run keys are signed for one tool purpose", () => {
    const routineKey = signRoutineRunKey("shared secret", RUN);
    const settingsKey = signBotSettingsRunKey("shared secret", RUN);
    expect(readRoutineRunKey("shared secret", routineKey)).toBe(RUN);
    expect(readBotSettingsRunKey("shared secret", settingsKey)).toBe(RUN);
    expect(readRoutineRunKey("shared secret", settingsKey)).toBeNull();
    expect(readBotSettingsRunKey("shared secret", routineKey)).toBeNull();
    expect(withBotSettingsRunKey("input", settingsKey)).toBe(`input\n\n[bot_settings_propose run_key: ${settingsKey}]`);
  });
});
