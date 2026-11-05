import type { SQL } from "bun";
import { APPROVAL_LEASE_EXPIRED_CODE, APPROVAL_MAX_ATTEMPTS_CODE } from "@openedbot/contracts-errors";
import type { WorkerConfig } from "./worker-config";
import { recoverRunSteersBeforeClaim } from "./run-steering";
import { captureRunEventTx, withRunReceiptJournal, type RunJournalEvent } from "./run-receipts";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import { isGroupSendState } from "../domain/group-send";
import { appendNoticeTx, appendRunErrorTx, publishBatch } from "./runner/events";
import { deliverHandoffReplyTx } from "./runner/handoff";
import { advanceGroupTx, advanceLegacyGroupTx } from "./runner/rooms";
import type { RunContext } from "./runner/types";
import { log } from "./runner/util";
import { advanceWorkflowFailureTx } from "./runner/workflows";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";

export type ClaimedRun = {
  id: string;
  organizationId: string;
  leaseGeneration: number;
  /** Création du run → réclamation, mesuré par la seule horloge PostgreSQL. */
  queuedMs?: number;
};

/** Plafond de tentatives partagé (reaper de baux + retry Hermes). Au-delà: échec terminal. */
export const MAX_RUN_ATTEMPTS = 5;

/**
 * Commit the approval reaper before acquiring unrelated claim candidates: a
 * transaction must never keep a gate lock and then go looking for another run.
 */
async function reapExpiredApprovalSends(db: SQL): Promise<void> {
  await db.begin(async (tx) => {
    // A process can die after Hermes received an approval but before the DB
    // confirmation. Replaying that decision could duplicate a consequential
    // action, so an expired `sending` lease is always a review state.
    await tx`
      with expired_gate_parents as (
        select distinct organization_id, run_id
          from approval_requests
         where forward_state = 'sending' and forwarding_lease_expires_at <= now()
      ), locked_runs as (
        select run.organization_id, run.id, run.workflow_id
          from runs run
          join expired_gate_parents parent
            on parent.organization_id = run.organization_id and parent.run_id = run.id
         order by run.organization_id, run.id
         for update of run
      ), locked_workflows as (
        select workflow.organization_id, workflow.id
          from workflows workflow
          join locked_runs run
            on run.organization_id = workflow.organization_id and run.workflow_id = workflow.id
         order by workflow.organization_id, workflow.id
         for update of workflow
      ), locked_gates as (
        select approval.id, approval.organization_id, approval.run_id
          from approval_requests approval
          join locked_runs run
            on run.organization_id = approval.organization_id and run.id = approval.run_id
          left join locked_workflows workflow
            on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
         where approval.forward_state = 'sending' and approval.forwarding_lease_expires_at <= now()
           and (run.workflow_id is null or workflow.id is not null)
         order by approval.organization_id, approval.run_id, approval.gate_ordinal
         for update of approval
      ), ambiguous_gates as (
        update approval_requests approval set forward_state = 'ambiguous', forwarding_owner = null,
          forwarding_lease_expires_at = null
         from locked_gates locked
         where approval.id = locked.id and approval.organization_id = locked.organization_id
         returning approval.organization_id, approval.run_id
      ), ambiguous_runs as (
        update runs r set status = 'unknown', external_state = 'ambiguous', events_complete = false,
          error_code = 'APPROVAL_FORWARD_OUTCOME_UNKNOWN',
          error_message = 'La transmission de la décision Hermes est incertaine.',
          lease_owner = null, lease_expires_at = null, updated_at = now()
         from ambiguous_gates gate
         where r.organization_id = gate.organization_id and r.id = gate.run_id
           and r.status in ('starting','running','awaiting_approval')
         returning r.organization_id, r.thread_id, r.id as run_id, r.workflow_id
      ), ambiguous_workflows as (
        update workflows workflow set status = 'unknown', error_code = 'APPROVAL_FORWARD_OUTCOME_UNKNOWN',
          error_message = 'La transmission de la décision Hermes est incertaine.', updated_at = now()
         from ambiguous_runs run
         where workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
           and workflow.status not in ('completed','failed','cancelled','expired')
         returning workflow.organization_id, workflow.id
      ), cursor_locks as materialized (
        select organization_id,
               pg_advisory_xact_lock(hashtext(organization_id::text), hashtext('openedbot-run-events-cursor')) as locked
          from (select distinct organization_id from ambiguous_runs) organizations
         order by organization_id
      ), event_rows as (
        select run.organization_id, run.thread_id, run.run_id,
               coalesce((select max(event.sequence) + 1 from run_events event
                          where event.organization_id = run.organization_id and event.run_id = run.run_id), 0) as sequence
          from ambiguous_runs run
          join cursor_locks cursor on cursor.organization_id = run.organization_id
      )
      insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)
      select organization_id, thread_id, run_id, sequence, 'run.error',
             jsonb_build_object(
               'message', 'Transmission d’autorisation incertaine : vérification requise.',
               'errorCode', 'APPROVAL_FORWARD_OUTCOME_UNKNOWN',
               'recoveryState', 'needs_review'
             ), now()
        from event_rows
      on conflict (organization_id, run_id, sequence) do nothing
    `;
  });
}

