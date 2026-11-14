import type { SQL } from "bun";
import {
  type BotIdentity,
} from "@openedbot/roster/domain/bot-mode";
import { appendRunEventsTx } from "@openedbot/execution/application/run-events";
import { NOW, transitionRuns } from "@openedbot/execution/application/run-transitions";
import { SERVICE_STEP_KINDS } from "@openedbot/execution/domain/run-step";
import type { MessageContent } from "@openedbot/contracts-api";
import { logEvent } from "@openedbot/platform-observability";
import { RunTrace, runLatencyVerdicts } from "@openedbot/platform-observability/run-trace";
import { traceIdOfRun } from "@openedbot/platform-observability/trace-context";
import {
  type CancellationRun,
} from "@openedbot/execution/application/run-cancellation";

/** The public Hermes contract bounds a steer's text to 64 KiB of characters. */
export const MAX_RUN_STEER_CHARS = 65_536;

// ── Bot mode (hand-off `@mention`) ───────────────────────────────────────────
//
// A "courier" (run `handoff_target_bot_id`, status 'relaying') occupies the
// ORIGIN thread without ever calling Hermes; the "inbound" run
// (`origin_run_id`) lives in the TARGET's DM thread and runs like an ordinary
// run. Delivery of the reply is done by the worker; the API delivers
// only the "cancelled" outcome (it alone knows how to cancel a run).

/**
 * Finds the only target a follow-up can be injected into without breaking
 * routing. A claimed turn (`starting` with a lease) or one already `running` /
 * `awaiting_approval` counts, even before the first Hermes byte: the steer
 * stays `pending` until the stream. The key-share lock freezes eligibility
 * until the fallback's commit.
 */
export async function activeRunSteerTargetTx(
  tx: Bun.TransactionSQL,
  input: {
    organizationId: string;
    threadId: string;
    botId: string;
    groupId: string | null;
    input: string;
    attachmentCount: number;
    replyToId: string | null;
    handoff: boolean;
  },
): Promise<string | null> {
  if (
    input.groupId || input.attachmentCount > 0 || input.replyToId || input.handoff ||
    input.input.length === 0 || input.input.length > MAX_RUN_STEER_CHARS
  ) return null;
  // A service run (memory pass, persona draft, compaction)
  // shares the DM's thread and bot but is not a conversation: a
  // follow-up injected into it would join an extraction session with no
  // bubble, and the operator's fallback run would be cancelled with no reply
  // (observed on 07-09: a question asked 15 s after « retiens que… », swallowed
  // by the memory pass). A routine's run stays a target: a message steered
  // into it then executes under the routine's policy, « Ne jamais attendre »
  // included (known consequence, left as is).
  const rows = await tx<Array<{ id: string }>>`
    select run.id from runs run
     where run.organization_id = ${input.organizationId}
       and run.thread_id = ${input.threadId}
       and run.bot_id = ${input.botId}
       and run.status in ('starting', 'running', 'awaiting_approval')
       and run.origin is distinct from 'bot_greeting'
       and (run.lease_owner is not null or run.status = 'running')
       and (run.step_kind is null or run.step_kind not in ${tx([...SERVICE_STEP_KINDS])})
       and run.remote_stop_state is null
     order by run.started_at asc nulls last, run.created_at asc, run.id asc
     limit 1 for key share
  `;
  return rows[0]?.id ?? null;
}

/**
 * The API half of the tracer From receipt of the POST to the commit, in
 * names and durations only. The worker resumes at the claim, linked by
 * `runId` and by `queuedMs` (PostgreSQL clock). `traceId` is the one
 * the worker, the relay and the connector log for this run: it is born here,
 * with the run (S7).
 */
export function logRunAdmission(runId: string, organizationId: string, trace: RunTrace): void {
  const summary = trace.summary();
  logEvent("run.admission", {
    runId,
    organizationId,
    traceId: traceIdOfRun(runId),
    ...summary,
    verdicts: runLatencyVerdicts({ admission: summary.marks["api.committed"] ?? null }),
  });
}

export type FollowupDisposition =
  | { kind: "fold"; runId: string; workflowId: string | null; autonomyEnabled: boolean }
  | { kind: "enqueue"; runId: string; workflowId: string | null; autonomyEnabled: boolean; attemptId: string; targetRunId: string }
  | { kind: "supersede"; runId: string; texts: string[]; steerTexts: string[] }
  | { kind: "steer"; runId: string }
  | { kind: "fifo" };

