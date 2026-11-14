import {
  applyMention,
  matchBots,
  type MentionableBot,
  type TextRange,
} from "@openedbot/roster/domain/mentions";
import { matchMcpPluginsByPrefix } from "../runtime/mcp-plugins";

/** One row of the `@` list: a bot to mention, or a connector to name. */
export type MentionOption =
  | { kind: "bot"; bot: MentionableBot }
  | { kind: "plugin"; name: string };

/** Bots first (their own order), then the connectors that start like the query. */
export function buildMentionOptions(
  query: string,
  bots: readonly MentionableBot[],
  plugins: readonly string[],
): MentionOption[] {
  return [
    ...matchBots(query, [...bots]).map((bot): MentionOption => ({ kind: "bot", bot })),
    ...matchMcpPluginsByPrefix(query, plugins).map((name): MentionOption => ({ kind: "plugin", name })),
  ];
}

/** Keyed by kind: a bot id and a connector name can never collide. */
export const mentionOptionKey = (option: MentionOption) =>
  option.kind === "bot" ? `bot-${option.bot.id}` : `plugin-${option.name}`;

/**
 * Replaces the `@query` token by the connector's plain name and a space,
 * as the « + » menu does: no `@name`, so no fake bot mention is sent.
 */
export function applyPluginPick(
  text: string,
  range: TextRange,
  name: string,
): { text: string; caret: number } {
  const replacement = `${name} `;
  return {
    text: text.slice(0, range.start) + replacement + text.slice(range.end),
    caret: range.start + replacement.length,
  };
}

/** Applies a pick from the `@` list or the hint: a bot becomes `@slug`, a connector its plain name. */
export function applyMentionPick(
  text: string,
  range: TextRange,
  pick: MentionableBot | MentionOption,
): { text: string; caret: number } {
  const option: MentionOption = "kind" in pick ? pick : { kind: "bot", bot: pick };
  return option.kind === "bot"
    ? applyMention(text, range, option.bot.slug)
    : applyPluginPick(text, range, option.name);
}