/**
 * One expiry pass over the queue, in the single transaction `claimRun` opens
 * before it claims: steering recovery, lease recovery of `starting`/`running`
 * and `awaiting_approval` runs, workflow deadlines before and after Hermes,
 * and the lease lost during a Hermes create. Idempotent, shared by the dedicated
 * sweep job and the head of `claimRun`.
 */
async function sweepExpiredRunsTx(tx: SQL): Promise<void> {
  // Recover steering before holding an unrelated expired target. A late ACK
  // locks source/target in id order; requeueing the target first would invert
  // that order when recovery later waits for the ACK's source lock.
  await recoverRunSteersBeforeClaim(tx);
  // Inclure awaiting_approval: un worker mort pendant une approbation laissait
  // sinon le run orphelin à vie (bail expiré, jamais réclamé, fil bloqué). À la
  // reprise, executeRun reconnecte le stream Hermes et le heartbeat transmet la
  // réponse déjà saisie. Un worker vivant renouvelle son bail, donc n'est pas volé.
  // `error_code` garde la cause la plus explicative pour l'opérateur : un run
  // dont l'arrêt était DÉJÀ demandé a été arrêté par lui, et le bail n'a fait
  // que retarder la clôture. Écraser avec 'WORKER_LEASE_EXPIRED' affichait un
  // code de panne interne sous le « Run annulé. » qu'il venait de demander.
  await tx`
    update runs set status = 'queued', lease_owner = null, lease_expires_at = null,
      next_attempt_at = null,
      error_code = case when remote_stop_state = 'requested'
        then coalesce(error_code, 'CANCELLED_BY_USER') else 'WORKER_LEASE_EXPIRED' end,
      external_state = case when hermes_run_id is null then 'not_started' else 'polling' end,
      events_complete = case when hermes_run_id is null then events_complete else false end,
      updated_at = now()
     where status in ('starting','running')
       and (lease_expires_at < now() or lease_owner is null or lease_expires_at is null)
       and attempts < ${MAX_RUN_ATTEMPTS}
       and (external_state = 'not_started' or hermes_run_id is not null)
  `;
  // A workflow can spend its entire lifetime waiting for capacity or a runtime.
  // Once its deadline passes, that pre-Hermes run can never be claimed, so
  // settle the run and its workflow together while keeping run -> workflow
  // lock order. Runs that may have crossed Hermes are deliberately excluded.
  // A plain DM run has no workflow and carries its own `deadline_at`.
  const expiredEvents = await tx<RunJournalEvent[]>`
    with overdue_runs as (
      select run.organization_id, run.id, run.workflow_id
        from runs run
        left join workflows workflow
          on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
       where run.status = 'queued' and run.external_state = 'not_started'
         and run.hermes_run_id is null and run.remote_stop_state is null
         and (
           (workflow.status in ('queued','running','awaiting_approval') and workflow.deadline_at <= now())
           or (run.workflow_id is null and run.deadline_at <= now())
         )
       order by run.organization_id, run.id
       for update of run skip locked
       limit 50
    ), overdue_workflows as (
      select workflow.organization_id, workflow.id
        from workflows workflow
        join overdue_runs run
          on run.organization_id = workflow.organization_id and run.workflow_id = workflow.id
       where workflow.status in ('queued','running','awaiting_approval')
         and workflow.deadline_at <= now()
       order by workflow.organization_id, workflow.id
       for update of workflow
    ), expired_runs as (
      update runs run set status = 'failed', external_state = 'settled', events_complete = true,
        completion_kind = 'workflow_deadline_before_start',
        error_code = 'WORKFLOW_DEADLINE_EXCEEDED',
        error_message = 'La durée maximale du workflow est atteinte avant son démarrage.',
        ended_at = now(), lease_owner = null, lease_expires_at = null,
        next_attempt_at = null, updated_at = now()
       from overdue_runs overdue
       left join overdue_workflows workflow
         on workflow.organization_id = overdue.organization_id and workflow.id = overdue.workflow_id
       where run.organization_id = overdue.organization_id and run.id = overdue.id
         and run.status = 'queued' and run.external_state = 'not_started'
         and (overdue.workflow_id is null or workflow.id is not null)
       returning run.organization_id, run.thread_id, run.id as run_id, run.workflow_id
    ), expired_workflows as (
      update workflows workflow set status = 'expired',
        error_code = 'WORKFLOW_DEADLINE_EXCEEDED',
        error_message = 'La durée maximale du workflow est atteinte avant son démarrage.',
        ended_at = now(), updated_at = now()
       from expired_runs run
       where workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
         and workflow.status in ('queued','running','awaiting_approval')
       returning workflow.organization_id, workflow.id
    )
    select organization_id as "organizationId", thread_id as "threadId", run_id as "runId",
           'run.error' as type,
           jsonb_build_object(
             'message', 'La durée maximale du workflow est atteinte avant son démarrage.',
             'errorCode', 'WORKFLOW_DEADLINE_EXCEEDED'
           ) as payload
      from expired_runs
  `;
  for (const event of expiredEvents) captureRunEventTx(tx, event);
  // A requeued run with a durable Hermes id also must not stay behind the
  // deadline guard forever. If no stop boundary was ever persisted, schedule
  // the first stop. Otherwise force `polling + requested`, whose runner path is
  // GET-only, so a crash can never replay an ambiguous POST /stop.
  const stopEvents = await tx<RunJournalEvent[]>`
    with overdue_external_runs as (
      select run.organization_id, run.id, run.workflow_id, run.remote_stop_state
        from runs run
        left join workflows workflow
          on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
       where run.status = 'queued' and run.hermes_run_id is not null
         and run.external_state <> 'settled' and run.remote_stop_state is distinct from 'requested'
         and (
           (workflow.status in ('queued','running','awaiting_approval') and workflow.deadline_at <= now())
           or (run.workflow_id is null and run.deadline_at <= now())
         )
       order by run.organization_id, run.id
       for update of run skip locked
       limit 50
    ), overdue_external_workflows as (
      select workflow.organization_id, workflow.id
        from workflows workflow
        join overdue_external_runs run
          on run.organization_id = workflow.organization_id and run.workflow_id = workflow.id
       where workflow.status in ('queued','running','awaiting_approval')
         and workflow.deadline_at <= now()
       order by workflow.organization_id, workflow.id
       for update of workflow
    ), requested_runs as (
      update runs run set
        external_state = case when overdue.remote_stop_state is null then 'stopping' else 'polling' end,
        remote_stop_state = 'requested', events_complete = false,
        error_code = 'WORKFLOW_DEADLINE_EXCEEDED',
        error_message = 'La durée maximale du workflow est atteinte; arrêt Hermes requis.',
        next_attempt_at = now(), updated_at = now()
       from overdue_external_runs overdue
       left join overdue_external_workflows workflow
         on workflow.organization_id = overdue.organization_id and workflow.id = overdue.workflow_id
       where run.organization_id = overdue.organization_id and run.id = overdue.id
         and run.status = 'queued' and run.hermes_run_id is not null
         and (overdue.workflow_id is null or workflow.id is not null)
       returning run.organization_id, run.thread_id, run.id as run_id, run.workflow_id
    ), requested_workflows as (
      update workflows workflow set error_code = 'WORKFLOW_DEADLINE_EXCEEDED',
        error_message = 'La durée maximale du workflow est atteinte; arrêt Hermes requis.',
        recovery_state = ${{ cancelRequested: true, reason: "deadline" }}, updated_at = now()
       from requested_runs run
       where workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
         and workflow.status in ('queued','running','awaiting_approval')
       returning workflow.organization_id, workflow.id
    )
    select organization_id as "organizationId", thread_id as "threadId", run_id as "runId",
           'system.notice' as type,
           jsonb_build_object(
             'message', 'Délai du workflow atteint : arrêt et vérification Hermes en cours.',
             'kind', 'workflow.deadline_stop_requested',
             'errorCode', 'WORKFLOW_DEADLINE_EXCEEDED',
             'workflowId', workflow_id
           ) as payload
      from requested_runs
  `;
  for (const event of stopEvents) captureRunEventTx(tx, event);
  // Sending POST /v1/runs without receiving/storing a run id is the unsafe
  // boundary: the old request may have executed, so never create again.
  await tx`
    with ambiguous as (
      update runs set status = 'unknown', external_state = 'ambiguous', events_complete = false,
        error_code = 'HERMES_CREATE_OUTCOME_UNKNOWN',
        error_message = 'Le worker a perdu son bail pendant la création Hermes; aucune relance automatique.',
        lease_owner = null, lease_expires_at = null, updated_at = now()
       where status in ('starting','running','awaiting_approval')
         and (lease_expires_at < now() or lease_owner is null or lease_expires_at is null)
         and hermes_run_id is null and external_state in ('creating','streaming','stopping')
       returning organization_id, workflow_id
    )
    update workflows w set status = 'unknown', error_code = 'HERMES_CREATE_OUTCOME_UNKNOWN',
      error_message = 'L’effet de la création Hermes est incertain.', updated_at = now()
     from ambiguous a
     where w.organization_id = a.organization_id and w.id = a.workflow_id
  `;
  await tx`
    update runs set status = 'queued', lease_owner = null, lease_expires_at = null,
      next_attempt_at = null, error_code = ${APPROVAL_LEASE_EXPIRED_CODE},
      error_message = 'Le worker a expiré pendant l’approbation; reprise de la demande.',
      external_state = case when hermes_run_id is null then 'ambiguous' else 'polling' end,
      events_complete = false, updated_at = now()
     where status = 'awaiting_approval'
       and (lease_expires_at < now() or lease_owner is null or lease_expires_at is null)
       and hermes_run_id is not null
       and attempts < ${MAX_RUN_ATTEMPTS}
  `;
}

