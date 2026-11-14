import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import { effectivePermissionModeFor } from "@openedbot/runtimes/application/approval-reviewer";
import type { ModelAssignmentMode } from "@openedbot/contracts-api";
import { withBotModeInstructions } from "@openedbot/roster/domain/bot-mode";
import { buildRuntimeMemoryBlock } from "@openedbot/roster/domain/bot-memory";
import { buildSectionContextBlock } from "@openedbot/roster/domain/playbooks";
import {
  buildEditorDirectivesBlock,
  buildPlanTurnBlock,
  hostApprovalPolicyProven,
  hostApprovalPolicyRequired,
} from "@openedbot/roster/domain/editor-directives";
import { greetingRunsOnDefaultProfile } from "../../domain/bot-greeting";
import { routineToolAvailability } from "../../domain/routine-tool";
import { promptCacheTierForRun } from "../../domain/prompt-cache-tier";
import type { WorkerConfig } from "../worker-config";
import type { ClaimedRun } from "../queue";
import { applyRuntimeModelSelection } from "./provider-recovery";
import { pinThreadSession, type ThreadSessionRow } from "./thread-session";
import type { RunContext } from "./types";

export async function readContext(db: SQL, config: WorkerConfig, claimed: ClaimedRun): Promise<RunContext | null> {
  type StoredRunContext = Omit<RunContext, "provider" | "operator" | "personaInstructions" | "hermesProfileManaged" | "routineToolEnabled" | "routineTool"> & {
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
    workflowKind: string | null;
    capabilityBaselineVersion: number | null;
    routineToolSwitchedOff: boolean;
    routineToolReady: boolean;
    routineToolBlockedReason: string | null;
  } & Omit<ThreadSessionRow, "organizationId" | "threadId" | "threadSessionId">;
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
           b.reasoning_effort as "reasoningEffort", coalesce(b.fast_mode, false) as "fastMode",
           b.hermes_profile as "hermesProfile",
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
           t.hermes_session_generation as "threadSessionGeneration", t.hermes_session_opened_at as "threadSessionOpenedAt",
           t.created_at as "threadCreatedAt", rt.capabilities_changed_at as "rootCapabilitiesChangedAt",
           rt.profile_capabilities_changed_at ->> b.hermes_profile as "profileCapabilitiesChangedAt",
           t.group_id as "groupId", t.title as "threadTitle",
           s.context as "sectionContext",
           rt.id as "runtimeId", rt.reachability, rt.link_last_seen_at as "linkLastSeenAt",
           rt.link_connected_at as "linkConnectedAt", rt.inventory_changed_at as "inventoryChangedAt",
           rt.toolset_epoch::text as "toolsetEpoch",
           coalesce(rt.link_features, '{}'::text[]) as "linkFeatures",
           rt.endpoint as "runtimeEndpoint",
           rt.token_ciphertext as "tokenCiphertext", rt.token_nonce as "tokenNonce", rt.token_tag as "tokenTag",
           rt.token_key_id as "tokenKeyId",
           rt.edge_auth_ciphertext as "edgeAuthCiphertext", rt.edge_auth_nonce as "edgeAuthNonce",
           rt.edge_auth_tag as "edgeAuthTag", rt.edge_auth_key_id as "edgeAuthKeyId",
           rt.selected_provider as "selectedProvider", rt.selected_model as "selectedModel",
           rt.reasoning_effort as "selectedReasoningEffort",
           op.username as "operatorUsername",
           coalesce(brt.switched_off, false) as "routineToolSwitchedOff",
           -- Proven on this runtime and past the gateway's reload window (0187).
           coalesce(rrt.installed_at is not null and brt.enabled_at is not null and brt.runtime_id = rt.id
             and brt.restart_pending_since is null and brt.ready_at <= now(), false) as "routineToolReady",
           brt.blocked_reason as "routineToolBlockedReason",
           -- The zone the person's client sent with the message this run answers (0187).
           r.user_time_zone as "routineUserTimezone",
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
      left join bot_routine_tools brt on brt.organization_id = r.organization_id and brt.bot_id = r.bot_id
      left join runtime_bot_settings_tools rbts on rbts.organization_id = r.organization_id and rbts.runtime_id = rt.id
     where r.id = ${claimed.id} and r.organization_id = ${claimed.organizationId}
       and r.lease_owner = ${config.workerId} and r.lease_generation = ${claimed.leaseGeneration}
       and r.status = 'starting'
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  // PERM2-7: `auto` needs the reviewer of the plug-in `permissions`, ready for
  // this organization; otherwise it IS `manual`. Resolved once here, so the
  // legacy auto-approval (`persist.ts`), the operator settings of the prompt,
  // the host-policy proof and the routine tool all decide on what the console shows.
  const storedPermissionMode = row.permissionMode;
  // `db` is the pool: the readiness is read in a transaction bound to the run's organization.
  row.permissionMode = await effectivePermissionModeFor(db as unknown as Db, row.organizationId, row.permissionMode);
  // Un accueil collé au profil par défaut par une version précédente y reste.
  const greetingOnDefaultProfile = greetingRunsOnDefaultProfile(row);
  // Une capacité changée depuis l'ouverture de la session du fil : le fil
  // passe à une session neuve (0163). Un run déjà créé chez Hermes, ou qui
  // porte déjà sa propre clé (ancien accueil, workflow), garde la sienne.
  if (row.executionSessionKey === null && row.hermesRunId == null) {
    const sessionId = await pinThreadSession(db, claimed, config.workerId, row);
    if (sessionId === null) return null;
    row.sessionId = sessionId;
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
  // Decided on the BOT's mode, like the instructions it lands in.
  const routineTool = routineToolAvailability({
    switchedOff: row.routineToolSwitchedOff === true,
    ready: row.routineToolReady === true,
    blockedReason: row.routineToolBlockedReason,
    linkFeatures: row.reachability === "connector" && Array.isArray(row.linkFeatures) ? row.linkFeatures : null,
    hasProfile: row.hermesProfile !== null,
    botPermissionMode: row.permissionMode,
  });
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
    routineTool,
    routineToolEnabled: routineTool === "enabled",
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
    // Legacy too for a stored `auto` decided as `manual` (no ready reviewer).
    hostPolicyRequired: !greetingOnDefaultProfile && hostApprovalPolicyRequired({
      permissionPipeline: row.permissionPipeline,
      storedPermissionMode,
      effectivePermissionMode: row.permissionMode,
      managedProfile: hermesProfileManaged,
      linkFeatures: Array.isArray(row.linkFeatures) ? row.linkFeatures : [],
    }),
    personaInstructions: persona,
    instructions: withMemory,
    operator: row.operatorUsername ? { username: row.operatorUsername } : null,
    runtimeSelectedProvider: row.selectedProvider,
    runtimeSelectedModel: row.selectedModel,
    assignmentMode,
    ...applyRuntimeModelSelection(
      { model: row.model, reasoningEffort: row.reasoningEffort, fastMode: row.fastMode === true },
      {
        provider: row.selectedProvider,
        model: row.selectedModel,
        reasoningEffort: row.selectedReasoningEffort,
      },
      assignmentMode,
    ),
  };
}
