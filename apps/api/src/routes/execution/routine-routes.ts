import { UUID_LOOSE_RE, isUuid, isoOrNull } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { RoutineExecutionOutcome } from "@openedbot/contracts-api";
import {
  ROUTINE_LIMITS,
  isValidCron,
  isValidTimeZone,
  nextOccurrence,
  routineFireText,
} from "@openedbot/execution/domain/routines";
import { AUTONOMY_DEFAULTS, normalizeAutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import { coerceGroupDefaultResponder, planRoutineGroupSend, type GroupSendState } from "@openedbot/execution/domain/group-send";
import { workflowNotificationEligible } from "@openedbot/notifications/domain/workflow-notifications";
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

const ROUTINE_ADMIN_MESSAGE = "Les routines sont réservées aux administrateurs de l’organisation.";

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
 * Routines d'un bot : la « Routines pane » d'Hermes Bot Mode, portée par notre
 * planificateur (table `routines` + tick du worker), pas par le cron du
 * runtime : openedbot n'administre pas Hermes, et les tirs doivent
 * atterrir dans NOS fils.
 */
export function botRoutineRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:botId/routines", async (context) => {
    const auth = context.get("auth");
    const botId = context.req.param("botId");
    const routines = await withTenant(db, auth.organizationId, async (tx) => {
      await assertBot(tx, auth.organizationId, botId);
      return tx<RoutineRow[]>`
        select id, bot_id as "botId", group_id as "groupId", name, schedule, timezone, message, enabled,
               next_run_at as "nextRunAt", last_run_at as "lastRunAt",
               missed_count as "missedCount", last_missed_at as "lastMissedAt",
               created_at as "createdAt", updated_at as "updatedAt", never_wait as "neverWait"
          from routines
         where organization_id = ${auth.organizationId} and bot_id = ${botId}
         order by created_at asc
      `;
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
      // count + insert doivent être sérialisés: deux requêtes concurrentes au
      // dernier emplacement ne peuvent plus toutes deux franchir le quota.
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

/** Routines d'un salon : même CRUD que le bot, cible `group_id`. */
export function groupRoutineRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:groupId/routines", async (context) => {
    const auth = context.get("auth");
    const groupId = context.req.param("groupId");
    const routines = await withTenant(db, auth.organizationId, async (tx) => {
      await assertGroup(tx, auth.organizationId, groupId);
      return tx<RoutineRow[]>`
        select id, bot_id as "botId", group_id as "groupId", name, schedule, timezone, message, enabled,
               next_run_at as "nextRunAt", last_run_at as "lastRunAt",
               missed_count as "missedCount", last_missed_at as "lastMissedAt",
               created_at as "createdAt", updated_at as "updatedAt", never_wait as "neverWait"
          from routines
         where organization_id = ${auth.organizationId} and group_id = ${groupId}
         order by created_at asc
      `;
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

/** Verrou transactionnel PostgreSQL, scindé par tenant et cible (bot ou salon). `hashtext` peut
 * au pire sérialiser deux cibles distinctes en collision; il ne peut jamais
 * laisser dépasser le quota. La transaction `withTenant` le libère au commit
 * ou rollback. */
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
   * Reçus des tirs de routines. Le lien routine → workflow est figé par le
   * worker dans `workflows.recovery_state.routineId`. Pour les tirs antérieurs
   * à ce marqueur, l'association n'est admise que si UNE routine courante du
   * même bot reproduit exactement l'entrée racine; zéro ou plusieurs candidats
   * sont omis plutôt qu'attribués au hasard.
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
   * Lance une occurrence ponctuelle sans toucher à l'horloge du cron. Le
   * workflow, le run, le message visible et l'accusé d'idempotence sont écrits
   * dans UNE transaction : la réponse HTTP peut se perdre, jamais le reçu.
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
        // Une réponse perdue reste rejouable même si la routine a ensuite été
        // supprimée : l'accusé appartient à l'opération, pas à son état courant.
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
                 bot.autonomy_token_budget as "autonomyTokenBudget"
            from routines r
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
        const workflowKind = routine.groupId ? "group" : "routine";
        const workflowMaxSteps = routine.groupId ? ROOM_LIMITS.maxMemberTurns : policy.maxSteps;
        const runBotId = opened?.botId ?? routine.botId;
        const runStepKind = routine.groupId ? "group" : "root";
        await tx`
          insert into workflows (
            id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id,
            kind, status, protocol_version,
            autonomy_enabled, max_depth, max_steps, max_handoffs, timeout_seconds, token_budget,
            used_steps, used_handoffs, used_tokens, deadline_at, recovery_state, never_wait
          ) values (
            ${workflowId}, ${auth.organizationId}, ${routine.threadId}, ${runId}, ${runBotId},
            ${auth.userId}, ${workflowKind}, 'queued', 1, ${policy.enabled}, ${policy.maxDepth},
            ${workflowMaxSteps}, ${policy.maxHandoffs}, ${policy.timeoutSeconds}, ${policy.tokenBudget},
            1, 0, 0, now() + (${policy.timeoutSeconds} * interval '1 second'),
            ${{ routineId: routine.id, trigger: "manual" }}, ${routine.neverWait === true}
          )
        `;
        await tx`
          insert into runs (
            id, organization_id, thread_id, bot_id, group_turn_position, group_state, input, status,
            workflow_id, step_index, step_kind, stack_depth, external_state, events_complete
          ) values (
            ${runId}, ${auth.organizationId}, ${routine.threadId}, ${runBotId}, ${opened?.position ?? null},
            ${opened?.state ?? null}, ${text}, 'queued', ${workflowId}, 0, ${runStepKind}, 0, 'not_started', true
          )
        `;
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
        // Un lancement manuel compte comme une exécution, mais ne déplace
        // jamais `next_run_at` : la cadence planifiée reste inchangée.
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
      `;
      if (!current[0]) throw new HttpError(404, "ROUTINE_NOT_FOUND", "Routine introuvable.");
      const merged = validatedRoutineInput({
        name: Object.hasOwn(body, "name") ? body.name : current[0].name,
        schedule: Object.hasOwn(body, "schedule") ? body.schedule : current[0].schedule,
        timezone: Object.hasOwn(body, "timezone") ? body.timezone : current[0].timezone,
        message: Object.hasOwn(body, "message") ? body.message : current[0].message,
        enabled: Object.hasOwn(body, "enabled") ? body.enabled : current[0].enabled,
        neverWait: Object.hasOwn(body, "neverWait") ? body.neverWait : current[0].neverWait,
      });
      // Toute écriture recalcule l'horloge : un cron ou un fuseau changé rend
      // l'ancien `next_run_at` faux, et le recalcul est idempotent.
      const rows = await tx<RoutineRow[]>`
        update routines set
          name = ${merged.name}, schedule = ${merged.schedule}, timezone = ${merged.timezone},
          message = ${merged.message}, enabled = ${merged.enabled}, never_wait = ${merged.neverWait},
          next_run_at = ${merged.enabled ? nextOccurrence(merged.schedule, new Date(), merged.timezone) : null},
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

/**
 * Valide et normalise l'entrée d'une routine : partagé entre POST (complet) et
 * PATCH (fusionné avec l'existant avant validation, pour que le résultat soit
 * TOUJOURS entièrement valide).
 */
export function validatedRoutineInput(body: Record<string, unknown>): {
  name: string;
  schedule: string;
  timezone: string;
  message: string;
  enabled: boolean;
  neverWait: boolean;
} {
  const name = assertString(body.name, "Le nom de la routine", { max: ROUTINE_LIMITS.nameMax });
  const schedule = assertString(body.schedule, "La planification", { max: 100 });
  if (!isValidCron(schedule)) {
    throw new HttpError(400, "ROUTINE_SCHEDULE_INVALID", "La planification doit être un cron à 5 champs (ex. « 0 9 * * 1-5 »).");
  }
  const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "UTC";
  if (!isValidTimeZone(timezone)) {
    throw new HttpError(400, "ROUTINE_TIMEZONE_INVALID", "Le fuseau doit être un identifiant IANA (ex. « Europe/Paris »).");
  }
  const message = assertString(body.message, "Le message de la routine", { max: ROUTINE_LIMITS.messageMax });
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  if (enabled && nextOccurrence(schedule, new Date(), timezone) === null) {
    throw new HttpError(
      400,
      "ROUTINE_SCHEDULE_NO_OCCURRENCE",
      "Cette planification ne possède aucune prochaine occurrence.",
    );
  }
  // PERM2-9: absent is off (an operator's routine waits for a person, as
  // before); anything but a boolean is refused rather than guessed.
  if (body.neverWait !== undefined && typeof body.neverWait !== "boolean") {
    throw new HttpError(400, "ROUTINE_NEVER_WAIT_INVALID", "L’option « Ne jamais attendre » doit être vraie ou fausse.");
  }
  const neverWait = body.neverWait === true;
  return { name, schedule, timezone, message, enabled, neverWait };
}

async function assertBot(tx: Bun.TransactionSQL, organizationId: string, botId: string): Promise<void> {
  const rows = await tx<Array<{ id: string }>>`
    select id from bots where organization_id = ${organizationId} and id = ${botId}
  `;
  if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
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
