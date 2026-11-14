import {
  BOT_REPLY_LANGUAGES,
  type BotReplyLanguage,
  type BotSettingProposalFields,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { readEditorSettings } from "@openedbot/roster/domain/bot-input";
import { PERSONA_MAX_CHARS } from "@openedbot/roster/domain/persona";

export const BOT_SETTINGS_TOOL_SERVER = "openedbot_bot_settings";
export const BOT_SETTINGS_TOOL_NAME = "bot_settings_propose";
export const BOT_SETTINGS_TOOL_RUNTIME_NAME = `mcp_${BOT_SETTINGS_TOOL_SERVER}_${BOT_SETTINGS_TOOL_NAME}`;

export function withBotSettingsRunKey(input: string, key: string): string {
  return `${input}\n\n[bot_settings_propose run_key: ${key}]`;
}

export const BOT_SETTINGS_TOOL_DESCRIPTION = [
  "Propose a change to your own persona (system instructions), label, reply language, or finish notice.",
  "Nothing is applied until the operator approves the proposal card shown in this thread.",
  "Never say the change is done. Tell the operator that your proposal is waiting for approval.",
  "To edit your persona, send the FULL new persona text in `instructions`.",
  "Give a one-line reason and copy `run_key` exactly from your instructions.",
].join(" ");

export const BOT_SETTINGS_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    run_key: { type: "string", minLength: 1, maxLength: 200 },
    reason: { type: "string", minLength: 1, maxLength: 500 },
    instructions: { type: "string", minLength: 1, maxLength: PERSONA_MAX_CHARS },
    label: { type: ["string", "null"], minLength: 1, maxLength: 60 },
    reply_language: { type: "string", enum: [...BOT_REPLY_LANGUAGES] },
    notify_on_finish: { type: "boolean" },
  },
  required: ["run_key", "reason"],
  additionalProperties: false,
} as const;

export class BotSettingsToolInputError extends Error {}

export type BotSettingsToolArgs = {
  runKey: string;
  reason: string;
  proposed: BotSettingProposalFields;
};

const ALLOWED_KEYS = new Set([
  "run_key",
  "reason",
  "instructions",
  "label",
  "reply_language",
  "notify_on_finish",
]);

export function readBotSettingsToolArgs(value: unknown): BotSettingsToolArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotSettingsToolInputError("arguments must be an object.");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) throw new BotSettingsToolInputError(`Unknown argument: ${key}.`);
  }
  const runKey = boundedText(input.run_key, "run_key", 200);
  const reason = boundedText(input.reason, "reason", 500);
  if (!runKey) throw new BotSettingsToolInputError("run_key is required: copy it from your instructions.");
  if (!reason) throw new BotSettingsToolInputError("reason is required and must be 1 to 500 characters.");

  const proposed: BotSettingProposalFields = {};
  if (Object.hasOwn(input, "instructions")) {
    if (typeof input.instructions !== "string") throw new BotSettingsToolInputError("instructions must be a string.");
    const instructions = input.instructions.trim();
    if (!instructions || instructions.length > PERSONA_MAX_CHARS) {
      throw new BotSettingsToolInputError(`instructions must be 1 to ${PERSONA_MAX_CHARS} characters.`);
    }
    proposed.instructions = instructions;
  }

  const editorInput: Record<string, unknown> = {};
  if (Object.hasOwn(input, "label")) {
    if (typeof input.label === "string" && !input.label.trim()) {
      throw new BotSettingsToolInputError("label must be 1 to 60 characters or null.");
    }
    editorInput.label = input.label;
  }
  if (Object.hasOwn(input, "reply_language")) editorInput.replyLanguage = input.reply_language;
  if (Object.hasOwn(input, "notify_on_finish")) editorInput.notifyOnFinish = input.notify_on_finish;
  try {
    const settings = readEditorSettings(editorInput);
    if (Object.hasOwn(settings, "label")) proposed.label = settings.label;
    if (Object.hasOwn(settings, "replyLanguage")) proposed.replyLanguage = settings.replyLanguage as BotReplyLanguage;
    if (Object.hasOwn(settings, "notifyOnFinish")) proposed.notifyOnFinish = settings.notifyOnFinish;
  } catch (error) {
    if (error instanceof HttpError) throw new BotSettingsToolInputError(error.message);
    throw error;
  }
  if (Object.keys(proposed).length === 0) throw new BotSettingsToolInputError("Propose at least one setting to change.");
  return { runKey, reason, proposed };
}

function boundedText(value: unknown, label: string, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) return null;
  return trimmed;
}
