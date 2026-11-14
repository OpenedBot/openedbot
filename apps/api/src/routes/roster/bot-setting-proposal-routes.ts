import { isUuid } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import type { BotSettingProposalDecisionInput } from "@openedbot/contracts-api";
import { decideBotSettingProposal } from "@openedbot/roster/application/bot-setting-proposals";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";

export function botSettingProposalRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/:botId/setting-proposals/:proposalId/decision", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const botId = readUuid(context.req.param("botId"));
    const proposalId = readUuid(context.req.param("proposalId"));
    if (!botId || !proposalId) throw new HttpError(400, "ID_INVALID", "Bot or proposal id is invalid.");
    const body = await jsonBody(context.req.raw);
    if ((body.decision !== "apply" && body.decision !== "reject")
      || typeof body.expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedHash)) {
      throw new HttpError(400, "BODY_INVALID", "decision and expectedHash are invalid.");
    }
    const decision: BotSettingProposalDecisionInput = {
      decision: body.decision,
      expectedHash: body.expectedHash,
    };
    const proposal = await withTenant(db, auth.organizationId, (tx) => decideBotSettingProposal(tx, {
      organizationId: auth.organizationId,
      proposalId,
      botId,
      userId: auth.userId,
      ...decision,
    }));
    if (proposal.status === "stale") {
      throw new HttpError(409, "BOT_SETTING_PROPOSAL_STALE", "The bot changed after this proposal was created.");
    }
    return context.json(proposal);
  });
  return routes;
}

function readUuid(value: string | undefined): string | null {
  return value && isUuid(value) ? value.toLowerCase() : null;
}
