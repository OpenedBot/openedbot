import type { SQL } from "bun";
import { insertRoutineInputMessage } from "@openedbot/conversation/application/messages";
import { touchThread } from "@openedbot/conversation/application/threads";
import { AUTONOMY_DEFAULTS, normalizeAutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { clearGroupNeedsYou } from "@openedbot/roster/application/groups";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import { coerceGroupDefaultResponder, planRoutineGroupSend } from "../domain/group-send";
import { fireRoutineTx } from "./run-creation";
import type { RoutineExecutionOutcome } from "@openedbot/contracts-api";
import { ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED, ROUTINE_ERROR_GROUP_EMPTY } from "@openedbot/contracts-errors";
import {
  ROUTINE_BUSY_RETRIES_EXHAUSTED_MESSAGE,
  ROUTINE_GROUP_EMPTY_MESSAGE,
  ROUTINE_LIMITS,
  countMissedOccurrences,
  nextOccurrence,
  routineFireText,
} from "../domain/routines";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";

/** The routine writes other packages call (ADR 0001 S4): a removed member's routines pause, an import inserts its routines disabled. */
export { insertDisabledRoutine, pauseMemberRoutines } from "../sql/routines";

/**
 * Le tick des routines : l'autre moitié du planificateur (`routine-routes.ts`
 * écrit l'horloge, ici on la lit).
 *
 * Un tir matérialise EXACTEMENT ce que ferait l'opérateur : une ligne
 * `messages` (role user) + un run `queued` dans le fil DM du bot, ou un
 * envoi de salon (`kind: 'group'`) via `planRoutineGroupSend`. La file
 * ordinaire exécute avec les mêmes gardes. Le tick ne parle jamais à Hermes.
 * Chaque issue (tir, rattrapage, report, abandon, salon vide) est écrite
 * dans `routine_executions`.
 *
 * Fil occupé : la routine réessaie dans 60 s au lieu de sauter l'occurrence,
 * l'index `runs_one_active_per_thread_idx` reste le seul arbitre. Passé
 * `ROUTINE_LIMITS.maxBusyRetries` reports consécutifs, on abandonne
 * l'occurrence (comptée dans `missed_count`) et on avance l'horloge.
 *
 * Catch-up : un réveil en retard tire UNE occurrence, calcule combien
 * d'occurrences intermédiaires sont perdues (plafond
 * `ROUTINE_LIMITS.maxMissedCounted`), et incrémente `missed_count`.
 */

type DueRoutine = {
  id: string;
  organizationId: string;
  botId: string | null;
  groupId: string | null;
  threadId: string;
  groupDefaultResponder: unknown;
  groupAnswerMode: string | null;
  name: string;
  schedule: string;
  timezone: string;
  message: string;
  createdByUserId: string | null;
  /** PERM2-9: snapshotted on the fired workflow. */
  neverWait: boolean;
  nextRunAt: Date | string;
  missedCount: number | string;
  busyRetries: number | string;
  autonomyEnabled: boolean | null;
  autonomyMaxDepth: number | null;
  autonomyMaxSteps: number | null;
  autonomyMaxHandoffs: number | null;
  autonomyTimeoutSeconds: number | null;
  autonomyTokenBudget: number | string | null;
};

type GroupMemberRow = {
  id: string;
  slug: string;
  position: number;
  autonomyEnabled: boolean;
  autonomyMaxDepth: number;
  autonomyMaxSteps: number;
  autonomyMaxHandoffs: number;
  autonomyTimeoutSeconds: number;
  autonomyTokenBudget: number | string;
};

type ExecutionInsert = {
  organizationId: string;
  routineId: string;
  outcome: RoutineExecutionOutcome;
  trigger: "scheduled" | "manual";
  missedCount?: number;
  busyRetries?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  threadId?: string | null;
};

const RETRY_SECONDS = 60;

/**
 * SSE replay is a delivery buffer, not an audit archive. Keep terminal-run
 * events for the configured window and never trim a live run; the API's
 * cursor replay remains monotonic inside that window.
 */
export async function purgeOldRunEvents(
  db: SQL,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  // A concrete cutoff avoids an ambiguous Date/interval parameter inference
  // in Bun SQL that made PostgreSQL evaluate `timestamptz < interval`.
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const rows = await db<Array<{ count: string | number }>>`
    with deleted as (
      delete from run_events e
       where e.created_at < ${cutoff}
         and exists (
           select 1 from runs r
            where r.organization_id = e.organization_id and r.id = e.run_id
              and r.status in ('completed','failed','cancelled')
         )
       returning e.cursor
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function fireDueRoutine(db: SQL, billingEnforced: boolean, now: Date = new Date()): Promise<boolean> {
  return db.begin(async (tx) => {
    const rows = await tx<DueRoutine[]>`
      select r.id, r.organization_id as "organizationId", r.bot_id as "botId", r.group_id as "groupId",
             t.id as "threadId", g.default_responder as "groupDefaultResponder",
             g.answer_mode as "groupAnswerMode",
             r.name, r.schedule, r.timezone, r.message,
             r.created_by_user_id as "createdByUserId", r.never_wait as "neverWait",
             r.next_run_at as "nextRunAt",
             r.missed_count as "missedCount",
             r.busy_retries as "busyRetries",
             b.autonomy_enabled as "autonomyEnabled",
             b.autonomy_max_depth as "autonomyMaxDepth", b.autonomy_max_steps as "autonomyMaxSteps",
             b.autonomy_max_handoffs as "autonomyMaxHandoffs",
             b.autonomy_timeout_seconds as "autonomyTimeoutSeconds",
             b.autonomy_token_budget as "autonomyTokenBudget"
        from routines r
        left join ${subscriptionPort().admission(tx)} s on s.organization_id = r.organization_id
        left join bots b on b.organization_id = r.organization_id and b.id = r.bot_id
          and b.archived_at is null
        left join bot_groups g on g.organization_id = r.organization_id and g.id = r.group_id
        join threads t on t.organization_id = r.organization_id
          and (
            (r.bot_id is not null and t.bot_id = r.bot_id and t.is_default)
            or (r.group_id is not null and t.group_id = r.group_id)
          )
       where r.enabled and r.next_run_at is not null and r.next_run_at <= now()
         and (r.bot_id is null or b.id is not null)
         and (r.group_id is null or g.id is not null)
         and (${!billingEnforced} or s.status in ('active','trialing'))
       order by r.next_run_at asc
       for update of r skip locked
       limit 1
    `;
    const routine = rows[0];
    if (!routine) return false;

    // Tous les producteurs interactifs verrouillent le thread avant de tester
    // l'index d'activité. Faire de même ici ferme la fenêtre où un message peut
    // passer entre le SELECT ci-dessous et l'INSERT du run de routine.
    await tx`
      select id from threads
       where organization_id = ${routine.organizationId} and id = ${routine.threadId}
       for update
    `;

    const busy = await tx<Array<{ id: string }>>`
      select id from runs
       where organization_id = ${routine.organizationId} and thread_id = ${routine.threadId}
         and status in ('queued','starting','running','awaiting_approval','relaying','unknown')
       limit 1
    `;
    if (busy[0]) {
      const busyRetries = Number(routine.busyRetries ?? 0);
      if (busyRetries >= ROUTINE_LIMITS.maxBusyRetries) {
        const dueAt = asInstant(routine.nextRunAt);
        const missed = Math.max(1, countMissedOccurrences(
          routine.schedule, dueAt, now, routine.timezone,
        ));
        console.warn(JSON.stringify({
          event: "worker.routine_busy_retries_exhausted",
          errorCode: ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED,
          routineId: routine.id,
          organizationId: routine.organizationId,
          threadId: routine.threadId,
          busyRetries,
        }));
        await recordRoutineExecution(tx, {
          organizationId: routine.organizationId,
          routineId: routine.id,
          outcome: "abandoned",
          trigger: "scheduled",
          missedCount: missed,
          busyRetries,
          errorCode: ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED,
          errorMessage: ROUTINE_BUSY_RETRIES_EXHAUSTED_MESSAGE,
          threadId: routine.threadId,
        });
        await tx`
          update routines set
            next_run_at = ${nextOccurrence(routine.schedule, now, routine.timezone)},
            busy_retries = 0,
            missed_count = missed_count + ${missed},
            last_missed_at = ${now},
            updated_at = now()
           where organization_id = ${routine.organizationId} and id = ${routine.id}
        `;
        return true;
      }
      await recordRoutineExecution(tx, {
        organizationId: routine.organizationId,
        routineId: routine.id,
        outcome: "deferred",
        trigger: "scheduled",
        busyRetries: busyRetries + 1,
        threadId: routine.threadId,
      });
      await tx`
        update routines set
          next_run_at = now() + (${RETRY_SECONDS} * interval '1 second'),
          busy_retries = ${busyRetries + 1},
          updated_at = now()
         where organization_id = ${routine.organizationId} and id = ${routine.id}
      `;
      return true;
    }

    const text = routineFireText(routine.name, routine.message);
    const fired = routine.groupId
      ? await fireGroupOccurrence(tx, routine, text)
      : await fireDirectOccurrence(tx, routine, text);
    if (fired.kind === "group_empty") {
      const dueAt = asInstant(routine.nextRunAt);
      const missed = Math.max(1, countMissedOccurrences(
        routine.schedule, dueAt, now, routine.timezone,
      ));
      await recordRoutineExecution(tx, {
        organizationId: routine.organizationId,
        routineId: routine.id,
        outcome: "group_empty",
        trigger: "scheduled",
        missedCount: missed,
        errorCode: ROUTINE_ERROR_GROUP_EMPTY,
        errorMessage: ROUTINE_GROUP_EMPTY_MESSAGE,
        threadId: routine.threadId,
      });
      await tx`
        update routines set
          next_run_at = ${nextOccurrence(routine.schedule, now, routine.timezone)},
          busy_retries = 0,
          missed_count = missed_count + ${missed},
          last_missed_at = ${now},
          updated_at = now()
         where organization_id = ${routine.organizationId} and id = ${routine.id}
      `;
      return true;
    }

    const dueAt = asInstant(routine.nextRunAt);
    const missed = countMissedOccurrences(routine.schedule, dueAt, now, routine.timezone);
    await recordRoutineExecution(tx, {
      organizationId: routine.organizationId,
      routineId: routine.id,
      outcome: missed > 0 ? "catch_up" : "fired",
      trigger: "scheduled",
      missedCount: missed,
      workflowId: fired.workflowId,
      runId: fired.runId,
      threadId: routine.threadId,
    });
    await tx`
      update routines set last_run_at = now(),
        next_run_at = ${nextOccurrence(routine.schedule, now, routine.timezone)},
        missed_count = missed_count + ${missed},
        last_missed_at = coalesce(${missed > 0 ? now : null}, last_missed_at),
        busy_retries = 0,
        updated_at = now()
       where organization_id = ${routine.organizationId} and id = ${routine.id}
    `;
    return true;
  }) as Promise<boolean>;
}

async function fireDirectOccurrence(
  tx: SQL,
  routine: DueRoutine,
  text: string,
): Promise<{ kind: "fired"; workflowId: string; runId: string }> {
  // routines_bot_xor_group: a routine without a room has its bot.
  if (!routine.botId) throw new Error(`routine ${routine.id} has neither a bot nor a room`);
  const runId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  // The bot's policy as the routine read it, defaults filled, not normalized.
  await fireRoutineTx(tx, {
    trigger: "scheduled",
    routineId: routine.id,
    organizationId: routine.organizationId,
    threadId: routine.threadId,
    runId,
    workflowId,
    initiatorUserId: routine.createdByUserId,
    input: text,
    speaker: { kind: "root", botId: routine.botId },
    budget: {
      enabled: routine.autonomyEnabled ?? AUTONOMY_DEFAULTS.enabled,
      maxDepth: routine.autonomyMaxDepth ?? AUTONOMY_DEFAULTS.maxDepth,
      maxSteps: routine.autonomyMaxSteps ?? AUTONOMY_DEFAULTS.maxSteps,
      maxHandoffs: routine.autonomyMaxHandoffs ?? AUTONOMY_DEFAULTS.maxHandoffs,
      timeoutSeconds: routine.autonomyTimeoutSeconds ?? AUTONOMY_DEFAULTS.timeoutSeconds,
      tokenBudget: Number(routine.autonomyTokenBudget ?? AUTONOMY_DEFAULTS.tokenBudget),
    },
    neverWait: routine.neverWait === true,
  });
  await insertRoutineInputMessage(tx, {
    organizationId: routine.organizationId,
    threadId: routine.threadId,
    runId,
    text,
  });
  await touchThread(tx, routine.organizationId, routine.threadId);
  return { kind: "fired", workflowId, runId };
}

async function fireGroupOccurrence(
  tx: SQL,
  routine: DueRoutine,
  text: string,
): Promise<{ kind: "fired"; workflowId: string; runId: string } | { kind: "group_empty" }> {
  const members = await tx<GroupMemberRow[]>`
    select b.id, b.slug, gm.position,
           b.autonomy_enabled as "autonomyEnabled",
           b.autonomy_max_depth as "autonomyMaxDepth",
           b.autonomy_max_steps as "autonomyMaxSteps",
           b.autonomy_max_handoffs as "autonomyMaxHandoffs",
           b.autonomy_timeout_seconds as "autonomyTimeoutSeconds",
           b.autonomy_token_budget as "autonomyTokenBudget"
      from group_members gm
      join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
        and b.archived_at is null
     where gm.organization_id = ${routine.organizationId} and gm.group_id = ${routine.groupId}
     order by gm.position asc
  `;
  const planned = planRoutineGroupSend(
    text,
    members,
    coerceGroupDefaultResponder(routine.groupDefaultResponder, members.map((member) => member.id)),
    undefined,
    null,
    routine.groupAnswerMode === "team",
  );
  if (planned.kind === "empty") return { kind: "group_empty" };

  const speaker = members.find((member) => member.id === planned.botId);
  if (!speaker) return { kind: "group_empty" };
  const policy = normalizeAutonomyPolicy({
    enabled: speaker.autonomyEnabled ?? AUTONOMY_DEFAULTS.enabled,
    maxDepth: speaker.autonomyMaxDepth ?? AUTONOMY_DEFAULTS.maxDepth,
    maxSteps: speaker.autonomyMaxSteps ?? AUTONOMY_DEFAULTS.maxSteps,
    maxHandoffs: speaker.autonomyMaxHandoffs ?? AUTONOMY_DEFAULTS.maxHandoffs,
    timeoutSeconds: speaker.autonomyTimeoutSeconds ?? AUTONOMY_DEFAULTS.timeoutSeconds,
    tokenBudget: Number(speaker.autonomyTokenBudget ?? AUTONOMY_DEFAULTS.tokenBudget),
  });
  const runId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  await fireRoutineTx(tx, {
    trigger: "scheduled",
    routineId: routine.id,
    organizationId: routine.organizationId,
    threadId: routine.threadId,
    runId,
    workflowId,
    initiatorUserId: routine.createdByUserId,
    input: text,
    speaker: { kind: "group", botId: speaker.id, position: planned.position, state: planned.state },
    budget: { ...policy, maxSteps: ROOM_LIMITS.maxMemberTurns },
    neverWait: routine.neverWait === true,
  });
  await insertRoutineInputMessage(tx, {
    organizationId: routine.organizationId,
    threadId: routine.threadId,
    runId,
    text,
  });
  await clearGroupNeedsYou(tx, routine.organizationId, routine.groupId);
  await touchThread(tx, routine.organizationId, routine.threadId);
  return { kind: "fired", workflowId, runId };
}

async function recordRoutineExecution(tx: SQL, input: ExecutionInsert): Promise<void> {
  await tx`
    insert into routine_executions (
      organization_id, routine_id, outcome, trigger, missed_count, busy_retries,
      error_code, error_message, workflow_id, run_id, thread_id
    ) values (
      ${input.organizationId}, ${input.routineId}, ${input.outcome}, ${input.trigger},
      ${input.missedCount ?? 0}, ${input.busyRetries ?? null},
      ${input.errorCode ?? null}, ${input.errorMessage ?? null},
      ${input.workflowId ?? null}, ${input.runId ?? null}, ${input.threadId ?? null}
    )
  `;
}

function asInstant(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
