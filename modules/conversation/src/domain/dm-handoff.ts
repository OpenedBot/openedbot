import { parseMentions, type BotIdentity, type HandoffMention } from "@openedbot/roster/domain/bot-mode";

/** La décision du fil DM : hand-off si l'opérateur mentionne un autre bot joignable, run ordinaire sinon. */
export function dmHandoffMention(
  input: string,
  selfBotId: string,
  roster: readonly BotIdentity[],
): HandoffMention | null {
  return parseMentions(input, roster, { selfBotId, mode: "user" });
}
