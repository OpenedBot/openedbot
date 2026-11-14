import type { SQL } from "bun";
import type { TransactionDb } from "@openedbot/platform-db";
import { insertRoutineInputMessage } from "@openedbot/conversation/application/messages";
import { touchThread } from "@openedbot/conversation/application/threads";
import { AUTONOMY_DEFAULTS, normalizeAutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { clearGroupNeedsYou } from "@openedbot/roster/application/groups";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import { coerceGroupDefaultResponder, planRoutineGroupSend } from "../domain/group-send";
import { fireRoutineTx } from "./run-creation";
import type { RoutineExecutionOutcome } from "@openedbot/contracts-api";
import {
  ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED,
  ROUTINE_ERROR_FIRE_FAILED,
  ROUTINE_ERROR_GROUP_EMPTY,
} from "@openedbot/contracts-errors";
import {
  ROUTINE_BUSY_RETRIES_EXHAUSTED_MESSAGE,
  ROUTINE_FIRE_FAILED_ABANDONED_MESSAGE,
  ROUTINE_FIRE_FAILED_MESSAGE,
  ROUTINE_GROUP_EMPTY_MESSAGE,
  ROUTINE_ONE_SHOT_BUSY_RETRIES_EXHAUSTED_MESSAGE,
  ROUTINE_LIMITS,
  countMissedOccurrences,
  nextOccurrence,
  oneShotTime,
  routineFireText,
} from "../domain/routines";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";
import { disconnectedHostOrganizations } from "@openedbot/runtimes/application/link-vitality";

/** The routine writes other packages call: a removed member's routines pause, an import inserts its routines disabled. */
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
 * l'occurrence (comptée dans `missed_count`) et on avance l'horloge. Un
 * rappel ponctuel, sans occurrence suivante, continue de se reporter plus
 * lentement jusqu'à `maxOneShotBusyRetries` (environ une journée).
 *
 * Hôte hors ligne (runtime connector `disconnected`) : la routine n'est pas
 * réclamée, ne laisse aucune ligne d'historique, et tire au retour du lien,
 * en catch-up. Un tir qui lève est reporté comme un fil occupé.
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

export type RoutineListRow = {
  id: string;
  botId: string | null;
  groupId: string | null;
  name: string;
  schedule: string;
  timezone: string;
  message: string;
  enabled: boolean;
  nextRunAt: Date | string | null;
  lastRunAt: Date | string | null;
  missedCount: number | string;
  lastMissedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  neverWait: boolean;
  /** Due, but held by the tick because the organization's connector is unreachable; it fires on return. */
  waitingForHost: boolean;
};

/**
 * A bot's or a room's routines, oldest first, as the API lists them.
 * `botArchived`: the routines are held for that reason, not for the host.
 */
export async function readRoutines(
  tx: TransactionDb,
  organizationId: string,
  target: { botId: string; groupId: null; botArchived: boolean } | { botId: null; groupId: string; botArchived: false },
): Promise<RoutineListRow[]> {
  return tx<RoutineListRow[]>`
    select r.id, r.bot_id as "botId", r.group_id as "groupId", r.name, r.schedule, r.timezone, r.message, r.enabled,
           r.next_run_at as "nextRunAt", r.last_run_at as "lastRunAt",
           r.missed_count as "missedCount", r.last_missed_at as "lastMissedAt",
           r.created_at as "createdAt", r.updated_at as "updatedAt", r.never_wait as "neverWait",
           coalesce(r.enabled and r.next_run_at <= now() and offline.organization_id is not null
             and not ${target.botArchived}::boolean, false) as "waitingForHost"
      from routines r
      left join ${disconnectedHostOrganizations(tx)} offline on offline.organization_id = r.organization_id
     where r.organization_id = ${organizationId} and (r.bot_id = ${target.botId} or r.group_id = ${target.groupId})
     order by r.created_at asc
  `;
}

export async function fireDueRoutine(db: SQL, billingEnforced: boolean, now: Date = new Date()): Promise<boolean> {
  return db.begin(async (tx) => {
    // PostgreSQL's clock, shared by every worker and the API, decides what is
    // due and when a deferral comes back; `now` only computes the next
    // occurrence and the missed count, anchored so it never re-arms the
    // occurrence just handled (`followingOccurrence`).
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
        left join ${disconnectedHostOrganizations(tx)} offline on offline.organization_id = r.organization_id
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
         -- Host unreachable: the routine stays due, unclaimed and without
         -- history, and fires once (catch-up) when the link is back. Skipped
         -- here, it never holds the head of the queue.
         and offline.organization_id is null
       order by r.next_run_at asc
       for update of r skip locked
       limit 1
    `;
    const routine = rows[0];
    if (!routine) return false;

    // A throw past the claim must not roll the claim back: the same routine
    // would head the queue again on the next tick, forever. The savepoint
    // undoes the partial fire; the routine, still locked, is deferred.
    await tx`savepoint routine_fire`;
    try {
      await handleDueRoutine(tx, routine, now);
      await tx`release savepoint routine_fire`;
    } catch (error) {
      // Logged first: if the connection is gone, the rollback throws too.
      console.error(JSON.stringify({
        event: "worker.routine_fire_failed",
        errorCode: ROUTINE_ERROR_FIRE_FAILED,
        routineId: routine.id,
        organizationId: routine.organizationId,
        threadId: routine.threadId,
        error: String(error),
      }));
      await tx`rollback to savepoint routine_fire`;
      await deferFailedRoutine(tx, routine, now);
    }
    return true;
  }) as Promise<boolean>;
}

async function handleDueRoutine(tx: SQL, routine: DueRoutine, now: Date): Promise<void> {
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
    const oneShot = oneShotTime(routine.schedule) !== null;
    if (busyRetries >= (oneShot ? ROUTINE_LIMITS.maxOneShotBusyRetries : ROUTINE_LIMITS.maxBusyRetries)) {
      console.warn(JSON.stringify({
        event: "worker.routine_busy_retries_exhausted",
        errorCode: ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED,
        routineId: routine.id,
        organizationId: routine.organizationId,
        threadId: routine.threadId,
        busyRetries,
      }));
      await abandonOccurrence(tx, routine, now, {
        busyRetries,
        errorCode: ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED,
        errorMessage: oneShot ? ROUTINE_ONE_SHOT_BUSY_RETRIES_EXHAUSTED_MESSAGE : ROUTINE_BUSY_RETRIES_EXHAUSTED_MESSAGE,
      });
      return;
    }
    await deferOccurrence(tx, routine, {
      busyRetries: busyRetries + 1,
      history: busyRetries + 1,
      retrySeconds: oneShot && busyRetries >= ROUTINE_LIMITS.maxBusyRetries
        ? ROUTINE_LIMITS.oneShotSlowRetrySeconds
        : RETRY_SECONDS,
    });
    return;
  }

  const text = routineFireText(routine.name, routine.message);
  const fired = routine.groupId
    ? await fireGroupOccurrence(tx, routine, text)
    : await fireDirectOccurrence(tx, routine, text);
  if (fired.kind === "group_empty") {
    const missed = Math.max(1, countMissedOccurrences(
      routine.schedule, asInstant(routine.nextRunAt), now, routine.timezone,
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
        next_run_at = ${followingOccurrence(routine, now)},
        enabled = ${oneShotTime(routine.schedule) === null},
        busy_retries = 0,
        missed_count = missed_count + ${missed},
        last_missed_at = now(),
        updated_at = now()
       where organization_id = ${routine.organizationId} and id = ${routine.id}
    `;
    return;
  }

  const missed = countMissedOccurrences(routine.schedule, asInstant(routine.nextRunAt), now, routine.timezone);
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
      next_run_at = ${followingOccurrence(routine, now)},
      enabled = ${oneShotTime(routine.schedule) === null},
      missed_count = missed_count + ${missed},
      last_missed_at = case when ${missed > 0} then now() else last_missed_at end,
      busy_retries = 0,
      updated_at = now()
     where organization_id = ${routine.organizationId} and id = ${routine.id}
  `;
}

/**
 * A fire that threw is retried in 60 s, then abandoned after
 * `maxFireFailures` consecutive failures: a routine that always throws costs
 * one attempt a minute for ten minutes, never a hot loop at the queue's head.
 * The failures are counted on their own, from the trailing history rows
 * (`routine_executions_routine_idx`), never on the busy-thread counter: a
 * reminder that waited for a busy thread is not lost to one transient throw.
 */
async function deferFailedRoutine(tx: SQL, routine: DueRoutine, now: Date): Promise<void> {
  const recent = await tx<Array<{ outcome: string; errorCode: string | null }>>`
    select outcome, error_code as "errorCode" from routine_executions
     where organization_id = ${routine.organizationId} and routine_id = ${routine.id}
     order by created_at desc, id desc
     limit ${ROUTINE_LIMITS.maxFireFailures - 1}
  `;
  let failures = 1;
  for (const row of recent) {
    if (row.outcome !== "deferred" || row.errorCode !== ROUTINE_ERROR_FIRE_FAILED) break;
    failures += 1;
  }
  if (failures >= ROUTINE_LIMITS.maxFireFailures) {
    console.warn(JSON.stringify({
      event: "worker.routine_fire_failures_exhausted",
      errorCode: ROUTINE_ERROR_FIRE_FAILED,
      routineId: routine.id,
      organizationId: routine.organizationId,
      failures,
    }));
    await abandonOccurrence(tx, routine, now, {
      busyRetries: null,
      errorCode: ROUTINE_ERROR_FIRE_FAILED,
      errorMessage: ROUTINE_FIRE_FAILED_ABANDONED_MESSAGE,
    });
    return;
  }
  await deferOccurrence(tx, routine, {
    busyRetries: Number(routine.busyRetries ?? 0),
    history: null,
    retrySeconds: RETRY_SECONDS,
    errorCode: ROUTINE_ERROR_FIRE_FAILED,
    errorMessage: ROUTINE_FIRE_FAILED_MESSAGE,
  });
}

/** `busyRetries`: the counter kept on the routine; `history`: what the row shows. */
async function deferOccurrence(
  tx: SQL,
  routine: DueRoutine,
  input: { busyRetries: number; history: number | null; retrySeconds: number; errorCode?: string; errorMessage?: string },
): Promise<void> {
  await recordRoutineExecution(tx, {
    organizationId: routine.organizationId,
    routineId: routine.id,
    outcome: "deferred",
    trigger: "scheduled",
    busyRetries: input.history,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    threadId: routine.threadId,
  });
  await tx`
    update routines set
      next_run_at = now() + (${input.retrySeconds} * interval '1 second'),
      busy_retries = ${input.busyRetries},
      updated_at = now()
     where organization_id = ${routine.organizationId} and id = ${routine.id}
  `;
}

/** The occurrence is lost (counted in `missed_count`); a one-shot ends disabled. */
async function abandonOccurrence(
  tx: SQL,
  routine: DueRoutine,
  now: Date,
  input: { busyRetries: number | null; errorCode: string; errorMessage: string },
): Promise<void> {
  const missed = Math.max(1, countMissedOccurrences(
    routine.schedule, asInstant(routine.nextRunAt), now, routine.timezone,
  ));
  await recordRoutineExecution(tx, {
    organizationId: routine.organizationId,
    routineId: routine.id,
    outcome: "abandoned",
    trigger: "scheduled",
    missedCount: missed,
    busyRetries: input.busyRetries,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    threadId: routine.threadId,
  });
  await tx`
    update routines set
      next_run_at = ${followingOccurrence(routine, now)},
      enabled = ${oneShotTime(routine.schedule) === null},
      busy_retries = 0,
      missed_count = missed_count + ${missed},
      last_missed_at = now(),
      updated_at = now()
     where organization_id = ${routine.organizationId} and id = ${routine.id}
  `;
}

/**
 * The occurrence after the one just handled, strictly after it: PostgreSQL
 * said it was due, while the worker's `now` may still sit a hair before it.
 */
function followingOccurrence(routine: DueRoutine, now: Date): Date | null {
  const dueAt = asInstant(routine.nextRunAt);
  return nextOccurrence(routine.schedule, dueAt.getTime() > now.getTime() ? dueAt : now, routine.timezone);
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
