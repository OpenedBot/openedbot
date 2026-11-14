import { createHash } from "node:crypto";
import type { BotSettingProposalDto, BotSettingProposalFields } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { TransactionDb } from "@openedbot/platform-db";
import { setBotInstructions } from "../sql/bot-activity";
import {
  insertBotSettingProposal,
  listThreadBotSettingProposals,
  lockBotSettingProposal,
  lockBotSettingsTarget,
  readBotSettingsTarget,
  resolveBotSettingProposal,
  supersedePendingBotSettingProposals,
  toBotSettingProposalDto,
  updateBotSettingFields,
} from "../sql/bot-setting-proposals";

export function canonicalBotSettingProposalHash(fields: BotSettingProposalFields): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function proposeBotSettings(
  tx: TransactionDb,
  input: {
    organizationId: string;
    botId: string;
    runId: string;
    threadId: string;
    reason: string;
    proposed: BotSettingProposalFields;
  },
): Promise<BotSettingProposalDto> {
  const target = await lockBotSettingsTarget(tx, input.organizationId, input.botId);
  if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot not found.");
  const current: BotSettingProposalFields = {};
  const proposed: BotSettingProposalFields = {};
  addIfChanged("instructions", input.proposed, target.instructions, current, proposed);
  addIfChanged("label", input.proposed, target.label, current, proposed);
  addIfChanged("replyLanguage", input.proposed, target.replyLanguage as BotSettingProposalFields["replyLanguage"], current, proposed);
  addIfChanged("notifyOnFinish", input.proposed, target.notifyOnFinish, current, proposed);
  if (Object.keys(proposed).length === 0) {
    throw new HttpError(409, "BOT_SETTING_PROPOSAL_NO_CHANGE", "The proposed values already match the bot's settings.");
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new HttpError(400, "BOT_SETTING_PROPOSAL_REASON_INVALID", "The reason must be 1 to 500 characters.");
  }
  await supersedePendingBotSettingProposals(tx, input.organizationId, input.botId);
  const row = await insertBotSettingProposal(tx, {
    ...input,
    reason,
    current,
    proposed,
    hash: canonicalBotSettingProposalHash(proposed),
    baseUpdatedAt: target.updatedAt,
  });
  return toBotSettingProposalDto(row);
}

export async function listThreadProposals(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
): Promise<BotSettingProposalDto[]> {
  return listThreadBotSettingProposals(tx, organizationId, threadId);
}

export async function decideBotSettingProposal(
  tx: TransactionDb,
  input: {
    organizationId: string;
    proposalId: string;
    botId: string;
    userId: string;
    decision: "apply" | "reject";
    expectedHash: string;
  },
): Promise<BotSettingProposalDto> {
  const proposal = await lockBotSettingProposal(tx, input.organizationId, input.proposalId, input.botId);
  if (!proposal) throw new HttpError(404, "BOT_SETTING_PROPOSAL_NOT_FOUND", "Proposal not found.");
  if (proposal.status !== "pending") {
    throw new HttpError(409, "BOT_SETTING_PROPOSAL_NOT_PENDING", "This proposal is no longer pending.");
  }
  if (proposal.hash !== input.expectedHash) {
    throw new HttpError(409, "BOT_SETTING_PROPOSAL_HASH_MISMATCH", "The proposal changed after it was shown.");
  }
  if (input.decision === "reject") {
    const rejected = await resolveBotSettingProposal(tx, input.organizationId, proposal.id, "rejected", input.userId);
    if (!rejected) throw new HttpError(409, "BOT_SETTING_PROPOSAL_NOT_PENDING", "This proposal is no longer pending.");
    return toBotSettingProposalDto(rejected);
  }

  const target = await lockBotSettingsTarget(tx, input.organizationId, input.botId);
  if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot not found.");
  if (target.updatedAt !== proposal.baseUpdatedAt) {
    const stale = await resolveBotSettingProposal(tx, input.organizationId, proposal.id, "stale", input.userId);
    if (!stale) throw new HttpError(409, "BOT_SETTING_PROPOSAL_NOT_PENDING", "This proposal is no longer pending.");
    return toBotSettingProposalDto(stale);
  }

  if (Object.hasOwn(proposal.proposed, "instructions")) {
    const saved = await setBotInstructions(tx, input.organizationId, input.botId, proposal.proposed.instructions!);
    if (!saved) throw new HttpError(404, "BOT_NOT_FOUND", "Bot not found.");
  }
  const settingFields: Pick<BotSettingProposalFields, "label" | "replyLanguage" | "notifyOnFinish"> = {};
  if (Object.hasOwn(proposal.proposed, "label")) settingFields.label = proposal.proposed.label;
  if (Object.hasOwn(proposal.proposed, "replyLanguage")) settingFields.replyLanguage = proposal.proposed.replyLanguage;
  if (Object.hasOwn(proposal.proposed, "notifyOnFinish")) settingFields.notifyOnFinish = proposal.proposed.notifyOnFinish;
  if (Object.keys(settingFields).length > 0) {
    const saved = await updateBotSettingFields(tx, input.organizationId, input.botId, settingFields);
    if (!saved) throw new HttpError(404, "BOT_NOT_FOUND", "Bot not found.");
  }

  const verified = await readBotSettingsTarget(tx, input.organizationId, input.botId);
  if (!verified || !fieldsMatch(verified, proposal.proposed)) {
    throw new HttpError(500, "BOT_SETTING_PROPOSAL_UNVERIFIED", "The saved settings could not be verified.");
  }
  const applied = await resolveBotSettingProposal(tx, input.organizationId, proposal.id, "applied", input.userId);
  if (!applied) throw new HttpError(409, "BOT_SETTING_PROPOSAL_NOT_PENDING", "This proposal is no longer pending.");
  return toBotSettingProposalDto(applied);
}

function addIfChanged<K extends keyof BotSettingProposalFields>(
  key: K,
  source: BotSettingProposalFields,
  currentValue: BotSettingProposalFields[K],
  current: BotSettingProposalFields,
  proposed: BotSettingProposalFields,
): void {
  if (!Object.hasOwn(source, key)) return;
  const nextValue = source[key];
  if (Object.is(currentValue, nextValue)) return;
  current[key] = currentValue;
  proposed[key] = nextValue;
}

function fieldsMatch(
  target: { instructions: string; label: string | null; replyLanguage: string; notifyOnFinish: boolean },
  proposed: BotSettingProposalFields,
): boolean {
  return (!Object.hasOwn(proposed, "instructions") || target.instructions === proposed.instructions)
    && (!Object.hasOwn(proposed, "label") || target.label === proposed.label)
    && (!Object.hasOwn(proposed, "replyLanguage") || target.replyLanguage === proposed.replyLanguage)
    && (!Object.hasOwn(proposed, "notifyOnFinish") || target.notifyOnFinish === proposed.notifyOnFinish);
}