/**
 * Requeues or settles every run whose lease or deadline has expired, without
 * claiming anything. The worker runs it on its own job so that `claimRun` does
 * not have to be the only thing that notices an expired lease; `claimRun` still
 * runs the same pass before it claims, which is what makes an expired lease
 * reclaimable on the next tick whether or not the job has run.
 */
export async function sweepExpiredRuns(db: SQL, _config: WorkerConfig): Promise<void> {
  await reapExpiredApprovalSends(db);
  await withRunReceiptJournal(db, (tx) => sweepExpiredRunsTx(tx));
}

export async function claimRun(db: SQL, config: WorkerConfig): Promise<ClaimedRun | null> {
  await reapExpiredApprovalSends(db);
  return withRunReceiptJournal(db, async (tx) => {
    // Guard: keep the pass at the head of the claim, in the claim's own transaction.
    await sweepExpiredRunsTx(tx);
    const rows = await tx<ClaimedRun[]>`
      with candidate_run as (
        select r.id, r.organization_id, r.workflow_id, r.remote_stop_state
          from runs r
          left join ${subscriptionPort().admission(tx)} s on s.organization_id = r.organization_id
          join runtimes rt on rt.organization_id = r.organization_id and rt.revoked_at is null and rt.is_active
            -- Un runtime connector dont le lien est muet depuis 45 s ne
            -- réclame rien : le run attend, ou échoue RUNTIME_DISCONNECTED
            -- passé WORKER_LINK_QUEUE_TIMEOUT_MS (maintenance/runtime-links.ts).
            and ((rt.reachability = 'connector' and rt.link_last_seen_at > now() - interval '45 seconds')
          or (rt.reachability = 'direct' and rt.last_health_status = 'healthy'
            and rt.last_probed_at > now() - interval '90 seconds'))
          left join workflows workflow
            on workflow.organization_id = r.organization_id and workflow.id = r.workflow_id
         where r.status = 'queued'
           and not exists (
             select 1 from bot_profile_provisions pp
              where pp.organization_id = r.organization_id and pp.bot_id = r.bot_id
                and pp.status <> 'succeeded'
                -- L'accueil attend lui aussi le profil du bot (~9 s) : il
                -- s'écrit en direct, avec sa vraie persona, une fois le fil
                -- et le composer arrivés (DESIGN.md, « Démarrage d'un bot neuf »).
           )
           and (r.next_attempt_at is null or r.next_attempt_at <= now())
           and (
             r.remote_stop_state = 'requested'
             or not exists (
               -- A target can finish after the recovery snapshot. Do not start
               -- its source until recovery has durably settled the attempt;
               -- otherwise a later receipt can collide with its normalizer.
               select 1 from run_steering_attempts steer
                where steer.organization_id = r.organization_id and steer.source_run_id = r.id
                  and steer.status in ('pending','sending','ambiguous')
             )
           )
           and (
             r.remote_stop_state = 'requested'
             or (r.workflow_id is null and (r.deadline_at is null or r.deadline_at > now()))
             or workflow.status = 'reconciling'
             or (
               workflow.status in ('queued','running','awaiting_approval')
               and workflow.deadline_at > now()
             )
           )
           and (
             -- Un POST /stop déjà durable doit être réconcilié en priorité.
             -- Sinon, un seul run par fil est réclamable et tous les tours du
             -- workflow le plus ancien restent contigus avant le follow-up
             -- suivant. Un état externe actif/unknown bloque toujours le fil.
             r.remote_stop_state = 'requested'
             or not exists (
               select 1
                 from runs blocker
                 left join workflows blocker_workflow
                   on blocker_workflow.organization_id = blocker.organization_id
                  and blocker_workflow.id = blocker.workflow_id
                where blocker.organization_id = r.organization_id
                  and blocker.thread_id = r.thread_id
                  and blocker.id <> r.id
                  and blocker.status in (
                    'queued','starting','running','awaiting_approval','relaying','unknown'
                  )
                  and (
                    blocker.status <> 'queued'
                    or (
                      coalesce(blocker_workflow.created_at, blocker.created_at),
                      coalesce(blocker_workflow.id, blocker.id),
                      coalesce(blocker.step_index, 0), blocker.created_at, blocker.id
                    ) < (
                      coalesce(workflow.created_at, r.created_at),
                      coalesce(workflow.id, r.id),
                      coalesce(r.step_index, 0), r.created_at, r.id
                    )
                  )
             )
           )
           and (
             -- Un arrêt connu ne crée aucun nouvel effet Hermes : il doit pouvoir
             -- vider une annulation même après la fin de l'abonnement ou à capacité pleine.
             r.remote_stop_state = 'requested'
             or (
               (${!config.billingEnforced} or s.status in ('active','trialing'))
               and (
                 select count(*) from runs active
                  where active.organization_id = r.organization_id
                    and active.status in ('starting','running','awaiting_approval','unknown')
               ) < (
                 -- Billing appliqué: plafond de plan (+ garde-fou 4). Sinon (test/BYO):
                 -- borné uniquement par ce que le runtime Hermes DU CLIENT déclare encaisser.
                case when ${config.billingEnforced}
                  then least(4, coalesce(s.concurrent_run_limit, 0), rt.capacity)
                  else rt.capacity
                end
               )
             )
           )
         order by (r.remote_stop_state = 'requested') desc,
                  coalesce(workflow.created_at, r.created_at) asc,
                  coalesce(workflow.id, r.id) asc,
                  coalesce(r.step_index, 0) asc, r.created_at asc, r.id asc
         for update of r, rt skip locked
         limit 1
      ), workflow_guard as (
        -- Le run est déjà verrouillé. Verrouiller ensuite son workflow garde le
        -- même ordre que les transitions API et revalide son état sous concurrence.
        select workflow.id, workflow.organization_id
          from workflows workflow
          join candidate_run candidate
            on candidate.workflow_id = workflow.id
           and candidate.organization_id = workflow.organization_id
         where candidate.remote_stop_state = 'requested'
            or workflow.status = 'reconciling'
            or (
              workflow.status in ('queued','running','awaiting_approval')
              and workflow.deadline_at > now()
            )
         for update of workflow
      ), candidate as (
        select candidate_run.id, candidate_run.organization_id
          from candidate_run
         where candidate_run.workflow_id is null
            or exists (
              select 1 from workflow_guard workflow
               where workflow.organization_id = candidate_run.organization_id
                 and workflow.id = candidate_run.workflow_id
            )
      )
      update runs r set
        status = 'starting', lease_owner = ${config.workerId},
        lease_expires_at = now() + (${config.leaseSeconds} * interval '1 second'),
        heartbeat_at = now(), attempts = attempts + 1,
        lease_generation = lease_generation + 1, updated_at = now()
      from candidate
      where r.id = candidate.id
      returning r.id, r.organization_id as "organizationId", r.lease_generation as "leaseGeneration",
        (extract(epoch from (clock_timestamp() - r.created_at)) * 1000)::float8 as "queuedMs"
    `;
    return rows[0] ? { ...rows[0], leaseGeneration: Number(rows[0].leaseGeneration) } : null;
  }) as Promise<ClaimedRun | null>;
}

