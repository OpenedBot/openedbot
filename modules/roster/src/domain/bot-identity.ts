import type { BotFaceSpec } from "@openedbot/contracts-api";

/**
 * Identity leaf types shared by roster prompts and client search surfaces
 * (the console imports them from `@openedbot/roster/domain/bot-identity`).
 */

export type BotIdentity = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  threadId: string;
};

/**
 * The operator as the protocol names them. `username` is the handle they
 * chose (`operator_profile`); `null` until they have one, in which case the
 * protocol falls back to the generic `@user` alias.
 */
export type OperatorIdentity = { username: string } | null;

/** Token used to address the operator; `@user` when no handle is set. */
export const operatorHandle = (operator: OperatorIdentity): string =>
  operator?.username ?? "user";

export type MentionableBot = {
  id: string;
  name: string;
  slug: string;
  face: BotFaceSpec | null;
};

/** Lowercase, NFD decomposition, diacritics stripped, trimmed. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}
