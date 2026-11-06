/**
 * PERM2-5: read and write a bot's per-tool policies.
 *
 * The database is the source of truth the pipeline decides from
 * (`permission-gate.ts`); the host plugin's `blocked_tools` is the second
 * lock of `block`. A write commits first, then writes the host: adding a
 * block is enforced at once by the pipeline, removing one is still refused
 * by the host until it is rewritten, so neither order opens a gap. A host
 * write that fails or is not proven by re-read leaves the host policy
 * unproven (`approval_policy_effective_at` null) and the worker's
 * reconciliation rewrites it; until then a `v2` run of the bot is refused
 * (PERM2-2), never run with a stale list.
 */

import {
  BOT_TOOL_POLICY_MAX_BLOCKED,
  BOT_TOOL_POLICY_MAX_STORED,
  type BotPermissionMode,
  type BotToolPoliciesDto,
  type BotToolPolicyWrite,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { HermesClientError } from "@openedbot/hermes";
import { withBotProfileLock } from "./profile-import-guard";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { permissionPipelineOf } from "@openedbot/runtimes/domain/runtime-contract";
import { writeBotApprovalPolicyProof } from "../sql/bots";
import {
  countBotToolPolicies,
  readBlockedToolsTx,
  readBotToolPolicies,
  writeBotToolPolicies,
  type ToolPolicyActor,
} from "../sql/tool-policies";
import { applyHostApprovalPolicy } from "./approval-policy";
import type { BotDeps } from "./bot-host";
import { RELAY_FEATURE_APPROVAL_POLICY } from "@openedbot/contracts-connector/features";

/** What other packages call here (ADR 0001 S4); the SQL file stays private to the module. */
export { readBlockedTools, readToolPolicyTx } from "../sql/tool-policies";

type ToolPolicyTarget = {
  profile: string | null;
  profileManaged: boolean;
  permissionMode: BotPermissionMode;
  pipeline: string;
  policyEffectiveAt: Date | string | null;
};

async function readTarget(tx: TransactionDb, organizationId: string, botId: string, lock: boolean): Promise<ToolPolicyTarget> {
  const rows = lock
    ? await tx<ToolPolicyTarget[]>`
      select b.hermes_profile as profile, b.hermes_profile_managed as "profileManaged", b.permission_mode as "permissionMode",
             o.permission_pipeline as pipeline, b.approval_policy_effective_at as "policyEffectiveAt"
        from bots b join organizations o on o.id = b.organization_id
       where b.organization_id = ${organizationId} and b.id = ${botId} and b.deleted_at is null
       for update of b
    `
    : await tx<ToolPolicyTarget[]>`
      select b.hermes_profile as profile, b.hermes_profile_managed as "profileManaged", b.permission_mode as "permissionMode",
             o.permission_pipeline as pipeline, b.approval_policy_effective_at as "policyEffectiveAt"
        from bots b join organizations o on o.id = b.organization_id
       where b.organization_id = ${organizationId} and b.id = ${botId} and b.deleted_at is null
    `;
  if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  return rows[0];
}

function hostManaged(target: ToolPolicyTarget): target is ToolPolicyTarget & { profile: string } {
  return target.profileManaged === true && Boolean(target.profile);
}

async function view(tx: TransactionDb, organizationId: string, botId: string, canWrite: boolean): Promise<BotToolPoliciesDto> {
  const target = await readTarget(tx, organizationId, botId, false);
  return {
    botId,
    policies: await readBotToolPolicies(tx, organizationId, botId),
    writable: canWrite,
    enforced: permissionPipelineOf(target.pipeline) === "v2",
    hostBlocked: !hostManaged(target) ? "none" : target.policyEffectiveAt ? "proven" : "pending",
  };
}

export async function readBotToolPoliciesView(db: Db, organizationId: string, botId: string, canWrite: boolean): Promise<BotToolPoliciesDto> {
  return withTenant(db, organizationId, (tx) => view(tx, organizationId, botId, canWrite));
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index]);

export async function setBotToolPolicies(
  db: Db,
  deps: Pick<BotDeps, "readRuntime" | "clientFactory">,
  input: { organizationId: string; botId: string; actor: ToolPolicyActor; entries: readonly BotToolPolicyWrite[] },
): Promise<BotToolPoliciesDto> {
  const { organizationId, botId } = input;
  // The same lock as `updateBot` and the reconciliation: a host policy write
  // never interleaves with another one carrying an older list.
  return withBotProfileLock(db, organizationId, botId, async (db) => {
    const outcome = await withTenant(db, organizationId, async (tx) => {
      const target = await readTarget(tx, organizationId, botId, true);
      if (permissionPipelineOf(target.pipeline) !== "v2") {
        throw new HttpError(409, "TOOL_POLICIES_REQUIRE_V2", "Les politiques par outil s’appliquent avec le nouveau moteur de permissions, pas encore actif pour cette organisation.");
      }
      const before = await readBlockedToolsTx(tx, organizationId, botId);
      await writeBotToolPolicies(tx, organizationId, botId, input.entries, input.actor);
      const counts = await countBotToolPolicies(tx, organizationId, botId);
      if (counts.blocked > BOT_TOOL_POLICY_MAX_BLOCKED || counts.stored > BOT_TOOL_POLICY_MAX_STORED) {
        // Thrown inside the transaction: nothing of this write is kept.
        throw new HttpError(409, "TOOL_POLICIES_LIMIT", `Un bot garde au plus ${BOT_TOOL_POLICY_MAX_BLOCKED} outils bloqués et ${BOT_TOOL_POLICY_MAX_STORED} politiques : retirez-en avant d’en ajouter.`);
      }
      const blocked = await readBlockedToolsTx(tx, organizationId, botId);
      const hostWrite = hostManaged(target) && !sameList(before, blocked);
      // The proof no longer holds for the new list: unproven until re-read.
      if (hostWrite) await writeBotApprovalPolicyProof(tx, organizationId, botId, null, false);
      return { target, blocked, hostWrite };
    });

    if (outcome.hostWrite && outcome.target.profile) {
      const runtime = await deps.readRuntime(db, organizationId);
      if (runtime?.linkFeatures?.includes(RELAY_FEATURE_APPROVAL_POLICY)) {
        try {
          const state = await applyHostApprovalPolicy(
            runtime,
            outcome.target.profile,
            outcome.target.permissionMode,
            permissionPipelineOf(outcome.target.pipeline),
            deps.clientFactory,
            outcome.blocked,
          );
          if (state) await withTenant(db, organizationId, (tx) => writeBotApprovalPolicyProof(tx, organizationId, botId, state.mode, state.effective));
        } catch (error) {
          // Committed and enforced by the pipeline; the worker proves the host later.
          console.error(JSON.stringify({
            event: "bot.tool_policies_host_unproven",
            botId,
            organizationId,
            code: error instanceof HermesClientError ? error.code : "UNEXPECTED",
          }));
        }
      }
    }
    return withTenant(db, organizationId, (tx) => view(tx, organizationId, botId, true));
  });
}