/**
 * Cheap fingerprint of the queued set, read from the partial `runs_queue_idx`.
 * It is only a wake-up hint for a worker without LISTEN: a changed
 * value means "claim now", never "this run is yours". `claimRun` stays the only
 * claim authority.
 */
export async function readQueuedRunsSignature(db: SQL): Promise<string> {
  const [row] = await db<Array<{ queued: number; newest: string | null }>>`
    select count(*)::int as queued, max(created_at)::text as newest
      from runs where status = 'queued'
  `;
  return `${row?.queued ?? 0}:${row?.newest ?? ""}`;
}

type PoisonRun = {
  id: string;
  organizationId: string;
  threadId: string;
  botId: string | null;
  status: "starting" | "running" | "awaiting_approval";
  groupId: string | null;
  groupTurnPosition: number | null;
  input: string;
  groupState: unknown;
  originRunId: string | null;
  hermesRunId: string | null;
  externalState: RunContext["externalState"];
  workflowId: string | null;
  stepIndex: number | null;
  stackDepth: number;
  callerBotId: string | null;
  callerRunId: string | null;
  botName: string;
  botSlug: string;
};

const WORKER_MAX_ATTEMPTS_MESSAGE = "Run abandonné après trop de tentatives.";
const APPROVAL_MAX_ATTEMPTS_MESSAGE = "Approbation abandonnée après trop de tentatives du worker.";
const POISON_OUTCOME_UNKNOWN_CODE = "HERMES_OUTCOME_UNKNOWN_MAX_ATTEMPTS";
const POISON_OUTCOME_UNKNOWN_MESSAGE =
  "Le worker a épuisé ses tentatives sans confirmer l’issue Hermes. Réconciliation ou abandon explicite requis.";

