import type { PermissionRulesMode } from "./policy";

/**
 * PERM2-6: natural-language permission rules, iso Grok Bot.
 * A rule guides the automatic reviewer only: it is data the reviewer reads,
 * never a decision. Interdictions, the floor, the deletion stage, `block`
 * and the command blocklist are decided before the reviewer and no rule can
 * relax them.
 *
 * A rule belongs to one bot or to the whole organization; the
 * organization's `rulesMode` says whether its rules add to a bot's own or
 * replace them. "Ask first" wins over "allow".
 */

export const PERMISSION_RULE_KINDS = ["allow", "ask_first"] as const;

export type PermissionRuleKind = (typeof PERMISSION_RULE_KINDS)[number];

/** Twin of the `text` check of migration 0145. */
export const PERMISSION_RULE_MAX_CHARS = 1_000;

/**
 * Per (scope, kind), twin of `bot_permission_rules_limit` (0145). Past it an
 * addition is refused (`PERMISSION_RULES_LIMIT`), never the oldest rule
 * silently dropped as Grok Bot does (`slice(-20)`, operator decision D-4).
 */
export const PERMISSION_RULES_MAX_PER_KIND = 20;

export type PermissionRuleScope = "bot" | "organization";

export type PermissionRuleDto = {
  id: string;
  kind: PermissionRuleKind;
  /** Whitespace collapsed and secrets masked when it was saved. */
  text: string;
  createdAt: string;
  createdByKind: "member" | "agency";
};

export type PermissionRulesView = {
  scope: PermissionRuleScope;
  /** The bot, for a bot scope; `null` for the organization's rules. */
  botId: string | null;
  rules: PermissionRuleDto[];
  /** The current operator may add and remove rules here. */
  writable: boolean;
  /** Rules are read by the reviewer of the `v2` pipeline only. */
  enforced: boolean;
  /**
   * The organization's choice: with `replaces`, a bot's own rules are kept
   * but not read by the reviewer while the organization's apply.
   */
  rulesMode: PermissionRulesMode;
};

export type PermissionRuleInput = {
  kind: PermissionRuleKind;
  text: string;
};
