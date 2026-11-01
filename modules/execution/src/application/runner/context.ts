import type { SQL } from "bun";
import type { ModelAssignmentMode } from "@openedbot/contracts-api";
import { withBotModeInstructions } from "@openedbot/roster/domain/bot-mode";
import { buildRuntimeMemoryBlock } from "@openedbot/roster/domain/bot-memory";
import { buildSectionContextBlock } from "@openedbot/roster/domain/playbooks";
import {
  buildEditorDirectivesBlock,
  buildPlanTurnBlock,
  hostApprovalPolicyProven,
} from "@openedbot/roster/domain/editor-directives";
import { greetingRunsOnDefaultProfile, greetingSessionKey } from "../../domain/bot-greeting";
import { promptCacheTierForRun } from "../../domain/prompt-cache-tier";
import type { WorkerConfig } from "../worker-config";
import type { ClaimedRun } from "../queue";
import { applyRuntimeModelSelection } from "./provider-recovery";
import type { RunContext } from "./types";

export async function readContext(db: SQL, config: WorkerConfig, claimed: ClaimedRun): Promise<RunContext | null> {
  type StoredRunContext = Omit<RunContext, "provider" | "operator" | "personaInstructions" | "hermesProfileManaged"> & {
    hermesProfileManaged?: boolean | null;
    assignmentMode: string | null;
    selectedProvider: string | null;
    selectedModel: string | null;
    selectedReasoningEffort: string | null;
    operatorUsername: string | null;
    sectionContext: string | null;
    label: string | null;
    replyLanguage: string | null;
    permissionMode: string | null;
    planOnly: boolean;
    approvalPolicyMode: string | null;
    permissionPipeline: string;
    approvalPolicyEffectiveAt: Date | string | null;
    origin: string | null;
    executionSessionKey: string | null;
    threadSessionId: string;
    profileProvisionStatus: string | null;
    workflowKind: string | null;
    capabilityBaselineVersion: number | null;
  };
  const rows = await db<StoredRunContext[]>`
    select r.id, r.organization_id as "organizationId", r.thread_id as "threadId", r.input, r.attempts,
           r.hermes_run_id as "hermesRunId", r.last_hermes_sequence as "lastHermesSequence",
           r.lease_generation as "leaseGeneration", r.external_state as "externalState",
           r.remote_stop_state as "remoteStopState", r.error_code as "errorCode", r.error_message as "errorMessage",
           r.workflow_id as "workflowId", r.step_index as "stepIndex", r.step_kind as "stepKind",
           r.stack_depth as "stackDepth", r.caller_bot_id as "callerBotId",
           r.caller_run_id as "callerRunId", r.resumes_run_id as "resumesRunId",
           r.bot_id as "botId", r.group_turn_position as "groupTurnPosition", r.group_state as "groupState",
           r.origin_run_id as "originRunId",
           coalesce(org.model_assignment_mode, 'per_bot') as "assignmentMode",
           org.permission_pipeline as "permissionPipeline",
           coalesce(b.name, '') as "botName", coalesce(b.slug, '') as "botSlug", b.description as "botDescription",
           coalesce(b.instructions, '') as instructions, coalesce(r.model, b.model) as model,
           b.reasoning_effort as "reasoningEffort", b.hermes_profile as "hermesProfile",
           b.hermes_profile_managed as "hermesProfileManaged",
           b.label, b.reply_language as "replyLanguage", b.permission_mode as "permissionMode",
           (r.plan_only or coalesce(w.plan_only, false)) as "planOnly",
           b.approval_policy_mode as "approvalPolicyMode", b.approval_policy_effective_at as "approvalPolicyEffectiveAt",
           coalesce(b.autonomy_enabled, false) as "autonomyEnabled", w.autonomy_enabled as "workflowAutonomyEnabled",
           w.status as "workflowStatus", w.root_run_id as "workflowRootRunId", w.kind as "workflowKind",
           b.capability_baseline_version as "capabilityBaselineVersion",
           -- Un DM simple n'a pas de workflow : son run porte le plafond figé à l'envoi.
           coalesce(w.deadline_at, r.deadline_at) as "workflowDeadlineAt",
           coalesce(r.execution_session_key, t.hermes_session_id) as "sessionId",
           r.origin, r.execution_session_key as "executionSessionKey", t.hermes_session_id as "threadSessionId",
           pp.status as "profileProvisionStatus",
           t.group_id as "groupId", t.title as "threadTitle",
           s.context as "sectionContext",
           rt.id as "runtimeId", rt.reachability, rt.link_last_seen_at as "linkLastSeenAt",
           rt.link_connected_at as "linkConnectedAt", rt.toolset_epoch::text as "toolsetEpoch",
           coalesce(rt.link_features, '{}'::text[]) as "linkFeatures",
           rt.endpoint as "runtimeEndpoint",
           rt.token_ciphertext as "tokenCiphertext", rt.token_nonce as "tokenNonce", rt.token_tag as "tokenTag",
           rt.token_key_id as "tokenKeyId",
           rt.edge_auth_ciphertext as "edgeAuthCiphertext", rt.edge_auth_nonce as "edgeAuthNonce",
           rt.edge_auth_tag as "edgeAuthTag", rt.edge_auth_key_id as "edgeAuthKeyId",
           rt.selected_provider as "selectedProvider", rt.selected_model as "selectedModel",
           rt.reasoning_effort as "selectedReasoningEffort",
           op.username as "operatorUsername",
           coalesce(rrt.installed_at is not null and r.bot_id = any(rrt.enabled_bot_ids), false) as "routineToolEnabled",
           coalesce(rbts.installed_at is not null and r.bot_id = any(rbts.enabled_bot_ids), false) as "botSettingsToolEnabled"
      from runs r
      join organizations org on org.id = r.organization_id
      join threads t on t.organization_id = r.organization_id and t.id = r.thread_id
      left join bots b on b.organization_id = r.organization_id and b.id = r.bot_id
      join runtimes rt on rt.organization_id = r.organization_id and rt.revoked_at is null and rt.is_active
        -- Même prédicat de vitalité que la réclamation (queue.ts) : un lien
        -- connecteur muet depuis 45 s ne sert aucun run.
        and ((rt.reachability = 'connector' and rt.link_last_seen_at > now() - interval '45 seconds')
          or (rt.reachability = 'direct' and rt.last_health_status = 'healthy'
            and rt.last_probed_at > now() - interval '90 seconds'))
      left join sections s on s.organization_id = r.organization_id and s.id = b.section_id
      left join operator_profiles op on op.organization_id = r.organization_id
      left join workflows w on w.organization_id = r.organization_id and w.id = r.workflow_id
      left join runtime_routine_tools rrt on rrt.organization_id = r.organization_id and rrt.runtime_id = rt.id
      left join runtime_bot_settings_tools rbts on rbts.organization_id = r.organization_id and rbts.runtime_id = rt.id
      left join bot_profile_provisions pp on pp.organization_id = r.organization_id and pp.bot_id = r.bot_id
     where r.id = ${claimed.id} and r.organization_id = ${claimed.organizationId}
       and r.lease_owner = ${config.workerId} and r.lease_generation = ${claimed.leaseGeneration}
       and r.status = 'starting'
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const greetingOnDefaultProfile = greetingRunsOnDefaultProfile(row);
  if (greetingOnDefaultProfile && row.executionSessionKey === null) {
    const pinned = await db<{ id: string }[]>`
      update runs set execution_session_key = ${greetingSessionKey(row.threadSessionId)}, updated_at = now()
       where id = ${claimed.id} and organization_id = ${claimed.organizationId}
         and lease_owner = ${config.workerId} and lease_generation = ${claimed.leaseGeneration}
         and execution_session_key is null and hermes_run_id is null
      returning id
    `;
    if (!pinned[0]) return null;
    row.sessionId = greetingSessionKey(row.threadSessionId);
  }
  // La mémoire s'attache à la PERSONA et non au bloc bot-mode : elle rejoint
  // ainsi le préfixe stable du prompt, mis en cache par le fournisseur, et
  // tous les chemins (DM, salon, étape de workflow) la reçoivent sans que
  // chacun ait à s'en souvenir.
  const hermesProfileManaged = !greetingOnDefaultProfile && row.reachability === "connector" && row.hermesProfileManaged === true;
  const assignmentMode: ModelAssignmentMode = row.assignmentMode === "global" ? "global" : "per_bot";
  // La mémoire vit dans le runtime (MEMORY.md / USER.md du profil) : rien à
  // lire en base. Le bloc définitif est posé au démarrage du run, quand
  // l'inventaire dit si l'outil `memory` existe ; d'ici là, coupée.
  const sectionBrief = buildSectionContextBlock(row.sectionContext ?? "");
  const briefed = sectionBrief ? withBotModeInstructions(row.instructions, sectionBrief) : row.instructions;
  // Langue de réponse et mode plan choisis dans l'éditeur d'agent (0099).
  // `approval_policy` : l'hôte soumet les écritures à l'accord de l'opérateur
  // (plugin edge-setup) ; la consigne du mode manuel n'est alors plus utile.
  const hostPolicyProven = hostApprovalPolicyProven({
    linkFeatures: Array.isArray(row.linkFeatures) ? row.linkFeatures : [],
    managedProfile: hermesProfileManaged,
    permissionMode: row.permissionMode,
    permissionPipeline: row.permissionPipeline,
    policyMode: row.approvalPolicyMode,
    effectiveAt: row.approvalPolicyEffectiveAt,
  });
  // A plan-only turn (0155) is decided as `plan` whatever the bot's mode. The
  // host keeps the bot's own policy: the proof above is about the bot.
  const permissionMode = row.planOnly ? "plan" : row.permissionMode;
  // The instructions keep the BOT's mode: they are the cached prefix, and a
  // one-message plan intent travels with the input (`planTurnBlock`).
  const directives = buildEditorDirectivesBlock({ ...row, hostEnforcesApprovals: hostPolicyProven });
  const persona = directives ? withBotModeInstructions(briefed, directives) : briefed;
  const withMemory = withBotModeInstructions(persona, buildRuntimeMemoryBlock({ toolEnabled: false }));
  return {
    ...row,
    leaseGeneration: Number(row.leaseGeneration),
    linkFeatures: Array.isArray(row.linkFeatures) ? row.linkFeatures : [],
    hermesProfile: row.reachability === "direct" || greetingOnDefaultProfile ? null : row.hermesProfile,
    hermesProfileManaged,
    permissionMode,
    planOnly: row.planOnly === true,
    planTurnBlock: row.planOnly && row.permissionMode !== "plan" ? buildPlanTurnBlock() : null,
    hostPolicyProven,
    promptCacheTtl: promptCacheTierForRun({
      origin: row.origin,
      originRunId: row.originRunId,
      stepKind: row.stepKind,
      workflowKind: row.workflowKind,
      hermesProfileManaged,
      linkFeatures: Array.isArray(row.linkFeatures) ? row.linkFeatures : [],
      capabilityBaselineVersion: row.capabilityBaselineVersion,
    }),
    // A greeting on the default profile runs before the bot's own profile
    // exists, on input openedbot composes: no bot policy can be proven for it yet.
    hostPolicyRequired: row.permissionPipeline === "v2" && !greetingOnDefaultProfile,
    personaInstructions: persona,
    instructions: withMemory,
    operator: row.operatorUsername ? { username: row.operatorUsername } : null,
    runtimeSelectedProvider: row.selectedProvider,
    runtimeSelectedModel: row.selectedModel,
    assignmentMode,
    ...applyRuntimeModelSelection(
      { model: row.model, reasoningEffort: row.reasoningEffort },
      {
        provider: row.selectedProvider,
        model: row.selectedModel,
        reasoningEffort: row.selectedReasoningEffort,
      },
      assignmentMode,
    ),
  };
}