/** Seules l'absence prouvée d'appel externe et une issue persistée comme settled sont terminales. */
function poisonRunNeedsRecovery(externalState: PoisonRun["externalState"]): boolean {
  return externalState !== "not_started" && externalState !== "settled";
}

/**
 * Récupère les leases qui ont épuisé leurs tentatives. Une issue externe
 * non confirmée reste `unknown`; seuls les cas prouvés terminaux empruntent le
 * chemin événementiel qui livre les hand-offs ou fait avancer les salons.
 */
export async function reapPoisonRuns(db: SQL, config: WorkerConfig): Promise<number> {
  const result = await db.begin(async (tx) => {
    const rows = await tx<PoisonRun[]>`
      select r.id, r.organization_id as "organizationId", r.thread_id as "threadId",
             r.bot_id as "botId", r.status, t.group_id as "groupId",
             r.group_turn_position as "groupTurnPosition", r.input, r.group_state as "groupState",
             r.origin_run_id as "originRunId", r.hermes_run_id as "hermesRunId",
             r.external_state as "externalState", r.workflow_id as "workflowId",
             r.step_index as "stepIndex", r.stack_depth as "stackDepth",
             r.caller_bot_id as "callerBotId", r.caller_run_id as "callerRunId",
             coalesce(b.name, 'bot') as "botName", coalesce(b.slug, 'bot') as "botSlug"
        from runs r
        join threads t on t.organization_id = r.organization_id and t.id = r.thread_id
        left join bots b on b.organization_id = r.organization_id and b.id = r.bot_id
       where r.status in ('starting','running','awaiting_approval')
         and r.lease_expires_at < now() and r.attempts >= ${MAX_RUN_ATTEMPTS}
       order by r.updated_at asc
       for update of r skip locked
       limit 20
    `;
    // Every recovery writer uses the same acquisition order as cancellation and
    // approval forwarding. Pre-locking the complete batch prevents a poison gate
    // from holding an approval row while another transaction holds its workflow.
    const workflowIds = [...new Set(rows.map((row) => row.workflowId).filter((id): id is string => Boolean(id)))].sort();
    if (workflowIds.length > 0) await tx`
      select organization_id, id from workflows where id in ${tx(workflowIds)}
       order by organization_id, id for update
    `;
    const runIds = rows.map((row) => row.id).sort();
    if (runIds.length > 0) await tx`
      select id from approval_requests where run_id in ${tx(runIds)}
       order by organization_id, run_id, gate_ordinal for update
    `;
    const envelopes: OrganizationEvent[] = [];
    const unknownRuns: Array<{ id: string; organizationId: string; workflowId: string | null }> = [];
    for (const row of rows) {
      const approval = row.status === "awaiting_approval";

      if (poisonRunNeedsRecovery(row.externalState)) {
        await tx`
          update runs set status = 'unknown', external_state = 'ambiguous', events_complete = false,
            remote_stop_state = case when external_state = 'stopping' then 'ambiguous' else remote_stop_state end,
            error_code = ${POISON_OUTCOME_UNKNOWN_CODE}, error_message = ${POISON_OUTCOME_UNKNOWN_MESSAGE},
            ended_at = null, lease_owner = null, lease_expires_at = null, updated_at = now()
           where organization_id = ${row.organizationId} and id = ${row.id}
             and status in ('starting','running','awaiting_approval')
        `;
        if (approval) {
          await tx`
            update approval_requests set
              status = case when status = 'pending' then 'expired' else status end,
              forward_state = 'expired', resolved_at = coalesce(resolved_at, now()),
              forwarding_owner = null, forwarding_lease_expires_at = null
             where organization_id = ${row.organizationId} and run_id = ${row.id}
               and (status = 'pending' or forward_state in ('pending','ready','sending','ambiguous'))
          `;
        }
        const recoveryAction = row.hermesRunId
          ? "reconcile_or_abandon"
          : "abandon_or_retry_with_duplicate_risk";
        if (row.workflowId) {
          await tx`
            update workflows set status = 'unknown', error_code = ${POISON_OUTCOME_UNKNOWN_CODE},
              error_message = ${POISON_OUTCOME_UNKNOWN_MESSAGE},
              recovery_state = ${{
                runId: row.id,
                needsReview: true,
                action: recoveryAction,
                hermesRunIdAvailable: row.hermesRunId !== null,
              }}, ended_at = null, updated_at = now()
             where organization_id = ${row.organizationId} and id = ${row.workflowId}
               and status in ('queued','running','awaiting_approval','reconciling','unknown')
          `;
        }
        const notice = await appendNoticeTx(tx, row, {
          message: row.hermesRunId
            ? "Issue Hermes incertaine : réconciliez le run identifié ou abandonnez le workflow."
            : "Issue Hermes incertaine sans identifiant : abandonnez ou relancez en confirmant le risque de doublon.",
          kind: "workflow.needs_review",
          errorCode: POISON_OUTCOME_UNKNOWN_CODE,
          workflowId: row.workflowId,
          recoveryState: "needs_review",
          recoveryAction,
        });
        if (notice) envelopes.push(notice);
        unknownRuns.push({ id: row.id, organizationId: row.organizationId, workflowId: row.workflowId });
        continue;
      }

      const errorCode = approval ? APPROVAL_MAX_ATTEMPTS_CODE : "WORKER_MAX_ATTEMPTS";
      const message = approval ? APPROVAL_MAX_ATTEMPTS_MESSAGE : WORKER_MAX_ATTEMPTS_MESSAGE;
      await tx`
        update runs set status = 'failed', error_code = ${errorCode}, error_message = ${message},
          ended_at = now(), lease_owner = null, lease_expires_at = null, updated_at = now()
         where organization_id = ${row.organizationId} and id = ${row.id}
      `;
      if (approval) {
        await tx`
          update approval_requests set
            status = case when status = 'pending' then 'expired' else status end,
            forward_state = 'expired', resolved_at = coalesce(resolved_at, now()),
            forwarding_owner = null, forwarding_lease_expires_at = null
           where organization_id = ${row.organizationId} and run_id = ${row.id}
             and (status = 'pending' or forward_state in ('pending','ready','sending','ambiguous'))
        `;
      }
      const errorEvent = await appendRunErrorTx(tx, row, message, errorCode);
      if (errorEvent) envelopes.push(errorEvent);

      // An inbound hand-off has priority over group state (the two are mutually
      // exclusive in the API, but keeping this order makes recovery idempotent).
      if (row.originRunId) {
        envelopes.push(...await deliverHandoffReplyTx(tx, {
          organizationId: row.organizationId,
          id: row.id,
          originRunId: row.originRunId,
          botId: row.botId,
          botName: row.botName,
          botSlug: row.botSlug,
        }, { status: "failed", output: null, error: message }));
        if (row.workflowId) {
          envelopes.push(...await advanceWorkflowFailureTx(tx, row, message, errorCode));
        }
        continue;
      }
      if (row.groupId && isGroupSendState(row.groupState)) {
        const settled = await advanceGroupTx(tx, {
          organizationId: row.organizationId,
          threadId: row.threadId,
          id: row.id,
          botId: row.botId,
          groupId: row.groupId,
          workflowId: row.workflowId,
          stepIndex: row.stepIndex,
        }, row.groupState, null);
        if (settled) envelopes.push(settled);
      } else if (row.groupId && row.groupTurnPosition !== null) {
        // Legacy group chains do not carry group_state; preserve their historical
        // next-member handoff when a poison run is finalized.
        await advanceLegacyGroupTx(tx, {
          organizationId: row.organizationId,
          threadId: row.threadId,
          id: row.id,
          groupId: row.groupId,
          groupTurnPosition: row.groupTurnPosition,
          input: row.input,
        });
      } else if (row.workflowId) {
        envelopes.push(...await advanceWorkflowFailureTx(tx, row, message, errorCode));
      }
    }
    return { count: rows.length, envelopes, unknownRuns };
  }) as {
    count: number;
    envelopes: OrganizationEvent[];
    unknownRuns: Array<{ id: string; organizationId: string; workflowId: string | null }>;
  };
  await publishBatch(config, result.envelopes);
  for (const row of result.unknownRuns) {
    log("worker.poison_run_unknown", {
      runId: row.id,
      organizationId: row.organizationId,
      workflowId: row.workflowId,
      code: POISON_OUTCOME_UNKNOWN_CODE,
    });
  }
  return result.count;
}