/**
 * What a text DM message becomes when the bot is already working: the reference app's
 * « supersede + prepend » policy, see `@openedbot/conversation/domain/followup`.
 *
 * The order is that of the preference: fold into a run still queued (nothing
 * is computed, nothing is lost); otherwise replace a run that has not yet
 * shown anything (the reasoning in progress is lost, as with the reference app, but
 * the operator gets ONE reply); otherwise steer a run that has already shown
 * work (the model integrates it at the next tool boundary); otherwise the ordinary
 * FIFO queue. The same admissibility conditions as the steer: DM, text
 * only, no quote, no attachment, no handoff, under 64 KiB.
 *
 * The queries lock the chosen run: a worker `update runs` (lease,
 * claim) waits behind, and the claim in `skip locked` goes on its
 * way. The `queued` and `active` aliases are deliberate: the route tests
 * stub `select run.id from runs run` for the steering target.
 */
export async function followupDispositionTx(
  tx: Bun.TransactionSQL,
  input: {
    organizationId: string;
    threadId: string;
    botId: string;
    groupId: string | null;
    initiatorUserId: string;
    input: string;
    attachmentCount: number;
    replyToId: string | null;
    handoff: boolean;
    /** A plan-only turn never shares a run: it is always a run of its own. */
    planOnly?: boolean;
  },
): Promise<FollowupDisposition> {
  const plainText = input.attachmentCount === 0 && !input.replyToId && !input.handoff && !input.planOnly
    && input.input.length > 0 && input.input.length <= MAX_RUN_STEER_CHARS;
  if (input.groupId) {
    if (!plainText) return { kind: "fifo" };
    // A room is not steered. The second message joins the only room
    // run still queued: not one more workflow per keystroke.
    const queuedGroup = await tx<Array<{ id: string; workflowId: string | null; workflowAutonomyEnabled: boolean | null }>>`
      select queued.id, queued.workflow_id as "workflowId",
             workflow.autonomy_enabled as "workflowAutonomyEnabled"
        from runs queued
        join workflows workflow
          on workflow.organization_id = queued.organization_id and workflow.id = queued.workflow_id
       where queued.organization_id = ${input.organizationId}
         and queued.thread_id = ${input.threadId}
         and queued.status = 'queued' and queued.external_state = 'not_started'
         and queued.hermes_run_id is null and queued.lease_owner is null
         and queued.step_kind = 'group'
         and workflow.kind = 'group' and workflow.status = 'queued'
         and workflow.initiator_user_id = ${input.initiatorUserId}
         -- Nor does an ordinary message join a plan-only turn: it would run
         -- under plan, or merge the plan request into an executing turn.
         and not queued.plan_only and not workflow.plan_only
         -- Nor a room routine's run, whose initiator is the routine's author.
         and workflow.recovery_state->>'routineId' is null
       order by queued.created_at desc, queued.id desc
       limit 1 for update of queued
    `;
    if (queuedGroup[0]) {
      return {
        kind: "fold",
        runId: queuedGroup[0].id,
        workflowId: queuedGroup[0].workflowId,
        autonomyEnabled: queuedGroup[0].workflowAutonomyEnabled === true,
      };
    }
    return { kind: "fifo" };
  }
  if (!plainText) return { kind: "fifo" };
  // A folded run must be an operator turn, text only, with no steer in
  // flight (its attempt would carry an incomplete text) and never claimed. A plain
  // DM has no workflow: its run itself carries the initiator.
  const queued = await tx<Array<{ id: string; workflowId: string | null; workflowAutonomyEnabled: boolean | null }>>`
    select queued.id, queued.workflow_id as "workflowId",
           workflow.autonomy_enabled as "workflowAutonomyEnabled"
      from runs queued
      left join workflows workflow
        on workflow.organization_id = queued.organization_id and workflow.id = queued.workflow_id
     where queued.organization_id = ${input.organizationId}
       and queued.thread_id = ${input.threadId}
       and queued.bot_id = ${input.botId}
       and queued.status = 'queued' and queued.external_state = 'not_started'
       and queued.origin is distinct from 'bot_greeting'
       and queued.hermes_run_id is null and queued.lease_owner is null and queued.remote_stop_state is null
       and queued.step_kind = 'root' and queued.caller_bot_id is null and queued.origin_run_id is null
       and not queued.plan_only and not coalesce(workflow.plan_only, false)
       and (
         (queued.workflow_id is null and queued.initiator_user_id = ${input.initiatorUserId})
         or (workflow.status = 'queued' and workflow.kind = 'dm'
             and workflow.initiator_user_id = ${input.initiatorUserId}
             and workflow.recovery_state->>'routineId' is null)
       )
       and not exists (
         select 1 from run_steering_attempts steer
          where steer.organization_id = queued.organization_id and steer.source_run_id = queued.id
            and steer.status in ('pending', 'sending')
       )
       and not exists (
         select 1 from messages message
           left join attachments attachment
             on attachment.organization_id = message.organization_id and attachment.message_id = message.id
          where message.organization_id = queued.organization_id and message.run_id = queued.id
            and (attachment.id is not null or message.reply_to_id is not null)
       )
     order by queued.created_at desc, queued.id desc
     limit 1 for update of queued
  `;
  if (queued[0]) {
    return {
      kind: "fold",
      runId: queued[0].id,
      workflowId: queued[0].workflowId,
      autonomyEnabled: queued[0].workflowAutonomyEnabled === true,
    };
  }
  // A burst while a steer is already queued: THIS attempt is lengthened,
  // neither a run nor a workflow more is opened.
  const pending = await tx<Array<{
    id: string;
    workflowId: string | null;
    workflowAutonomyEnabled: boolean | null;
    attemptId: string;
    targetRunId: string;
  }>>`
    select followup.id, followup.workflow_id as "workflowId",
           workflow.autonomy_enabled as "workflowAutonomyEnabled",
           steer.id as "attemptId", target.id as "targetRunId"
      from runs followup
      join run_steering_attempts steer
        on steer.organization_id = followup.organization_id and steer.source_run_id = followup.id
      join runs target
        on target.organization_id = steer.organization_id and target.id = steer.target_run_id
      left join workflows workflow
        on workflow.organization_id = followup.organization_id and workflow.id = followup.workflow_id
     where followup.organization_id = ${input.organizationId}
       and followup.thread_id = ${input.threadId}
       and followup.bot_id = ${input.botId}
       and followup.status = 'queued' and followup.lease_owner is null
       and followup.hermes_run_id is null
       and steer.status = 'pending'
       and target.bot_id = ${input.botId}
       and target.status in ('starting', 'running', 'awaiting_approval')
       and target.origin is distinct from 'bot_greeting'
       and target.remote_stop_state is null
       and not target.plan_only
       and not exists (
         select 1 from workflows target_workflow
          where target_workflow.organization_id = target.organization_id
            and target_workflow.id = target.workflow_id and target_workflow.plan_only
       )
       and char_length(steer.text) + char_length(${input.input}) + 2 <= 65536
     order by steer.created_at asc, steer.id asc
     limit 1 for update of followup, steer
  `;
  if (pending[0]) {
    return {
      kind: "enqueue",
      runId: pending[0].id,
      workflowId: pending[0].workflowId,
      autonomyEnabled: pending[0].workflowAutonomyEnabled === true,
      attemptId: pending[0].attemptId,
      targetRunId: pending[0].targetRunId,
    };
  }
  // A "silent" run: it streams, but nothing has yet been shown or
  // committed. A text already written, a tool called or an approval requested
  // are effects one does not throw away: that run is steered. A routine's
  // run (`recovery_state.routineId`, as in the folds above) is never
  // replaced: it shares the bot's default thread, and a supersede would
  // cancel the occurrence and replay it as the person's own turn, without
  // the routine's receipt or its « Ne jamais attendre ».
  const quiet = await tx<Array<{ id: string }>>`
    select active.id from runs active
     where active.organization_id = ${input.organizationId}
       and active.thread_id = ${input.threadId}
       and active.bot_id = ${input.botId}
       and active.status = 'running' and active.external_state = 'streaming'
       and active.origin is distinct from 'bot_greeting'
       and active.hermes_run_id is not null and active.remote_stop_state is null
       and active.step_kind = 'root' and active.caller_bot_id is null and active.origin_run_id is null
       and not active.plan_only
       and not exists (
         select 1 from workflows active_workflow
          where active_workflow.organization_id = active.organization_id
            and active_workflow.id = active.workflow_id
            and (active_workflow.plan_only or active_workflow.recovery_state->>'routineId' is not null)
       )
       and not exists (
         select 1 from run_events event
          where event.organization_id = active.organization_id and event.run_id = active.id
            and event.type in ('agent.message', 'tool.call', 'approval.requested')
       )
       and not exists (
         select 1 from run_steering_attempts steer
          where steer.organization_id = active.organization_id and steer.target_run_id = active.id
            and steer.status in ('pending', 'sending', 'ambiguous')
       )
       and not exists (
         select 1 from messages message
           left join attachments attachment
             on attachment.organization_id = message.organization_id and attachment.message_id = message.id
          where message.organization_id = active.organization_id and message.run_id = active.id
            and (attachment.id is not null or message.reply_to_id is not null)
       )
     order by active.started_at asc nulls last, active.created_at asc, active.id asc
     limit 1 for update of active
  `;
  if (quiet[0]) {
    const steers = await tx<Array<{ text: string }>>`
      select text from run_steering_attempts
       where organization_id = ${input.organizationId} and target_run_id = ${quiet[0].id}
         and status = 'confirmed' and error_code is null
       order by created_at asc, id asc
    `;
    return {
      kind: "supersede",
      runId: quiet[0].id,
      texts: await runUserTextsTx(tx, input.organizationId, quiet[0].id),
      steerTexts: steers.map((row) => row.text),
    };
  }
  const target = await activeRunSteerTargetTx(tx, input);
  return target ? { kind: "steer", runId: target } : { kind: "fifo" };
}

