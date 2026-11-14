import { isUuid } from "@openedbot/contracts-primitives";
import { insertMessageAttachment } from "@openedbot/conversation/application/attachments";
import { insertAssistantMessage } from "@openedbot/conversation/application/messages";
import { raiseGroupNeedsYou } from "@openedbot/roster/application/groups";
import type { SQL } from "bun";
import type { HermesClient } from "@openedbot/hermes";
import type { RunEvent } from "../../domain/hermes-events";
import { approvalGateIdentity, legacyPolicyOf, type GateIdentity } from "../../domain/gate-identity";
import { resolveGateTx } from "./permission-gate";
import { lockWorkflowTx, permissionRuleSourceFor } from "./permission-rule-sources";
import { clearProviderIncident } from "../provider-fallback";
import {
  HANDOFF_NOTICE_KIND,
  ROOM_NOTICE_KIND,
  isPass,
  mentionsUser,
  mentionedMembers,
  parseMentions,
} from "@openedbot/roster/domain/bot-mode";
import { isServiceStepKind } from "../../domain/run-step";
import { backfillToolErrorMessageTx, insertToolErrorTx, toolErrorRow } from "../tool-errors";
import { workerMayApproveGate } from "@openedbot/roster/domain/editor-directives";
import { effectivePermissionModeTx } from "@openedbot/runtimes/application/approval-reviewer";
import { shouldNudgeGroupPass, type GroupSendState } from "../../domain/group-send";
import { organizationEventEnvelope, runTurnId, type OrganizationEvent } from "@openedbot/contracts-events";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import type { WorkerConfig } from "../worker-config";
import { expireUnacknowledgedRunSteers } from "../run-steering";
import { appendNumberedRunEventsTx, appendRunEventsTx, lockRunEventsTx } from "../../sql/run-events";
import { appendNoticeTx, deferWake, publishBatch, takeDeferredWake } from "./events";
import {
  createHandoffTx,
  delegatedHandoffNotice,
  deliverHandoffReplyTx,
  detectFireAndForget,
  handoffEligible,
  handoffRoster,
  simpleDmStep,
  untrackedToolNoticeBelongsHere,
} from "./handoff";
import { advanceGroupTx, assistantMessageForCompletion, groupSendState } from "./rooms";
import { assistantContent, storeRuntimeArtifacts } from "./transcript";
import { extractOutputMedia, workspaceMediaNames } from "../../domain/output-media";
import { fetchWorkspaceMedia } from "./output-media-fetch";
import type { GroupRunContext, RunContext } from "./types";
import { log } from "./util";
import { ACTIVE_RUN_STATUSES } from "../../domain/run-transitions";
import { advanceHermesWatermark } from "../../sql/run-columns";
import { lockLeasedRunTx, NOW, RELEASE_LEASE, transitionRuns } from "../../sql/run-transitions";
import { heldLease, runKey } from "./lease-transitions";
import { chainLegacyRoomTurnTx } from "./workflow-steps";
import {
  advanceWorkflowCompletionTx,
  advanceWorkflowFailureTx,
  measureWorkflowTokens,
  settleReviewWorkflowTx,
  settleSimpleDmCompletionTx,
  usageTotal,
} from "./workflows";

const EARLY_EVENT_TYPES = new Set<RunEvent["type"]>(["agent.message", "agent.reasoning", "tool.call", "tool.result", "raw"]);

function validApprovalRequestId(value: unknown): string {
  return typeof value === "string" && isUuid(value)
    ? value.toLowerCase()
    : crypto.randomUUID();
}

function stampApprovalRequestIds(events: readonly BatchEvent[]): void {
  for (const event of events) {
    if (event.type === "approval.requested") {
      event.payload.approvalRequestId = validApprovalRequestId(event.payload.approvalRequestId);
    }
  }
}

