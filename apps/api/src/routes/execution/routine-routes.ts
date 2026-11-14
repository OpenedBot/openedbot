import { UUID_LOOSE_RE, isUuid, isoOrNull } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { RoutineExecutionOutcome } from "@openedbot/contracts-api";
import { ROUTINE_LIMITS, nextOccurrence, routineFireText } from "@openedbot/execution/domain/routines";
import { AUTONOMY_DEFAULTS, normalizeAutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import { coerceGroupDefaultResponder, planRoutineGroupSend, type GroupSendState } from "@openedbot/execution/domain/group-send";
import { workflowNotificationEligible } from "@openedbot/notifications/domain/workflow-notifications";
import { fireRoutineTx } from "@openedbot/execution/application/run-creation";
import type { AppVariables, AuthContext } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { isUniqueViolation } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { WorkflowStatus } from "@openedbot/contracts-api";
import type {
  RoutineExecutionDto,
  RoutineExecutionReceiptDto,
  RoutineRunAcceptedDto,
} from "@openedbot/contracts-api";
import { assertEntitled } from "@openedbot/identity/domain/entitlement";
import { readIdempotencyKey } from "@openedbot/conversation/application/message-ingress";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";
import { readRoutines } from "@openedbot/execution/application/routines";
import { disconnectedHostOrganizations } from "@openedbot/runtimes/application/link-vitality";
import { editedClock, validatedRoutineInput } from "./routine-input";

export { validatedRoutineInput };

const ROUTINE_ADMIN_MESSAGE = "Les routines sont réservées aux administrateurs de l’organisation.";
const ROUTINE_HOST_OFFLINE_MESSAGE = "L’hôte de ce bot est hors ligne : relancez la routine une fois qu’il est reconnecté.";

function requireRoutineAdmin(auth: AuthContext): void {
  requireOperator(auth, ROUTINE_ADMIN_MESSAGE);
}

type RoutineRow = {
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
  /** PERM2-9: a human gate of its runs is refused at once. */
  neverWait: boolean;
  /** Read by the lists only: a routine POST or PATCH just wrote is not due yet. */
  waitingForHost?: boolean;
};

type RoutineExecutionRow = {
  id: string;
  routineId: string;
  outcome: RoutineExecutionOutcome;
  trigger: string;
  missedCount: number | string;
  busyRetries: number | string | null;
  errorCode: string | null;
  errorMessage: string | null;
  workflowId: string | null;
  runId: string | null;
  threadId: string | null;
  workflowStatus: WorkflowStatus | null;
  createdAt: Date | string;
};

type RoutineReceiptRow = {
  routineId: string;
  workflowId: string;
  runId: string;
  threadId: string;
  botId: string | null;
  status: WorkflowStatus;
  trigger: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  endedAt: Date | string | null;
};

type RunnableRoutineRow = {
  id: string;
  botId: string | null;
  groupId: string | null;
  threadId: string;
  groupDefaultResponder: unknown;
  groupAnswerMode: string | null;
  name: string;
  message: string;
  autonomyEnabled: boolean | null;
  autonomyMaxDepth: number | null;
  autonomyMaxSteps: number | null;
  autonomyMaxHandoffs: number | null;
  autonomyTimeoutSeconds: number | null;
  autonomyTokenBudget: string | number | null;
  neverWait: boolean;
  hostOffline: boolean;
};

type RoutineRunIngressRow = {
  id: string;
  requestHash: string;
  state: "reserved" | "completed" | "abandoned";
  messageId: string;
  runId: string;
  workflowId: string;
  responseStatus: number | null;
  responseBody: unknown;
};

const ROUTINE_RECEIPT_STATUSES: readonly WorkflowStatus[] = [
  "queued",
  "running",
  "awaiting_approval",
  "reconciling",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "unknown",
];
const ROUTINE_RECEIPT_LIMIT_DEFAULT = 25;
const ROUTINE_RECEIPT_LIMIT_MAX = 100;

/**
 * A bot's routines: Hermes Bot Mode's « Routines pane », carried by our
 * scheduler (`routines` table + the worker's tick), not by the
 * runtime's cron: openedbot does not administer Hermes, and the firings must
 * land in OUR threads.
 */
export function botRoutineRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:botId/routines", async (context) => {
    const auth = context.get("auth");
    const botId = context.req.param("botId");
    const routines = await withTenant(db, auth.organizationId, async (tx) => {
      const bot = await assertBot(tx, auth.organizationId, botId);
      return readRoutines(tx, auth.organizationId, { botId, groupId: null, botArchived: bot.archived });
    });
    return context.json({ routines: routines.map(publicRoutine) });
  });

  routes.post("/:botId/routines", async (context) => {
    const auth = context.get("auth");
    requireRoutineAdmin(auth);
    const botId = context.req.param("botId");
    const body = await jsonBody(context.req.raw);
    const input = validatedRoutineInput(body);
    const routine = await withTenant(db, auth.organizationId, async (tx) => {
      await assertBot(tx, auth.organizationId, botId);
      // count + insert must be serialized: two concurrent requests at the
      // last slot can no longer both pass the quota.
      await lockRoutineQuota(tx, auth.organizationId, botId);
      const countRows = await tx<Array<{ count: string | number }>>`
        select count(*) as count from routines
         where organization_id = ${auth.organizationId} and bot_id = ${botId}
      `;
      if (Number(countRows[0]?.count ?? 0) >= ROUTINE_LIMITS.maxPerBot) {
        throw new HttpError(409, "ROUTINE_QUOTA_REACHED", `Un bot ne porte pas plus de ${ROUTINE_LIMITS.maxPerBot} routines.`);
      }
      const rows = await tx<RoutineRow[]>`
        insert into routines (
          id, organization_id, bot_id, group_id, created_by_user_id,
          name, schedule, timezone, message, enabled, next_run_at, never_wait
        )
        values (
          ${crypto.randomUUID()}, ${auth.organizationId}, ${botId}, ${null}, ${auth.userId}, ${input.name}, ${input.schedule},
          ${input.timezone}, ${input.message}, ${input.enabled},
          ${input.enabled ? nextOccurrence(input.schedule, new Date(), input.timezone) : null}, ${input.neverWait}
        )
        returning id, bot_id as "botId", group_id as "groupId", name, schedule, timezone, message, enabled,
                  next_run_at as "nextRunAt", last_run_at as "lastRunAt",
                  missed_count as "missedCount", last_missed_at as "lastMissedAt",
                  created_at as "createdAt", updated_at as "updatedAt", never_wait as "neverWait"
      `;
      return rows[0]!;
    });
    return context.json(publicRoutine(routine), 201);
  });

  return routes;
}