/**
 * The texts of a run's operator messages, in order. That is what is
 * merged, never `runs.input`: the executed input already carries the
 * `[Workflow limits]` line the worker sets on every turn, and repeating it would
 * make the model read it twice.
 */
async function runUserTextsTx(tx: Bun.TransactionSQL, organizationId: string, runId: string): Promise<string[]> {
  const rows = await tx<Array<{ content: MessageContent | null }>>`
    select content from messages
     where organization_id = ${organizationId} and run_id = ${runId} and role = 'user'
     order by sequence asc, created_at asc
  `;
  return rows.map((row) => (Array.isArray(row.content) ? row.content : [])
    .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n"));
}

/** The text deposited in the origin thread when the inbound run is cancelled (cf. replyTextFor, on the worker side). */
export function cancelledHandoffReply(target: { name: string | null; slug: string | null }): string {
  return `La mission de 🤖 ${target.name ?? "bot supprimé"} (@${target.slug ?? "?"}) a été annulée.`;
}

/** The organization's other reachable bots, each with its DM thread. */
export async function handoffRosterTx(
  tx: Bun.TransactionSQL,
  organizationId: string,
  selfBotId: string,
): Promise<BotIdentity[]> {
  return tx<BotIdentity[]>`
    select b.id, b.name, b.slug, b.description, t.id as "threadId"
      from bots b
      join threads t on t.organization_id = b.organization_id and t.bot_id = b.id
        and t.is_default
     where b.organization_id = ${organizationId} and b.archived_at is null and b.id <> ${selfBotId}
  `;
}

/**
 * Delivers the "cancelled" outcome to the couriers whose inbound run has just been
 * cancelled: a message attributed to the target in the origin thread, courier
 * completed, `bot.message` + `run.completed` events: the same sequence as
 * the worker's delivery. A courier already terminal (cancelled by the operator)
 * receives nothing more. Connected clients receive these events through the
 * SSE replay (event-routes), like every event written to the database.
 */
export async function settleCancelledHandoffsTx(
  tx: Bun.TransactionSQL,
  organizationId: string,
  cancelled: readonly CancellationRun[],
): Promise<void> {
  for (const run of cancelled) {
    if (!run.originRunId) continue;
    const origins = await tx<Array<{ id: string; threadId: string; status: string }>>`
      select id, thread_id as "threadId", status from runs
       where organization_id = ${organizationId} and id = ${run.originRunId}
    `;
    const origin = origins[0];
    if (!origin || origin.status !== "relaying") continue;
    // Closed first, under its guard: the update locks the courier and moves
    // it only if it still relays (D6). A courier the worker delivered
    // meanwhile receives nothing more. Its status is set before its events:
    // a client that reads `run.completed` and reloads finds it closed.
    const closed = await transitionRuns(tx as unknown as SQL, {
      target: { organizationId, id: origin.id }, fence: "unleased",
      transition: { from: ["relaying"], to: { status: "completed" } }, set: { endedAt: NOW },
    });
    if (closed.length === 0) continue;
    // The target is reread even when archived: it stays named in the reply.
    const targets = await tx<Array<{ name: string; slug: string }>>`
      select name, slug from bots where organization_id = ${organizationId} and id = ${run.botId}
    `;
    const target = targets[0] ?? { name: null, slug: null };
    const text = cancelledHandoffReply(target);
    const messageId = crypto.randomUUID();
    await tx`
      insert into messages (id, organization_id, thread_id, run_id, role, content, author_bot_id)
      values (${messageId}, ${organizationId}, ${origin.threadId}, ${origin.id},
              -- role 'user' : entrée du fil d'origine, rendue BotInboundMessage côté client.
              'user', ${[{ type: "text", text }]}, ${run.botId})
    `;
    // The transition above holds the courier's row: the primitive takes the cursor after it.
    const occurredAt = new Date();
    await appendRunEventsTx(tx as unknown as SQL, [
      {
        organizationId, threadId: origin.threadId, runId: origin.id, occurredAt,
        type: "bot.message",
        payload: {
          messageId,
          fromBotId: run.botId,
          fromSlug: target.slug,
          fromName: target.name,
          text,
          ok: false,
        },
      },
      {
        organizationId, threadId: origin.threadId, runId: origin.id, occurredAt,
        type: "run.completed", payload: { output: null, usage: null },
      },
    ]);
    await tx`
      update threads set updated_at = now()
       where organization_id = ${organizationId} and id = ${origin.threadId}
    `;
  }
}