/** Même enveloppe que le rejeu, sans curseur : l'INSERT ne l'a pas encore alloué. */
function uncommittedEnvelope(context: RunContext, event: RunEvent): OrganizationEvent {
  return organizationEventEnvelope({
    organizationId: context.organizationId,
    threadId: context.threadId,
    runId: context.id,
    botId: context.botId,
    turnId: runTurnId({ runId: context.id, workflowRootRunId: context.workflowRootRunId }),
    sessionKey: context.sessionId,
    leaseGeneration: context.leaseGeneration,
    sequence: event.sequence,
    type: event.type,
    payload: event.payload,
    occurredAt: event.occurredAt,
  });
}

async function publishUncommittedEvents(
  config: Pick<WorkerConfig, "apiInternalUrl" | "internalSecrets">,
  context: RunContext,
  events: RunEvent[],
): Promise<void> {
  // Le réveil post-commit du flush précédent (commité, donc avec curseur)
  // voyage dans ce même POST : un seul appel par flush.
  const carried = takeDeferredWake(context.id);
  await publishBatch(config, [
    ...(carried ? [carried] : []),
    ...events.map((event) => uncommittedEnvelope(context, event)),
  ]);
}

/** 23514 `run_events_lease_fence` : le lot est périmé, on ne le réécrit pas. */
export function isRunEventsLeaseFence(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const pg = error as { code?: unknown; errno?: unknown; constraint?: unknown; message?: unknown };
  if (![pg.code, pg.errno].some((code) => String(code ?? "") === "23514")) return false;
  return pg.constraint === "run_events_lease_fence"
    || (typeof pg.message === "string" && pg.message.includes("run_events_lease_fence"));
}

/** Routeur et contributions d'équipe : pas de bulle. Une délégation d'équipe non plus. */
async function hiddenGroupOutput(
  tx: SQL,
  context: GroupRunContext,
  state: GroupSendState | null,
  output: string,
): Promise<boolean> {
  if (!state || !context.groupId) return false;
  if (state.phase === "route" || state.phase === "contribution") return true;
  if (state.phase === "synthesis" || !output.includes("@")) return false;
  const groups = await tx<Array<{ answerMode: string }>>`
    select answer_mode as "answerMode" from bot_groups
     where organization_id = ${context.organizationId} and id = ${context.groupId}
  `;
  if (groups[0]?.answerMode !== "team") return false;
  const members = await tx<Array<{ id: string; slug: string }>>`
    select b.id, b.slug
      from group_members gm
      join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
     where gm.organization_id = ${context.organizationId} and gm.group_id = ${context.groupId}
       and b.archived_at is null
  `;
  return mentionedMembers(output, members, { excludeBotId: context.botId ?? undefined }).length > 0;
}

/** An event the worker writes outside its stream (failure, fallback, reconciled failure): numbered under the run's locks. */
export type UnnumberedRunEvent = Omit<RunEvent, "sequence">;
type BatchEvent = UnnumberedRunEvent & { sequence?: number };
type PreparedEvent = {
  event: BatchEvent;
  payload: Record<string, unknown>;
  gate: GateIdentity | null;
  resolution: Awaited<ReturnType<typeof resolveGateTx>> | null;
};

/** A batch the stream's normalizer numbered (its deltas left before the commit, under these numbers). */
export async function persistEvents(
  db: SQL, config: WorkerConfig, context: RunContext, rawSequence: number, events: RunEvent[], client?: HermesClient, trace?: RunTrace,
): Promise<void> {
  await persistBatch(db, config, context, rawSequence, events, true, client, trace);
}

/** Events nobody numbered yet: numbered under the run's locks, published after the commit only. Returns the committed envelopes. */
export async function persistUnnumberedEvents(
  db: SQL, config: WorkerConfig, context: RunContext, rawSequence: number, events: UnnumberedRunEvent[], client?: HermesClient, trace?: RunTrace,
): Promise<OrganizationEvent[]> {
  return persistBatch(db, config, context, rawSequence, events, false, client, trace);
}