/** A room's routines: the same CRUD as the bot, target `group_id`. */
export function groupRoutineRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:groupId/routines", async (context) => {
    const auth = context.get("auth");
    const groupId = context.req.param("groupId");
    const routines = await withTenant(db, auth.organizationId, async (tx) => {
      await assertGroup(tx, auth.organizationId, groupId);
      return readRoutines(tx, auth.organizationId, { botId: null, groupId, botArchived: false });
    });
    return context.json({ routines: routines.map(publicRoutine) });
  });

  routes.post("/:groupId/routines", async (context) => {
    const auth = context.get("auth");
    requireRoutineAdmin(auth);
    const groupId = context.req.param("groupId");
    const body = await jsonBody(context.req.raw);
    const input = validatedRoutineInput(body);
    const routine = await withTenant(db, auth.organizationId, async (tx) => {
      await assertGroup(tx, auth.organizationId, groupId);
      await lockRoutineQuota(tx, auth.organizationId, groupId);
      const countRows = await tx<Array<{ count: string | number }>>`
        select count(*) as count from routines
         where organization_id = ${auth.organizationId} and group_id = ${groupId}
      `;
      if (Number(countRows[0]?.count ?? 0) >= ROUTINE_LIMITS.maxPerGroup) {
        throw new HttpError(409, "ROUTINE_QUOTA_REACHED", `Un salon ne porte pas plus de ${ROUTINE_LIMITS.maxPerGroup} routines.`);
      }
      const rows = await tx<RoutineRow[]>`
        insert into routines (
          id, organization_id, bot_id, group_id, created_by_user_id,
          name, schedule, timezone, message, enabled, next_run_at, never_wait
        )
        values (
          ${crypto.randomUUID()}, ${auth.organizationId}, ${null}, ${groupId}, ${auth.userId}, ${input.name}, ${input.schedule},
          ${input.timezone}, ${input.message}, ${input.enabled},
          ${input.enabled ? nextOccurrence(input.schedule, new Date(), input.timezone) : null}, ${input.neverWait}
        )
        returning id, bot_id as "botId", group_id as "groupId", name, schedule, timezone, message, enabled,
                  next_run_at as "nextRunAt", last_run_at as "lastRunAt",
                  missed_count as "missedCount", last_missed_at as "lastMissedAt",
                  created_at as "createdAt", updated_at as "updatedAt", never_wait as "neverWait"
      `;
      return rows[0]!;
    });
    return context.json(publicRoutine(routine), 201);
  });

  return routes;
}

