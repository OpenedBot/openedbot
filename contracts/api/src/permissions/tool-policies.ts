/**
 * PERM2-5 (DEV-OHB-255): the per-tool policy of a bot, iso Grok Bot. A tool
 * without a stored value follows the bot's mode (`inherit`); `always`
 * pre-approves it, `ask` sends it to a human, `block` refuses it in the
 * pipeline AND in the host plugin (`blocked_tools`), proven by re-read.
 */

export type BotToolPolicyValue = "inherit" | "always" | "ask" | "block";

export const BOT_TOOL_POLICY_VALUES: readonly BotToolPolicyValue[] = ["inherit", "always", "ask", "block"];

/**
 * Twin of `APPROVAL_POLICY_TOOL_KEY` (`platform/hermes/src/parsers/profiles.ts`)
 * and of `approvalPolicyToolKeyRe` (`edge-setup/internal/operator/approval_policy.go`),
 * and of the `tool_key` check of migration 0141.
 */
export const BOT_TOOL_POLICY_KEY = /^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$/;

/**
 * The native tools the host plugin gates and describes (spec section 7). The
 * other native tools are not gated (reads, ordinary terminal) or always
 * forbidden (`cronjob`): no selector for them.
 */
export const BOT_TOOL_POLICY_NATIVE_TOOLS = ["write_file", "patch", "skill_manage", "send_message", "execute_code"] as const;

/** The host plugin keeps at most 64 blocked keys per profile. */
export const BOT_TOOL_POLICY_MAX_BLOCKED = 64;

/** Stored values per bot, `inherit` excluded (it is never stored by the API). */
export const BOT_TOOL_POLICY_MAX_STORED = 256;

/** Entries per write request. */
export const BOT_TOOL_POLICY_MAX_PER_WRITE = 64;

/** A tool key a policy may be set on: a gated native tool or an MCP tool. */
export function isBotToolPolicyKey(key: string): boolean {
  if (!BOT_TOOL_POLICY_KEY.test(key)) return false;
  return key.startsWith("mcp:") || (BOT_TOOL_POLICY_NATIVE_TOOLS as readonly string[]).includes(key);
}

/**
 * An operation the pipeline always sends to a human outside `bypass`: the
 * `execute_code` descriptor is opaque (`permission-decision.ts` stage
 * `opaque`) and an MCP tool never proves it deletes nothing, since Hermes
 * keeps no `destructiveHint` (`gate-identity.ts`, `deletes = unknown`, stage
 * `deletion`). `always` would be stored without any effect, so it is refused.
 */
export function isBotToolPolicyAlwaysRefused(key: string): boolean {
  return key === "execute_code" || key.startsWith("mcp:");
}

export type BotToolPolicyDto = {
  toolKey: string;
  /** Never `inherit`: an inherited tool has no row. */
  policy: Exclude<BotToolPolicyValue, "inherit">;
  updatedAt: string;
  updatedByKind: "member" | "agency";
};

export type BotToolPoliciesDto = {
  botId: string;
  policies: BotToolPolicyDto[];
  /** The current operator may write (owner, admin, mandated agency). */
  writable: boolean;
  /**
   * Tool policies are decided by the `v2` pipeline only: under `legacy` they
   * are kept but not applied, and writes are refused.
   */
  enforced: boolean;
  /**
   * The host side of `block`: `proven` when the profile's re-read blocked list
   * equals the stored blocked keys, `pending` while the worker reconciles it,
   * `none` when the bot has no host profile the link can write.
   */
  hostBlocked: "proven" | "pending" | "none";
};

export type BotToolPolicyWrite = {
  toolKey: string;
  policy: BotToolPolicyValue;
};