/** Returns the committed envelopes (none when the lease was lost). */
async function persistBatch(
  db: SQL, config: WorkerConfig, context: RunContext, rawSequence: number, events: BatchEvent[], numbered: boolean,
  client?: HermesClient, trace?: RunTrace,
): Promise<OrganizationEvent[]> {
  // Deltas leave before accounting and commit. Receipts and terminal events
  // wait for their durable, canonically enriched API representation.
  stampApprovalRequestIds(events);
  const quietGroupPhase = groupSendState(context)?.phase;
  const quietTurn = quietGroupPhase === "route" || quietGroupPhase === "contribution";
  const earlyEvents = !numbered ? [] : (events as RunEvent[]).filter((event) => EARLY_EVENT_TYPES.has(event.type)
    && !(quietTurn && (event.type === "agent.message" || event.type === "agent.reasoning")));
  await publishUncommittedEvents(config, context, earlyEvents);
  if (trace && earlyEvents.length > 0) {
    trace.mark("openedbot.first_event_published");
    if (earlyEvents.some((event) => event.type === "agent.message")) trace.mark("openedbot.first_text_published");
  }
  // Le coût effectif se mesure hors transaction : appel réseau, aucun verrou.
  // Il ne retarde plus le fan-out ci-dessus.
  const completion = context.workflowId
    ? events.find((event) => event.type === "run.completed")
    : undefined;
  const accounting = completion
    ? await measureWorkflowTokens(config, context, completion.payload.usage, client)
    : null;
  // Hors transaction : lecture du transcript + écriture du magasin. Un échec
  // de copie n'empêche pas le tour de se clore : le texte reste, la puce non.
  const completed = events.find((event) => event.type === "run.completed");
  // Les fichiers que la réponse livre (`MEDIA:` intégré par Hermes, ou lu sur
  // l'hôte dans `/workspace`) deviennent des pièces jointes ; le texte
  // enregistré (run, événement, message) n'en garde ni les octets ni le chemin.
  const delivering = completed && !isServiceStepKind(context.stepKind);
  const fetched = delivering ? await fetchWorkspaceMedia(context, client, workspaceMediaNames(completed.payload.output)) : undefined;
  const delivered = delivering ? extractOutputMedia(completed.payload.output, fetched) : null;
  if (completed && delivered && delivered.text !== completed.payload.output) {
    completed.payload.output = delivered.text;
    if (delivered.unresolved.length) log("worker.output_media_unresolved", { runId: context.id, organizationId: context.organizationId, files: delivered.unresolved });
  }
  const runtimeArtifacts = completed && !isServiceStepKind(context.stepKind)
    ? await storeRuntimeArtifacts(config, context, completed, client, delivered?.images ?? [])
    : [];
  // PERM2-9: "Never wait" is read through the port, resolved before the
  // transaction, and only when a gate needs it.
  const unattendedFrom = context.workflowId && events.some((event) => event.type === "approval.requested")
    ? await permissionRuleSourceFor(context.organizationId)
    : null;
  let envelopes: OrganizationEvent[];
  try {
  envelopes = await db.begin(async (tx) => {
    const lease = heldLease(config, context);
    if (!await lockLeasedRunTx(tx as unknown as SQL, runKey(context), lease)) return [] as OrganizationEvent[];
    // PERM2-9: the workflow's snapshot of "Never wait", read under its lock.
    const neverWait = await lockWorkflowTx(tx as unknown as SQL, context.organizationId, context.workflowId, unattendedFrom);
    // The run is held since the fence: its cursor next, in the order of the
    // allocation primitive, before the gates below take their `for share`.
    await lockRunEventsTx(tx, [{ organizationId: context.organizationId, runId: context.id }]);
    // 1. The whole batch is written first, in order. A notice a completion
    // appends below then comes after it, instead of taking the sequence of an
    // event the normalizer numbered after `run.completed` (D3).
    const prepared: PreparedEvent[] = [];
    for (const event of events) {
      if (quietTurn && (event.type === "agent.message" || event.type === "agent.reasoning" || event.type === "tool.call" || event.type === "tool.result")) {
        continue;
      }
      const payload = { ...event.payload };
      // Le transcript de tour n'est qu'un véhicule vers `storeRuntimeArtifacts`.
      // Il ne doit jamais devenir le corps d'un `run_events`.
      delete payload.turnMessages;
      // Same for the gate identity (PERM2-A): `approval_requests` keeps it.
      delete payload.gate;
      // Le JSON du routeur et le texte d'une contribution ne sont pas des tours du fil.
      if (quietTurn && event.type === "run.completed") payload.output = "";
      // PERM2-1: a `v2` organization answers through the pipeline, at the
      // bot's current revision; `legacy` keeps the US-PERM-1 heuristic. Decided
      // before the event is written: a gate the reviewer takes says so on its
      // event, and no client raises a badge for it (PERM2-7).
      const gate = event.type === "approval.requested" ? approvalGateIdentity(event.payload.gate) : null;
      const resolution = gate
        ? await resolveGateTx(tx as unknown as SQL, { organizationId: context.organizationId, botId: context.botId, neverWait, planOnly: context.planOnly === true }, gate,Array.isArray(payload.choices) ? payload.choices : [])
        : null;
      if (event.type === "approval.requested") {
        payload.approvalRequestId = validApprovalRequestId(payload.approvalRequestId);
        if (resolution?.pipeline === "v2" && resolution.decision.outcome === "review") payload.reviewing = true;
      }
      prepared.push({ event, payload, gate, resolution });
    }
    // `lease_generation` explicite : le trigger 0092 refuse la ligne si le
    // run a été repris entre-temps, même hors de ce verrou `for update`. Un
    // lot numéroté par le flux dont une séquence est déjà prise est refusé
    // (RunEventSequenceConflictError), jamais sauté.
    const target = { organizationId: context.organizationId, threadId: context.threadId, runId: context.id, leaseGeneration: context.leaseGeneration };
    const result: OrganizationEvent[] = numbered
      ? await appendNumberedRunEventsTx(tx, target, prepared.map(({ event, payload }) => ({
          sequence: event.sequence!, type: event.type, payload, occurredAt: event.occurredAt,
        })))
      : await appendRunEventsTx(tx, prepared.map(({ event, payload }) => ({
          ...target, type: event.type, payload, occurredAt: event.occurredAt,
        })));
    // 2. Then what each event does, in the same order.
    for (const { event, payload, gate, resolution } of prepared) {
      if (
        event.type === "tool.result.attached" &&
        typeof event.payload.toolCallId === "string" &&
        typeof event.payload.errorMessage === "string"
      ) {
        await backfillToolErrorMessageTx(tx, context, event.payload.toolCallId, event.payload.errorMessage);
      }
      // Un outil en échec laisse une ligne dans `tool_errors` (0037), dans la
      // transaction de son `tool.result` : le panneau Capacités du bot la lit
      // après la purge des événements, et la purge du bot l'emporte.
      const toolError = toolErrorRow(event);
      if (toolError) await insertToolErrorTx(tx, context, toolError);
      if (event.type === "approval.requested") {
        const approvalId = payload.approvalRequestId as string;
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        // Éditeur d'agent : en `auto` / `bypass`, le worker peut répondre « once »
        // à la place de l'opérateur. US-PERM-1 retient la ligne en `pending`
        // pour une suppression en Auto, et pour un circuit breaker dans tous
        // les modes (y compris Tout autoriser). La ligne retenue attend le
        // dock. Sinon elle naît résolue, le trigger 0007 la passe en `ready`
        // et le relais l'envoie à Hermes. `resolved_by_policy` (0100) dit
        // quelle politique a répondu ; le journal hash-chaîné `decisions` reste
        // fermé au worker (0080).
        const command = typeof payload.command === "string" ? payload.command : null;
        if (!gate || !resolution) throw new Error("approval gate resolved out of order");
        // PERM2-9: in `legacy` too, a gate of a "Never wait" routine run is
        // refused at once instead of waiting ten minutes for nobody.
        // PERM2-7: the legacy auto-approval needs a ready reviewer too (the
        // context resolved it already; re-read here, under this transaction,
        // so no caller can hand the gate a stale `auto`).
        const legacyMode = resolution.pipeline === "v2" ? context.permissionMode
          : await effectivePermissionModeTx(tx, context.organizationId, context.permissionMode);
        const legacyAnswer = workerMayApproveGate(legacyMode, command) && choices.includes("once") ? "once"
          : neverWait ? "deny" : null;
        const answer = resolution.pipeline === "v2" ? resolution.choice : legacyAnswer;
        const answeredBy = resolution.pipeline === "v2"
          ? resolution.decision.effectiveMode
          : legacyAnswer === "deny" ? legacyPolicyOf(legacyMode ?? null)
            : legacyMode === "bypass" ? "bypass" : "auto";
        const reviewing = resolution.pipeline === "v2" && resolution.decision.outcome === "review";
        const trace = resolution.pipeline === "v2"
          ? {
              state: answer ? "decided" : reviewing ? "reviewing" : "awaiting_human",
              stage: resolution.decision.stage,
              kind: answer ? "policy" : null,
              revision: resolution.revision,
              detail: resolution.detail,
            }
          : { state: null, stage: null, kind: null, revision: null, detail: legacyAnswer === "deny" ? { reason: "never_wait" } : null };
        if (resolution.pipeline === "v2") {
          const held = resolution.decision.heldBy;
          log("approval.decision", {
            runId: context.id, stage: resolution.decision.stage, outcome: resolution.decision.outcome,
            reason: resolution.decision.reason, gateKind: gate.gateKind,
            ...(held ? { heldStage: held.stage, heldReason: held.reason } : {}),
          });
        } else if (legacyAnswer === "deny") {
          log("approval.decision", { runId: context.id, stage: "unattended", outcome: "deny", reason: "never_wait", gateKind: gate.gateKind, pipeline: "legacy" });
        }
        // The ordinal is taken by the INSERT itself, under the `for update` of
        // the run held since the fence above: one statement, no read-then-write.
        await tx`
          insert into approval_requests (
            id, organization_id, thread_id, run_id, gate_ordinal, command, description, choices, expires_at,
            forward_state, status, selected_choice, resolved_at, resolved_by_policy,
            hermes_request_id, hermes_execution_generation, gate_kind, tool_key, gate_args, descriptor_version,
            decision_state, decision_stage, decided_by_kind, permission_revision_seen, decision_detail
          )
          select
            ${approvalId}, ${context.organizationId}, ${context.threadId}, ${context.id},
            coalesce(max(gate_ordinal), -1) + 1,
            ${command},
            ${typeof payload.description === "string" ? payload.description : null},
            ${choices}, now() + interval '10 minutes', 'pending',
            ${answer === "once" ? "approved" : answer === "deny" ? "denied" : "pending"}, ${answer},
            ${answer ? new Date() : null},
            ${answer ? answeredBy : null},
            ${gate.hermesRequestId}, ${gate.hermesExecutionGeneration}, ${gate.gateKind}, ${gate.toolKey}, ${gate.gateArgs}, ${gate.descriptorVersion},
            ${trace.state}, ${trace.stage}, ${trace.kind}, ${trace.revision}, ${trace.detail}
          from approval_requests
          where organization_id = ${context.organizationId} and run_id = ${context.id}
        `;

        await transitionRuns(tx as unknown as SQL, {
          target: runKey(context), fence: lease, transition: { from: ACTIVE_RUN_STATUSES, to: { status: "awaiting_approval" } },
        });
        // The workflow status is what notifies (0039 push): only a gate that
        // waits for a person moves it. A policy answer or a gate under review
        // (the reviewer moves it if it escalates) notifies nobody.
        if (context.workflowId && !answer && !reviewing) await tx`
          update workflows set status = 'awaiting_approval', updated_at = now()
           where organization_id = ${context.organizationId} and id = ${context.workflowId}
        `;
      }
      if (event.type === "run.completed") {
        const raw = typeof event.payload.output === "string" ? event.payload.output : "";
        const output = raw;
        const service = isServiceStepKind(context.stepKind);
        const state = service ? null : groupSendState(context);
        const hide = await hiddenGroupOutput(tx, context, state, output);
        const message = service || hide ? null : assistantMessageForCompletion(output, state);
        await transitionRuns(tx as unknown as SQL, {
          target: runKey(context), fence: lease,
          transition: { from: ACTIVE_RUN_STATUSES, to: { status: "completed", externalState: "settled" } },
          set: {
            output: output || null, usage: payload.usage ?? null, eventsComplete: payload.reconciled !== true,
            completionKind: payload.reconciled === true ? "reconciled" : "normal", errorCode: null, errorMessage: null,
            endedAt: NOW, ...RELEASE_LEASE,
          },
        });
        if (context.workflowId) {
          const totalTokens = event === completion && accounting
            ? accounting.effectiveTokens
            : usageTotal(payload.usage);
          await tx`
            update workflows set used_tokens = used_tokens + ${totalTokens},
              status = case when status in ('queued','reconciling','awaiting_approval') then 'running' else status end,
              started_at = coalesce(started_at, now()), updated_at = now()
             where organization_id = ${context.organizationId} and id = ${context.workflowId}
          `;
        }
        const simpleDm = simpleDmStep(context);
        if (message || runtimeArtifacts.length > 0) {
          const messageId = crypto.randomUUID();
          await insertAssistantMessage(tx, {
            messageId,
            organizationId: context.organizationId,
            threadId: context.threadId,
            runId: context.id,
            content: assistantContent(message, runtimeArtifacts),
            authorBotId: context.groupTurnPosition !== null || context.workflowId || simpleDm ? context.botId : null,
          });
          for (const artifact of runtimeArtifacts) {
            await insertMessageAttachment(tx, {
              id: artifact.id,
              organizationId: context.organizationId,
              messageId,
              objectKey: artifact.objectKey,
              driver: artifact.driver,
              name: artifact.name,
              contentType: artifact.contentType,
              kind: artifact.kind,
              bytes: artifact.bytes,
            });
          }
        }
        if (service) {
          // Run de service : pas de bulle, pas d'avance salon, pas de `@slug`.
          // Il n'a de workflow que sa revue (0175), close avec lui.
          if (context.workflowId) await settleReviewWorkflowTx(tx, context, { status: "completed" });
        } else if (state) {
          // Tour de salon : un pass (explicite ou implicite) ne laisse qu'un
          // avis ; une vraie sortie qui mentionne l'opérateur lève « needs you ».
          // Un membre adressé qui passe au premier tour est relancé en silence.
          const explicitPass = !message && runtimeArtifacts.length === 0 && isPass(output);
          const nudged = explicitPass && shouldNudgeGroupPass(state, context.botId ?? "");
          const quietTurn = hide || state.phase === "route" || state.phase === "contribution";
          if (!message && runtimeArtifacts.length === 0 && !nudged && !quietTurn) {
            const notice = await appendNoticeTx(tx, context, {
              message: `🤖 ${context.botName} passe.`, kind: ROOM_NOTICE_KIND.pass, botId: context.botId,
            });
            if (notice) result.push(notice);
          } else if (message && mentionsUser(message, context.operator)) {
            await raiseGroupNeedsYou(tx, context.organizationId, context.groupId);
          }
          const settled = await advanceGroupTx(tx, context, state, hide ? (output || null) : message, explicitPass);
          if (settled) result.push(settled);
        } else if (context.groupTurnPosition !== null) {
          // Ancien enchaînement (runs de salon posés avant `group_state`) :
          // chaque membre parle une fois, dans l'ordre, sur la même entrée.
          // Sa seule revue possible (0175) se clôt avec lui.
          if (context.workflowId) await settleReviewWorkflowTx(tx, context, { status: "completed" });
          const next = await tx<Array<{ botId: string; position: number }>>`
            select gm.bot_id as "botId", gm.position
              from threads t
              join group_members gm on gm.organization_id = t.organization_id and gm.group_id = t.group_id
             where t.organization_id = ${context.organizationId} and t.id = ${context.threadId}
               and gm.position > ${context.groupTurnPosition}
             order by gm.position asc limit 1
          `;
          if (next[0]) {
            await chainLegacyRoomTurnTx(tx, {
              organizationId: context.organizationId,
              threadId: context.threadId,
              botId: next[0].botId,
              groupTurnPosition: next[0].position,
              input: context.input,
              groupState: null,
            });
          }
        } else if (context.workflowId) {
          result.push(...await advanceWorkflowCompletionTx(tx, context, output));
        } else if (simpleDm) {
          result.push(...await settleSimpleDmCompletionTx(tx, context, output));
        } else if (message && handoffEligible(context)) {
          // DM ordinaire : une mention `@slug` en tête de ligne dans la sortie
          // ouvre un hand-off : le run terminé vient de libérer le fil, le
          // courrier le reprend dans la même transaction.
          const roster = await handoffRoster(tx, context.organizationId, context.botId);
          const mention = parseMentions(message, roster, { selfBotId: context.botId, mode: "bot" });
          if (mention) {
            const handoff = await createHandoffTx(tx, context, mention);
            if (!handoff.created) {
              const notice = await appendNoticeTx(tx, context, {
                message: `🤖 ${mention.name} est occupé : message non transmis.`,
                kind: HANDOFF_NOTICE_KIND.busy,
                botId: mention.botId,
              });
              if (notice) result.push(notice);
            } else if (handoff.notice) {
              result.push(handoff.notice);
            }
          }
        }
        // Puits silencieux (QA A1) : un run qui appelle un outil fire-and-forget
        // promet un retour que personne ne livrera : le filet ne peut pas vivre
        // que dans deliverHandoffReplyTx (runs entrants). Même avertissement,
        // dans le propre fil du bot, jamais un blocage.
        //
        // Le garde était `handoffEligible(context)`, qui répond à une AUTRE
        // question : « ce run peut-il ouvrir un hand-off ? » : et exclut donc
        // les tours de salon et les étapes de workflow. Un bot qui déléguait
        // hors plateforme depuis un salon ne laissait aucune trace. Seul un run
        // ENTRANT est écarté ici : son avertissement appartient au fil
        // d'origine, où `deliverHandoffReplyTx` le dépose déjà.
        if (!service && untrackedToolNoticeBelongsHere(context)) {
          const toolRows = await tx<Array<{ tool: string | null }>>`
            select distinct payload->>'tool' as tool from run_events
             where organization_id = ${context.organizationId} and run_id = ${context.id} and type = 'tool.call'
          `;
          if (detectFireAndForget(toolRows.map((row) => row.tool))) {
            const notice = await appendNoticeTx(tx, context, {
              message: delegatedHandoffNotice({ name: context.botName, slug: context.botSlug }),
              kind: HANDOFF_NOTICE_KIND.delegated,
              botId: context.botId,
            });
            if (notice) result.push(notice);
          }
        }
        if (!service && context.originRunId) {
          result.push(...await deliverHandoffReplyTx(tx, context, { status: "completed", output, error: null }));
        }
      }
      if (event.type === "run.error") {
        const message = typeof payload.message === "string" ? payload.message : "Erreur Hermes.";
        const errorCode = typeof payload.errorCode === "string" ? payload.errorCode : "HERMES_RUN_FAILED";
        await transitionRuns(tx as unknown as SQL, {
          target: runKey(context), fence: lease,
          transition: { from: ACTIVE_RUN_STATUSES, to: { status: "failed", externalState: "settled" } },
          set: {
            errorCode, errorMessage: message, eventsComplete: payload.reconciled !== true,
            completionKind: payload.reconciled === true ? "reconciled_failure" : "failed", endedAt: NOW, ...RELEASE_LEASE,
          },
        });
        // Un tour de salon échoué vaut un pass : l'erreur reste visible sur le
        // run, et l'envoi continue avec le membre suivant.
        const state = isServiceStepKind(context.stepKind) ? null : groupSendState(context);
        if (state) {
          const settled = await advanceGroupTx(tx, context, state, null);
          if (settled) result.push(settled);
        }
        // Un run entrant échoué livre quand même son issue au courrier.
        if (!isServiceStepKind(context.stepKind) && context.originRunId) {
          result.push(...await deliverHandoffReplyTx(tx, context, { status: "failed", output: null, error: message }));
        }
        if (context.workflowId && !state && context.groupTurnPosition !== null) {
          // Tour de salon hérité en revue (0175) : aucune étape ne le règle.
          await settleReviewWorkflowTx(tx, context, { status: "failed", errorCode, message });
        } else if (context.workflowId && !state) {
          result.push(...await advanceWorkflowFailureTx(tx, context, message, errorCode));
        }
      }
    }
    await advanceHermesWatermark(tx as unknown as SQL, runKey(context), { generation: context.leaseGeneration }, rawSequence);
    return result;
  }) as OrganizationEvent[];
  } catch (error) {
    if (!isRunEventsLeaseFence(error)) throw error;
    log("worker.run_events_lease_abandoned", {
      runId: context.id,
      organizationId: context.organizationId,
      leaseGeneration: context.leaseGeneration,
    });
    return [];
  }
  const hasText = envelopes.some((envelope) => envelope.type === "agent.message");
  const hasTerminal = envelopes.some((envelope) => envelope.type === "run.completed" || envelope.type === "run.error");
  if (trace && envelopes.length > 0) {
    trace.mark("openedbot.first_event_committed");
    if (hasText) trace.mark("openedbot.first_text_committed");
    if (hasTerminal) trace.mark("openedbot.terminal_committed");
  }
  // Lot dont chaque trame est déjà partie en pré-commit : le réveil du
  // poller n'a rien d'urgent (les clients ont le texte), il rejoint le POST
  // du flush suivant. Terminaux, reçus et notices partent tout de suite.
  const alreadyPushed = earlyEvents.length > 0 && envelopes.length === earlyEvents.length
    && envelopes.every((envelope) => EARLY_EVENT_TYPES.has(envelope.type as RunEvent["type"]));
  if (alreadyPushed) deferWake(config, context.id, envelopes[envelopes.length - 1]!);
  else await publishBatch(config, envelopes);
  // Le fan-out a déjà daté « publié ». Ces marques ne gagnent que si ce lot
  // n'avait rien à pousser avant le commit (première occurrence seulement).
  if (trace && envelopes.length > 0) {
    trace.mark("openedbot.first_event_published");
    if (hasText) trace.mark("openedbot.first_text_published");
    if (hasTerminal) trace.mark("openedbot.terminal_published");
  }
  if (events.some((event) => event.type === "run.completed" || event.type === "run.error")) {
    await expireUnacknowledgedRunSteers(db, {
      id: context.id,
      organizationId: context.organizationId,
    });
  }
  if (events.some((event) => event.type === "run.completed") && context.provider) {
    await clearProviderIncident(db, context.organizationId, context.runtimeId, context.provider);
  }
  return envelopes;
}