/** PostgreSQL transactional lock, split by tenant and target (bot or room). `hashtext` can
 * at worst serialize two distinct targets on a collision; it can never
 * let the quota be exceeded. The `withTenant` transaction releases it at commit
 * or rollback. */
export async function lockRoutineQuota(
  tx: Bun.TransactionSQL,
  organizationId: string,
  targetId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${targetId}))`;
}

export function routineRoutes(db: Db, billingEnforced: boolean): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Receipts of routine firings. The routine → workflow link is frozen by the
   * worker in `workflows.recovery_state.routineId`. For firings from before
   * that marker, the association is admitted only if ONE current routine of the
   * same bot reproduces the root input exactly; zero or several candidates
   * are omitted rather than attributed at random.
   */
  routes.get("/receipts", async (context) => {
    const auth = context.get("auth");
    const url = new URL(context.req.url);
    const routineId = readRoutineReceiptRoutineId(url.searchParams.get("routineId"));
    const status = readRoutineReceiptStatus(url.searchParams.get("status"));
    const limit = readRoutineReceiptLimit(url.searchParams.get("limit"));
    const cursor = readRoutineReceiptCursor(url.searchParams.get("cursor"));

    const rows = await withTenant(db, auth.organizationId, (tx) => tx<RoutineReceiptRow[]>`
      with linked as (
        select case
                 when (w.recovery_state->>'routineId') ~* ${UUID_LOOSE_RE.source}
                   then w.recovery_state->>'routineId'
                 else inferred.id
               end as "routineId",
               w.id as "workflowId", w.root_run_id as "runId",
               w.thread_id as "threadId", w.root_bot_id as "botId", w.status,
               w.recovery_state->>'trigger' as "trigger",
               w.error_code as "errorCode", w.error_message as "errorMessage",
               w.created_at as "createdAt", w.started_at as "startedAt", w.ended_at as "endedAt"
          from workflows w
          left join runs root
            on root.organization_id = w.organization_id and root.id = w.root_run_id
          left join lateral (
            select min(r.id::text) as id
              from routines r
             where r.organization_id = w.organization_id and r.bot_id = w.root_bot_id
               and root.input = concat('[Routine « ', r.name, ' »] ', r.message)
            having count(*) = 1
          ) inferred on true
         where w.organization_id = ${auth.organizationId} and w.kind = 'routine'
      )
      select * from linked
       where "routineId" is not null
         and (${routineId === null} or "routineId" = ${routineId})
         and (${status === null} or status = ${status})
         and (${cursor === null} or
              ("createdAt", "workflowId") < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
       order by "createdAt" desc, "workflowId" desc
       limit ${limit + 1}
    `);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return context.json({
      receipts: page.map(routineReceiptDto),
      nextCursor: rows.length > limit && last ? `${isoOrNull(last.createdAt)}|${last.workflowId}` : null,
    });
  });

  routes.get("/:routineId/executions", async (context) => {
    const auth = context.get("auth");
    const routineId = readRoutineRunRoutineId(context.req.param("routineId"));
    const url = new URL(context.req.url);
    const limit = readRoutineReceiptLimit(url.searchParams.get("limit"));
    const cursor = readRoutineReceiptCursor(url.searchParams.get("cursor"));

    const result = await withTenant(db, auth.organizationId, async (tx) => {
      const found = await tx<Array<{ id: string }>>`
        select id from routines
         where organization_id = ${auth.organizationId} and id = ${routineId}
      `;
      if (!found[0]) throw new HttpError(404, "ROUTINE_NOT_FOUND", "Routine introuvable.");
      return tx<RoutineExecutionRow[]>`
        select e.id, e.routine_id as "routineId", e.outcome, e.trigger,
               e.missed_count as "missedCount", e.busy_retries as "busyRetries",
               e.error_code as "errorCode", e.error_message as "errorMessage",
               e.workflow_id as "workflowId", e.run_id as "runId", e.thread_id as "threadId",
               w.status as "workflowStatus", e.created_at as "createdAt"
          from routine_executions e
          left join workflows w
            on w.organization_id = e.organization_id and w.id = e.workflow_id
         where e.organization_id = ${auth.organizationId} and e.routine_id = ${routineId}
           and (${cursor === null} or
                (e.created_at, e.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
         order by e.created_at desc, e.id desc
         limit ${limit + 1}
      `;
    });

    const page = result.slice(0, limit);
    const last = page[page.length - 1];
    return context.json({
      executions: page.map(routineExecutionDto),
      nextCursor: result.length > limit && last ? `${isoOrNull(last.createdAt)}|${last.id}` : null,
    });
  });

  /**
   * Launches a one-off occurrence without touching the cron clock. The
   * workflow, the run, the visible message and the idempotence receipt are written
   * in ONE transaction: the HTTP response can be lost, never the receipt.
   */
  routes.post("/:routineId/runs", async (context) => {
    const auth = context.get("auth");
    requireRoutineAdmin(auth);
    const routineId = readRoutineRunRoutineId(context.req.param("routineId"));
    const key = readIdempotencyKey(context.req.header("Idempotency-Key"));
    if (!key) {
      throw new HttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key est requise pour lancer une routine.",
      );
    }
    const requestHash = canonicalRoutineRunHash(routineId);

    try {
      const result = await withTenant(db, auth.organizationId, async (tx) => {
        // A lost response stays replayable even if the routine was later
        // deleted: the receipt belongs to the operation, not to its current state.
        const previous = await readRoutineRunIngress(tx, auth.organizationId, auth.userId, key, false);
        const earlyReplay = replayRoutineRun(previous, requestHash);
        if (earlyReplay) return { response: earlyReplay, replayed: true };
        if (previous) throw routineRunInProgress(previous.state);

        const routines = await tx<RunnableRoutineRow[]>`
          select r.id, r.bot_id as "botId", r.group_id as "groupId", thread.id as "threadId",
                 g.default_responder as "groupDefaultResponder",
                 g.answer_mode as "groupAnswerMode",
                 r.name, r.message, r.never_wait as "neverWait",
                 bot.autonomy_enabled as "autonomyEnabled",
                 bot.autonomy_max_depth as "autonomyMaxDepth",
                 bot.autonomy_max_steps as "autonomyMaxSteps",
                 bot.autonomy_max_handoffs as "autonomyMaxHandoffs",
                 bot.autonomy_timeout_seconds as "autonomyTimeoutSeconds",
                 bot.autonomy_token_budget as "autonomyTokenBudget",
                 offline.organization_id is not null as "hostOffline"
            from routines r
            left join ${disconnectedHostOrganizations(tx)} offline on offline.organization_id = r.organization_id
            left join bots bot on bot.organization_id = r.organization_id and bot.id = r.bot_id
              and bot.archived_at is null
            left join bot_groups g on g.organization_id = r.organization_id and g.id = r.group_id
            join threads thread on thread.organization_id = r.organization_id
              and (
                (r.bot_id is not null and thread.bot_id = r.bot_id and thread.is_default)
                or (r.group_id is not null and thread.group_id = r.group_id)
              )
           where r.organization_id = ${auth.organizationId} and r.id = ${routineId}
             and (r.bot_id is null or bot.id is not null)
             and (r.group_id is null or g.id is not null)
           for update of r, thread
        `;
        const routine = routines[0];
        if (!routine) throw new HttpError(404, "ROUTINE_NOT_FOUND", "Routine introuvable.");
        // The queue would not serve it: the run would fail in 15 min, then the
        // schedule's catch-up would fire again on the host's return.
        if (routine.hostOffline) throw new HttpError(409, "ROUTINE_HOST_OFFLINE", ROUTINE_HOST_OFFLINE_MESSAGE);

        const ingressId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        const workflowId = crypto.randomUUID();
        const inserted = await tx<Array<{ id: string }>>`
          insert into message_ingress (
            id, organization_id, user_id, thread_id, operation, idempotency_key, request_hash,
            message_id, run_id, workflow_id, attachment_manifest, state, expires_at
          ) values (
            ${ingressId}, ${auth.organizationId}, ${auth.userId}, ${routine.threadId},
            'routine.run.create', ${key}, ${requestHash}, ${messageId}, ${runId}, ${workflowId},
            '[]'::jsonb, 'reserved', now() + interval '7 days'
          )
          on conflict (organization_id, user_id, operation, idempotency_key) do nothing
          returning id
        `;
        const ingress = await readRoutineRunIngress(tx, auth.organizationId, auth.userId, key, true);
        if (!ingress) {
          throw new HttpError(409, "IDEMPOTENCY_RESERVATION_LOST", "La réservation du lancement a été perdue.");
        }
        const racedReplay = replayRoutineRun(ingress, requestHash);
        if (racedReplay) return { response: racedReplay, replayed: true };
        if (!inserted[0]) throw routineRunInProgress(ingress.state);

        const plan = await subscriptionPort().readForUpdate(tx, auth.organizationId);
        const subscription = plan ? { status: plan.status } : undefined;
        assertEntitled(
          billingEnforced,
          subscription,
          "Les routines sont suspendues tant que l’abonnement n’est pas actif.",
        );

        const active = await tx<Array<{ id: string }>>`
          select id from runs
           where organization_id = ${auth.organizationId} and thread_id = ${routine.threadId}
             and status in ('queued','starting','running','awaiting_approval','relaying','unknown')
           limit 1
        `;
        if (active[0]) {
          throw new HttpError(409, "THREAD_BUSY", "Cette conversation exécute déjà un workflow.");
        }

        const text = routineFireText(routine.name, routine.message);
        const workflowUpdatedAt = new Date().toISOString();
        const opened = routine.groupId
          ? await openManualGroupFire(tx, auth.organizationId, routine, text)
          : null;
        const policy = normalizeAutonomyPolicy({
          enabled: (opened?.autonomyEnabled ?? routine.autonomyEnabled) ?? AUTONOMY_DEFAULTS.enabled,
          maxDepth: (opened?.autonomyMaxDepth ?? routine.autonomyMaxDepth) ?? AUTONOMY_DEFAULTS.maxDepth,
          maxSteps: (opened?.autonomyMaxSteps ?? routine.autonomyMaxSteps) ?? AUTONOMY_DEFAULTS.maxSteps,
          maxHandoffs: (opened?.autonomyMaxHandoffs ?? routine.autonomyMaxHandoffs) ?? AUTONOMY_DEFAULTS.maxHandoffs,
          timeoutSeconds: (opened?.autonomyTimeoutSeconds ?? routine.autonomyTimeoutSeconds)
            ?? AUTONOMY_DEFAULTS.timeoutSeconds,
          tokenBudget: Number(
            opened?.autonomyTokenBudget ?? routine.autonomyTokenBudget ?? AUTONOMY_DEFAULTS.tokenBudget,
          ),
        });
        // routines_bot_xor_group: a room routine has its opened speaker, a bot routine its bot.
        const speaker = opened
          ? { kind: "group" as const, botId: opened.botId, position: opened.position, state: opened.state }
          : routine.botId ? { kind: "root" as const, botId: routine.botId } : null;
        if (!speaker) throw new Error(`routine ${routine.id} has neither a bot nor a room`);
        await fireRoutineTx(tx, {
          trigger: "manual",
          routineId: routine.id,
          organizationId: auth.organizationId,
          threadId: routine.threadId,
          runId,
          workflowId,
          initiatorUserId: auth.userId,
          input: text,
          speaker,
          budget: opened ? { ...policy, maxSteps: ROOM_LIMITS.maxMemberTurns } : policy,
          neverWait: routine.neverWait === true,
        });
        await tx`
          insert into messages (id, organization_id, thread_id, run_id, role, content)
          values (${messageId}, ${auth.organizationId}, ${routine.threadId}, ${runId},
                  'user', ${[{ type: "text", text }]})
        `;
        if (routine.groupId) {
          await tx`update bot_groups set needs_you = false, updated_at = now()
            where organization_id = ${auth.organizationId} and id = ${routine.groupId}`;
        }
        await tx`
          update threads set updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${routine.threadId}
        `;
        await tx`
          insert into routine_executions (
            organization_id, routine_id, outcome, trigger, missed_count,
            workflow_id, run_id, thread_id
          ) values (
            ${auth.organizationId}, ${routine.id}, 'fired', 'manual', 0,
            ${workflowId}, ${runId}, ${routine.threadId}
          )
        `;
        // A manual launch counts as an execution, but never moves
        // `next_run_at`: the planned cadence stays unchanged.
        await tx`
          update routines set last_run_at = now(), updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${routine.id}
        `;
        const response: RoutineRunAcceptedDto = {
          accepted: true,
          duplicate: false,
          routineId: routine.id,
          workflowId,
          runId,
          threadId: routine.threadId,
          status: "queued",
          notificationEligible: workflowNotificationEligible({
            kind: routine.groupId ? "group" : "routine",
            autonomyEnabled: policy.enabled,
          }),
          workflowUpdatedAt,
        };
        const completed = await tx<Array<{ id: string }>>`
          update message_ingress set state = 'completed', response_status = 202,
            response_body = ${response}, completed_at = now(), expires_at = now() + interval '7 days',
            updated_at = now()
           where id = ${ingress.id} and organization_id = ${auth.organizationId} and state = 'reserved'
           returning id
        `;
        if (!completed[0]) {
          throw new HttpError(409, "IDEMPOTENCY_RESERVATION_LOST", "La réservation du lancement a expiré.");
        }
        return { response, replayed: false };
      });
      if (result.replayed) context.header("Idempotency-Replayed", "true");
      return context.json(result.response, 202);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "THREAD_BUSY", "Cette conversation exécute déjà un workflow.");
      }
      throw error;
    }
  });

  routes.patch("/:routineId", async (context) => {
    const auth = context.get("auth");
    requireRoutineAdmin(auth);
    const routineId = context.req.param("routineId");
    const body = await jsonBody(context.req.raw);
    const routine = await withTenant(db, auth.organizationId, async (tx) => {
      const current = await tx<RoutineRow[]>`
        select id, bot_id as "botId", group_id as "groupId", name, schedule, timezone, message, enabled,
               next_run_at as "nextRunAt", last_run_at as "lastRunAt",
               missed_count as "missedCount", last_missed_at as "lastMissedAt",
               created_at as "createdAt", updated_at as "updatedAt", never_wait as "neverWait"
          from routines where organization_id = ${auth.organizationId} and id = ${routineId}
           for update
      `;
      if (!current[0]) throw new HttpError(404, "ROUTINE_NOT_FOUND", "Routine introuvable.");
      const merged = validatedRoutineInput({
        name: Object.hasOwn(body, "name") ? body.name : current[0].name,
        schedule: Object.hasOwn(body, "schedule") ? body.schedule : current[0].schedule,
        timezone: Object.hasOwn(body, "timezone") ? body.timezone : current[0].timezone,
        message: Object.hasOwn(body, "message") ? body.message : current[0].message,
        enabled: Object.hasOwn(body, "enabled") ? body.enabled : current[0].enabled,
        neverWait: Object.hasOwn(body, "neverWait") ? body.neverWait : current[0].neverWait,
      }, { requireOccurrence: false });
      // Under the row lock the tick also takes: a rename keeps the clock.
      const clock = editedClock(current[0], merged, new Date());
      const rows = await tx<RoutineRow[]>`
        update routines set
          name = ${merged.name}, schedule = ${merged.schedule}, timezone = ${merged.timezone},
          message = ${merged.message}, enabled = ${merged.enabled}, never_wait = ${merged.neverWait},
          next_run_at = case when ${clock === null}::boolean then next_run_at else ${clock?.nextRunAt ?? null}::timestamptz end,
          busy_retries = case when ${clock === null}::boolean then busy_retries else 0 end,
          updated_at = now()
        where organization_id = ${auth.organizationId} and id = ${routineId}
        returning id, bot_id as "botId", group_id as "groupId", name, schedule, timezone, message, enabled,
                  next_run_at as "nextRunAt", last_run_at as "lastRunAt",
                  missed_count as "missedCount", last_missed_at as "lastMissedAt",
                  created_at as "createdAt", updated_at as "updatedAt", never_wait as "neverWait"
      `;
      return rows[0]!;
    });
    return context.json(publicRoutine(routine));
  });

  routes.delete("/:routineId", async (context) => {
    const auth = context.get("auth");
    requireRoutineAdmin(auth);
    const deleted = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ id: string }>>`
      delete from routines where organization_id = ${auth.organizationId} and id = ${context.req.param("routineId")}
      returning id
    `);
    if (!deleted[0]) throw new HttpError(404, "ROUTINE_NOT_FOUND", "Routine introuvable.");
    return context.body(null, 204);
  });

  return routes;
}

export function readRoutineReceiptStatus(value: string | null): WorkflowStatus | null {
  if (value === null || value === "") return null;
  if (!ROUTINE_RECEIPT_STATUSES.includes(value as WorkflowStatus)) {
    throw new HttpError(400, "ROUTINE_RECEIPT_STATUS_INVALID", "Le statut du reçu est invalide.");
  }
  return value as WorkflowStatus;
}

export function canonicalRoutineRunHash(routineId: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ operation: "routine.run.create", routineId }))
    .digest("hex");
}

function readRoutineRunRoutineId(value: string): string {
  if (!isUuid(value)) {
    throw new HttpError(400, "ROUTINE_ID_INVALID", "L’identifiant de routine est invalide.");
  }
  return value.toLowerCase();
}

function readRoutineRunIngress(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  key: string,
  lock: boolean,
): Promise<RoutineRunIngressRow | null> {
  const query = lock
    ? tx<RoutineRunIngressRow[]>`
        select id, request_hash as "requestHash", state, message_id as "messageId",
               run_id as "runId", workflow_id as "workflowId",
               response_status as "responseStatus", response_body as "responseBody"
          from message_ingress
         where organization_id = ${organizationId} and user_id = ${userId}
           and operation = 'routine.run.create' and idempotency_key = ${key}
         for update
      `
    : tx<RoutineRunIngressRow[]>`
        select id, request_hash as "requestHash", state, message_id as "messageId",
               run_id as "runId", workflow_id as "workflowId",
               response_status as "responseStatus", response_body as "responseBody"
          from message_ingress
         where organization_id = ${organizationId} and user_id = ${userId}
           and operation = 'routine.run.create' and idempotency_key = ${key}
      `;
  return query.then((rows) => rows[0] ?? null);
}

function replayRoutineRun(
  row: RoutineRunIngressRow | null,
  requestHash: string,
): RoutineRunAcceptedDto | null {
  if (!row) return null;
  if (row.requestHash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé a déjà lancé une autre routine.");
  }
  if (row.state !== "completed") return null;
  if (row.responseStatus !== 202 || !isRoutineRunAccepted(row.responseBody)) {
    throw new HttpError(409, "IDEMPOTENCY_RESPONSE_INVALID", "L’accusé mémorisé est incomplet.");
  }
  return { ...row.responseBody, duplicate: true };
}

function routineRunInProgress(state: RoutineRunIngressRow["state"]): HttpError {
  return new HttpError(
    409,
    state === "abandoned" ? "IDEMPOTENCY_KEY_EXPIRED" : "IDEMPOTENCY_IN_PROGRESS",
    state === "abandoned"
      ? "Ce lancement a expiré; utilisez une nouvelle clé."
      : "Cette routine est déjà en cours de lancement.",
    state === "reserved" ? { "Retry-After": "2" } : {},
  );
}

function isRoutineRunAccepted(value: unknown): value is RoutineRunAcceptedDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<RoutineRunAcceptedDto>;
  return body.accepted === true && typeof body.duplicate === "boolean" &&
    typeof body.routineId === "string" && typeof body.workflowId === "string" &&
    typeof body.runId === "string" && typeof body.threadId === "string" &&
    body.status === "queued" && typeof body.notificationEligible === "boolean" &&
    typeof body.workflowUpdatedAt === "string";
}

export function readRoutineReceiptRoutineId(value: string | null): string | null {
  if (value === null || value === "") return null;
  if (!isUuid(value)) {
    throw new HttpError(400, "ROUTINE_RECEIPT_ROUTINE_INVALID", "L’identifiant de routine est invalide.");
  }
  return value.toLowerCase();
}

export function readRoutineReceiptLimit(value: string | null): number {
  if (value === null || value === "") return ROUTINE_RECEIPT_LIMIT_DEFAULT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > ROUTINE_RECEIPT_LIMIT_MAX) {
    throw new HttpError(400, "ROUTINE_RECEIPT_LIMIT_INVALID", "La taille de page est invalide.");
  }
  return parsed;
}

export function readRoutineReceiptCursor(
  value: string | null,
): { createdAt: string; id: string } | null {
  if (value === null || value === "") return null;
  const separator = value.lastIndexOf("|");
  if (separator <= 0) {
    throw new HttpError(400, "ROUTINE_RECEIPT_CURSOR_INVALID", "Le curseur du reçu est invalide.");
  }
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !isUuid(id)) {
    throw new HttpError(400, "ROUTINE_RECEIPT_CURSOR_INVALID", "Le curseur du reçu est invalide.");
  }
  return { createdAt: new Date(createdAt).toISOString(), id: id.toLowerCase() };
}

function routineReceiptDto(row: RoutineReceiptRow): RoutineExecutionReceiptDto {
  const startedAt = isoOrNull(row.startedAt);
  const endedAt = isoOrNull(row.endedAt);
  return {
    routineId: row.routineId,
    workflowId: row.workflowId,
    runId: row.runId,
    threadId: row.threadId,
    botId: row.botId,
    status: row.status,
    trigger: row.trigger === "manual" || row.trigger === "scheduled" ? row.trigger : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: isoOrNull(row.createdAt)!,
    startedAt,
    endedAt,
    durationMs: startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null,
  };
}

/** `archived`: its routines are held by the tick whatever the host. */
async function assertBot(tx: Bun.TransactionSQL, organizationId: string, botId: string): Promise<{ archived: boolean }> {
  const rows = await tx<Array<{ archived: boolean }>>`
    select archived_at is not null as archived from bots where organization_id = ${organizationId} and id = ${botId}
  `;
  if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  return rows[0];
}

export function publicRoutine(row: RoutineRow) {
  return {
    ...row,
    botId: row.botId,
    groupId: row.groupId,
    nextRunAt: isoOrNull(row.nextRunAt),
    lastRunAt: isoOrNull(row.lastRunAt),
    lastMissedAt: isoOrNull(row.lastMissedAt),
    missedCount: Number(row.missedCount ?? 0),
    waitingForHost: row.waitingForHost === true,
    createdAt: isoOrNull(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

function routineExecutionDto(row: RoutineExecutionRow): RoutineExecutionDto {
  return {
    id: row.id,
    routineId: row.routineId,
    outcome: row.outcome,
    trigger: row.trigger === "manual" || row.trigger === "scheduled" ? row.trigger : "scheduled",
    missedCount: Number(row.missedCount ?? 0),
    busyRetries: row.busyRetries === null || row.busyRetries === undefined ? null : Number(row.busyRetries),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    workflowId: row.workflowId,
    runId: row.runId,
    threadId: row.threadId,
    workflowStatus: row.workflowStatus,
    createdAt: isoOrNull(row.createdAt)!,
  };
}

async function openManualGroupFire(
  tx: Bun.TransactionSQL,
  organizationId: string,
  routine: RunnableRoutineRow,
  text: string,
): Promise<{
  botId: string;
  position: number;
  state: GroupSendState;
  autonomyEnabled: boolean;
  autonomyMaxDepth: number;
  autonomyMaxSteps: number;
  autonomyMaxHandoffs: number;
  autonomyTimeoutSeconds: number;
  autonomyTokenBudget: number | string;
}> {
  const members = await tx<Array<{
    id: string;
    slug: string;
    position: number;
    autonomyEnabled: boolean;
    autonomyMaxDepth: number;
    autonomyMaxSteps: number;
    autonomyMaxHandoffs: number;
    autonomyTimeoutSeconds: number;
    autonomyTokenBudget: number | string;
  }>>`
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
     where gm.organization_id = ${organizationId} and gm.group_id = ${routine.groupId}
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
  if (planned.kind === "empty") {
    throw new HttpError(409, "GROUP_EMPTY", "Ce groupe n'a plus de membre actif.");
  }
  const speaker = members.find((member) => member.id === planned.botId);
  if (!speaker) throw new HttpError(409, "GROUP_EMPTY", "Ce groupe n'a plus de membre actif.");
  return {
    botId: speaker.id,
    position: planned.position,
    state: planned.state,
    autonomyEnabled: speaker.autonomyEnabled,
    autonomyMaxDepth: speaker.autonomyMaxDepth,
    autonomyMaxSteps: speaker.autonomyMaxSteps,
    autonomyMaxHandoffs: speaker.autonomyMaxHandoffs,
    autonomyTimeoutSeconds: speaker.autonomyTimeoutSeconds,
    autonomyTokenBudget: speaker.autonomyTokenBudget,
  };
}

async function assertGroup(tx: Bun.TransactionSQL, organizationId: string, groupId: string): Promise<void> {
  const rows = await tx<Array<{ id: string }>>`
    select id from bot_groups where organization_id = ${organizationId} and id = ${groupId}
  `;
  if (!rows[0]) throw new HttpError(404, "GROUP_NOT_FOUND", "Groupe introuvable.");
}
