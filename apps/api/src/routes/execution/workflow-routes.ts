import type { SQL } from "bun";
import { isUuid, isoInstant } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { requestWorkflowCancellationTx } from "@openedbot/execution/application/run-cancellation";
import { recordRunReceiptsTx } from "@openedbot/execution/application/run-receipts";
import { openWorkflowRetryTx } from "@openedbot/execution/application/run-creation";
import { isRetryableRootStepKind } from "@openedbot/execution/domain/run-creation";
import {
  failAbandonedSteerFallbackTx,
  failUnknownRunsTx,
  requeueForReconciliationTx,
  requeueSteerFallbackTx,
} from "@openedbot/execution/application/run-review";
import { readRetrySource } from "./workflow-retry-source";

type WorkflowRow = {
  id: string;
  threadId: string;
  rootRunId: string;
  rootBotId: string | null;
  initiatorUserId: string | null;
  kind: "dm" | "group" | "routine";
  status: string;
  protocolVersion: number;
  autonomyEnabled: boolean;
  maxDepth: number;
  maxSteps: number;
  maxHandoffs: number;
  timeoutSeconds: number;
  tokenBudget: string | number;
  usedSteps: number;
  usedHandoffs: number;
  usedTokens: string | number;
  deadlineAt: Date | string;
  errorCode: string | null;
  errorMessage: string | null;
  finalOutput: string | null;
  recoveryState: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export function workflowRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * L'historique des exécutions : ce que les bots ont fait, hors du fil.
   *
   * Le panneau de conversation ne montre QUE ce qui est en vol ou à trancher :
   * un workflow terminé n'y laisse rien, parce que le fil porte déjà sa
   * réponse. Sans cette liste, le travail durable de la plateforme n'était
   * visible nulle part une fois terminé.
   *
   * Pagination par CLÉ (`created_at`, `id`) et non par OFFSET : une exécution
   * qui démarre pendant la lecture décalerait toutes les pages suivantes.
   */
  routes.get("/", async (context) => {
    const auth = context.get("auth");
    const url = new URL(context.req.url);
    const filter = readHistoryFilter(url.searchParams.get("status"));
    const limit = readHistoryLimit(url.searchParams.get("limit"));
    const cursor = readHistoryCursor(url.searchParams.get("cursor"));

    const rows = await withTenant(db, auth.organizationId, (tx) => tx<HistoryRow[]>`
      select w.id, w.thread_id as "threadId", w.kind, w.status,
             w.used_steps as "usedSteps", w.max_steps as "maxSteps",
             w.used_handoffs as "usedHandoffs", w.max_handoffs as "maxHandoffs",
             w.used_tokens as "usedTokens", w.token_budget as "tokenBudget",
             w.error_code as "errorCode", w.error_message as "errorMessage",
             w.final_output as "finalOutput",
             w.recovery_state as "recoveryState",
             w.created_at as "createdAt", w.started_at as "startedAt", w.ended_at as "endedAt",
             b.name as "botName", b.slug as "botSlug", b.face as "botFace",
             g.id as "groupId", g.name as "groupName",
             u.display_name as "initiatorName", u.email as "initiatorEmail"
        from workflows w
        left join bots b on b.organization_id = w.organization_id and b.id = w.root_bot_id
        left join threads t on t.organization_id = w.organization_id and t.id = w.thread_id
        left join bot_groups g on g.organization_id = w.organization_id and g.id = t.group_id
        left join users u on u.id = w.initiator_user_id
       where w.organization_id = ${auth.organizationId}
         and (${filter === "all"} or
              (${filter === "active"} and w.status in ('queued','running','awaiting_approval','reconciling')) or
              (${filter === "attention"} and (w.status = 'unknown' or w.status = 'failed' or w.status = 'expired')))
         and (${cursor === null} or
              (w.created_at, w.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
       order by w.created_at desc, w.id desc
       limit ${limit + 1}
    `);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return context.json({
      workflows: page.map(historyDto),
      // Une page pleine + une ligne de rab : c'est ainsi qu'on sait qu'il reste
      // quelque chose sans compter toute la table.
      nextCursor: rows.length > limit && last ? `${isoInstant(last.createdAt)}|${last.id}` : null,
    });
  });

  routes.get("/:workflowId", async (context) => {
    const auth = context.get("auth");
    const rows = await withTenant(db, auth.organizationId, (tx) =>
      readWorkflow(tx, auth.organizationId, context.req.param("workflowId")));
    if (!rows[0]) throw new HttpError(404, "WORKFLOW_NOT_FOUND", "Workflow introuvable.");
    return context.json(workflowDto(rows[0]));
  });

  routes.post("/:workflowId/cancel", async (context) => {
    const auth = context.get("auth");
    await withTenant(db, auth.organizationId, async (tx) => {
      const cancelled = await requestWorkflowCancellationTx(
        tx,
        auth.organizationId,
        context.req.param("workflowId"),
        { code: "CANCELLED_BY_USER", message: "Workflow annulé." },
      );
      const workflow = await lockWorkflow(tx, auth.organizationId, context.req.param("workflowId"));
      if (workflow.status === "unknown") {
        if (cancelled.some((run) => run.status === "unknown")) return;
        throw new HttpError(
          409,
          "WORKFLOW_REVIEW_REQUIRED",
          "L’effet externe est incertain. Réconciliez ou abandonnez le workflow avant de libérer le fil.",
        );
      }
      if (isWorkflowTerminal(workflow.status)) return;
      if (cancelled.length === 0) await tx`
        update workflows set status = 'cancelled', error_code = 'CANCELLED_BY_USER',
          error_message = 'Workflow annulé.', recovery_state = ${{ cancelRequested: true }},
          ended_at = now(), updated_at = now()
         where organization_id = ${auth.organizationId} and id = ${workflow.id}
           and status in ('queued','running','awaiting_approval','reconciling')
      `;
    });
    return context.body(null, 204);
  });

  routes.post("/:workflowId/reconcile", async (context) => {
    const auth = context.get("auth");
    const result = await withTenant(db, auth.organizationId, async (tx) => {
      await lockWorkflowRuns(tx, auth.organizationId, context.req.param("workflowId"));
      const workflow = await lockWorkflow(tx, auth.organizationId, context.req.param("workflowId"));
      if (workflow.status !== "unknown") {
        throw new HttpError(409, "WORKFLOW_NOT_UNKNOWN", "Ce workflow n’attend pas de réconciliation.");
      }
      const runs = await tx<Array<{ id: string; hermesRunId: string | null }>>`
        select id, hermes_run_id as "hermesRunId" from runs
         where organization_id = ${auth.organizationId} and workflow_id = ${workflow.id} and status = 'unknown'
         order by step_index desc nulls last limit 1 for update
      `;
      const run = runs[0];
      if (!run?.hermesRunId) {
        throw new HttpError(
          409,
          "WORKFLOW_RECONCILIATION_UNAVAILABLE",
          "Hermes n’a rendu aucun identifiant fiable; abandonnez ou relancez explicitement avec risque de doublon.",
        );
      }
      await requeueForReconciliationTx(tx as unknown as SQL, { organizationId: auth.organizationId, id: run.id });
      await tx`
        update workflows set status = 'reconciling', error_code = null, error_message = null, updated_at = now()
         where organization_id = ${auth.organizationId} and id = ${workflow.id}
      `;
      return { workflowId: workflow.id, runId: run.id, status: "reconciling" };
    });
    return context.json(result, 202);
  });

  routes.post("/:workflowId/abandon", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    await withTenant(db, auth.organizationId, async (tx) => {
      await lockWorkflowRuns(tx, auth.organizationId, context.req.param("workflowId"));
      const workflow = await lockWorkflow(tx, auth.organizationId, context.req.param("workflowId"));
      const resolution = workflowResolution(workflow.recoveryState);
      if (resolution === "abandoned" || resolution === "retried") return;
      if (!isInboxAttentionStatus(workflow.status)) {
        throw new HttpError(
          409,
          "WORKFLOW_NOT_UNKNOWN",
          "Seul un workflow à traiter (incertain, échoué ou expiré) peut être abandonné.",
        );
      }
      const ambiguousSteer = await lockAmbiguousRunSteer(
        tx,
        auth.organizationId,
        workflow.id,
      );
      if (ambiguousSteer) {
        await tx`
          update run_steering_attempts set status = 'expired', error_code = 'STEER_FALLBACK_ABANDONED',
            forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${ambiguousSteer.id} and status = 'ambiguous'
        `;
        await failAbandonedSteerFallbackTx(tx as unknown as SQL, { organizationId: auth.organizationId, id: ambiguousSteer.sourceRunId });
      }
      await failUnknownRunsTx(tx as unknown as SQL, { organizationId: auth.organizationId, workflowId: workflow.id }, {
        errorCode: "EXTERNAL_OUTCOME_ABANDONED",
        errorMessage: "Résultat externe incertain; workflow abandonné par un administrateur.",
      });
      if (workflow.status === "unknown") {
        await tx`
          update workflows set status = 'failed', error_code = 'EXTERNAL_OUTCOME_ABANDONED',
            error_message = 'Le résultat Hermes peut exister, mais sa réconciliation a été abandonnée.',
            recovery_state = ${{ resolution: "abandoned", duplicateRisk: true }}, ended_at = now(), updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${workflow.id}
        `;
      } else {
        // Échec / expiration déjà terminaux : on ne réécrit pas l'erreur Hermes,
        // on pose seulement la résolution pour sortir le dossier de l'inbox.
        await tx`
          update workflows set
            recovery_state = recovery_state || ${{ resolution: "abandoned", duplicateRisk: false }},
            ended_at = coalesce(ended_at, now()), updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${workflow.id}
             and status in ('failed', 'expired')
        `;
      }
      if (ambiguousSteer) {
        await recordRunReceiptsTx(tx, { organizationId: auth.organizationId, attemptIds: [ambiguousSteer.id] });
      }
    });
    return context.body(null, 204);
  });

  routes.post("/:workflowId/retry", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    if (body.confirmDuplicateRisk !== true) {
      throw new HttpError(
        400,
        "DUPLICATE_RISK_CONFIRMATION_REQUIRED",
        "Confirmez explicitement le risque de reproduire un effet déjà exécuté par Hermes.",
      );
    }
    const result = await withTenant(db, auth.organizationId, async (tx) => {
      const pointers = await tx<Array<{ threadId: string }>>`
        select thread_id as "threadId" from workflows
         where organization_id = ${auth.organizationId} and id = ${context.req.param("workflowId")}
      `;
      if (!pointers[0]) throw new HttpError(404, "WORKFLOW_NOT_FOUND", "Workflow introuvable.");
      const threads = await tx<Array<{ id: string }>>`
        select id from threads
         where organization_id = ${auth.organizationId} and id = ${pointers[0].threadId}
         for update
      `;
      if (!threads[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
      await lockWorkflowRuns(tx, auth.organizationId, context.req.param("workflowId"));
      const workflow = await lockWorkflow(tx, auth.organizationId, context.req.param("workflowId"));
      // The original workflow is the durable idempotency anchor. Persisting the
      // replacement ids in the same transaction makes an HTTP replay return the
      // first receipt even after that replacement has already finished.
      const previousRetry = workflowRetryReceipt(workflow.recoveryState);
      if (previousRetry) {
        return { ...previousRetry, status: "queued", duplicateRisk: true };
      }
      if (workflow.status !== "unknown" && workflow.status !== "failed" && workflow.status !== "expired") {
        throw new HttpError(409, "WORKFLOW_RETRY_FORBIDDEN", "Ce workflow ne peut pas être relancé.");
      }
      const ambiguousSteer = workflow.status === "unknown"
        ? await lockAmbiguousRunSteer(tx, auth.organizationId, workflow.id)
        : null;
      if (ambiguousSteer) {
        // La consigne a peut-être atteint le run actif. Après confirmation
        // humaine du risque, on réactive LE workflow de repli d'origine : son
        // rang FIFO ne bouge pas et aucun second workflow n'est créé.
        await tx`
          update run_steering_attempts set status = 'expired', error_code = 'STEER_FALLBACK_CONFIRMED',
            forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${ambiguousSteer.id} and status = 'ambiguous'
        `;
        if (!await requeueSteerFallbackTx(tx as unknown as SQL, { organizationId: auth.organizationId, id: ambiguousSteer.sourceRunId })) {
          throw new HttpError(
            409,
            "STEER_FALLBACK_MISSING",
            "Le run de repli du follow-up n’est plus disponible; abandonnez ce workflow.",
          );
        }
        await tx`
          update workflows set status = 'queued', error_code = null, error_message = null,
            recovery_state = '{}'::jsonb, ended_at = null,
            deadline_at = now() + (${workflow.timeoutSeconds} * interval '1 second'), updated_at = now()
           where organization_id = ${auth.organizationId} and id = ${workflow.id} and status = 'unknown'
        `;
        await recordRunReceiptsTx(tx, { organizationId: auth.organizationId, attemptIds: [ambiguousSteer.id] });
        return {
          workflowId: workflow.id,
          runId: ambiguousSteer.sourceRunId,
          status: "queued",
          duplicateRisk: true,
        };
      }
      const busy = await tx<Array<{ id: string }>>`
        select id from runs where organization_id = ${auth.organizationId} and thread_id = ${pointers[0].threadId}
          and status in ('queued','starting','running','awaiting_approval','relaying','unknown')
          and workflow_id is distinct from ${context.req.param("workflowId")}
         limit 1
      `;
      if (busy[0]) {
        throw new HttpError(409, "THREAD_BUSY", "Cette conversation exécute déjà un autre workflow.");
      }
      if (workflow.kind === "group") {
        throw new HttpError(
          409,
          "WORKFLOW_GROUP_RETRY_UNSUPPORTED",
          "Le roster du salon peut avoir changé. Abandonnez ce workflow puis envoyez un nouveau message au salon.",
        );
      }
      const root = await readRetrySource(tx, auth.organizationId, workflow.rootRunId);
      if (!root) throw new HttpError(409, "WORKFLOW_ROOT_MISSING", "Le run racine n’existe plus.");
      // Mis en revue par 0175 : un run de service (brouillon de persona) se
      // relance depuis son propre écran, et le run entrant d'un ancien
      // hand-off ne saurait plus livrer sa réponse à son courrier.
      if (!isRetryableRootStepKind(root.stepKind)) throw new HttpError(409, "WORKFLOW_SERVICE_RETRY_UNSUPPORTED",
        "Ce travail de service ne se relance pas d’ici. Abandonnez ce workflow puis relancez-le depuis la fiche du bot.");
      if (root.originRunId) throw new HttpError(409, "WORKFLOW_HANDOFF_RETRY_UNSUPPORTED",
        "Ce message transmis ne se relance pas. Abandonnez ce workflow puis renvoyez le message.");
      if (!root.botId) {
        throw new HttpError(409, "WORKFLOW_BOT_MISSING", "Le bot racine n’existe plus ou est archivé.");
      }
      if (root.stackDepth > 0 && !root.callerBotId) {
        throw new HttpError(409, "WORKFLOW_CALLER_MISSING", "Le bot appelant n’existe plus.");
      }
      const requiredBotIds = [...new Set([
        root.botId,
        root.callerBotId,
        workflow.rootBotId,
      ].filter((id): id is string => Boolean(id)))].sort();
      const activeBots = await tx<Array<{ id: string }>>`
        select id from bots where organization_id = ${auth.organizationId} and id in ${tx(requiredBotIds)}
          and archived_at is null order by id for update
      `;
      if (activeBots.length !== requiredBotIds.length) {
        throw new HttpError(409, "WORKFLOW_BOT_MISSING", "Un bot requis n’existe plus ou est archivé.");
      }
      const workflowId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      await failUnknownRunsTx(tx as unknown as SQL, { organizationId: auth.organizationId, workflowId: workflow.id }, {
        errorCode: "RETRIED_WITH_DUPLICATE_RISK", errorMessage: "Remplacé par une relance explicitement confirmée.",
      });
      await tx`
        update workflows set status = 'failed', error_code = 'RETRIED_WITH_DUPLICATE_RISK',
          error_message = 'Un nouveau workflow a été créé avec risque de doublon.',
          recovery_state = ${{
            resolution: "retried",
            duplicateRisk: true,
            retryWorkflowId: workflowId,
            retryRunId: runId,
          }}, ended_at = now(), updated_at = now()
         where organization_id = ${auth.organizationId} and id = ${workflow.id}
      `;

      // La relance rejoue le tour d'origine sous ses restrictions : un plan
      // reste un plan, une routine sans attente le reste, et le message source
      // (ses images) reste celui que le worker relit.
      await openWorkflowRetryTx(tx, {
        organizationId: auth.organizationId,
        threadId: workflow.threadId,
        workflowId,
        runId,
        initiatorUserId: auth.userId,
        replaced: { id: workflow.id, kind: workflow.kind, rootBotId: workflow.rootBotId, protocolVersion: workflow.protocolVersion,
          budget: { enabled: workflow.autonomyEnabled, maxDepth: workflow.maxDepth, maxSteps: workflow.maxSteps,
            maxHandoffs: workflow.maxHandoffs, timeoutSeconds: workflow.timeoutSeconds, tokenBudget: Number(workflow.tokenBudget) } },
        root: { ...root, botId: root.botId, stepKind: root.stepKind },
      });
      return { workflowId, runId, status: "queued", duplicateRisk: true };
    });
    return context.json(result, 202);
  });

  return routes;
}

async function lockWorkflow(tx: TransactionDb, organizationId: string, workflowId: string): Promise<WorkflowRow> {
  const rows = await tx<WorkflowRow[]>`
    select id, thread_id as "threadId", root_run_id as "rootRunId", root_bot_id as "rootBotId",
           initiator_user_id as "initiatorUserId", kind, status, protocol_version as "protocolVersion",
           autonomy_enabled as "autonomyEnabled", max_depth as "maxDepth", max_steps as "maxSteps", max_handoffs as "maxHandoffs",
           timeout_seconds as "timeoutSeconds", token_budget as "tokenBudget", used_steps as "usedSteps",
           used_handoffs as "usedHandoffs", used_tokens as "usedTokens", deadline_at as "deadlineAt",
           error_code as "errorCode", error_message as "errorMessage", final_output as "finalOutput",
           recovery_state as "recoveryState",
           created_at as "createdAt", updated_at as "updatedAt"
      from workflows where organization_id = ${organizationId} and id = ${workflowId} for update
  `;
  if (!rows[0]) throw new HttpError(404, "WORKFLOW_NOT_FOUND", "Workflow introuvable.");
  return rows[0];
}

async function lockWorkflowRuns(tx: TransactionDb, organizationId: string, workflowId: string): Promise<void> {
  await tx`
    select id from runs where organization_id = ${organizationId} and workflow_id = ${workflowId}
     order by id for update
  `;
}

async function lockAmbiguousRunSteer(
  tx: TransactionDb,
  organizationId: string,
  workflowId: string,
): Promise<{ id: string; sourceRunId: string } | null> {
  const rows = await tx<Array<{ id: string; sourceRunId: string }>>`
    select steer.id, steer.source_run_id as "sourceRunId"
      from run_steering_attempts steer
      join runs source
        on source.organization_id = steer.organization_id and source.id = steer.source_run_id
     where steer.organization_id = ${organizationId} and source.workflow_id = ${workflowId}
       and steer.status = 'ambiguous'
     order by steer.created_at asc, steer.id asc
     limit 1 for update of steer
  `;
  return rows[0] ?? null;
}

function readWorkflow(tx: TransactionDb, organizationId: string, workflowId: string): Promise<WorkflowRow[]> {
  return tx<WorkflowRow[]>`
    select id, thread_id as "threadId", root_run_id as "rootRunId", root_bot_id as "rootBotId",
           initiator_user_id as "initiatorUserId", kind, status, protocol_version as "protocolVersion",
           autonomy_enabled as "autonomyEnabled", max_depth as "maxDepth", max_steps as "maxSteps", max_handoffs as "maxHandoffs",
           timeout_seconds as "timeoutSeconds", token_budget as "tokenBudget", used_steps as "usedSteps",
           used_handoffs as "usedHandoffs", used_tokens as "usedTokens", deadline_at as "deadlineAt",
           error_code as "errorCode", error_message as "errorMessage", final_output as "finalOutput",
           recovery_state as "recoveryState",
           created_at as "createdAt", updated_at as "updatedAt"
      from workflows where organization_id = ${organizationId} and id = ${workflowId}
  `;
}

function workflowDto(row: WorkflowRow): Record<string, unknown> {
  const { autonomyEnabled: _internalPolicySnapshot, ...publicRow } = row;
  return {
    ...publicRow,
    tokenBudget: Number(row.tokenBudget),
    usedTokens: Number(row.usedTokens),
    deadlineAt: isoInstant(row.deadlineAt),
    createdAt: isoInstant(row.createdAt),
    updatedAt: isoInstant(row.updatedAt),
    recoveryState: row.status === "unknown" ? "needs_review" : null,
    ...routinePublicFields(row.kind, row.recoveryState),
  };
}

function workflowRetryReceipt(value: unknown): { workflowId: string; runId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.resolution !== "retried") return null;
  if (
    typeof state.retryWorkflowId !== "string" || !state.retryWorkflowId ||
    typeof state.retryRunId !== "string" || !state.retryRunId
  ) {
    throw new HttpError(
      409,
      "WORKFLOW_RETRY_ALREADY_CONSUMED",
      "Ce workflow a déjà été relancé; son identifiant de remplacement est indisponible.",
    );
  }
  return { workflowId: state.retryWorkflowId, runId: state.retryRunId };
}

function isWorkflowTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}

/** Les trois statuts que l'inbox traite comme « à vérifier ». */
function isInboxAttentionStatus(status: string): status is "unknown" | "failed" | "expired" {
  return status === "unknown" || status === "failed" || status === "expired";
}

function workflowResolution(value: unknown): "abandoned" | "retried" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const resolution = (value as Record<string, unknown>).resolution;
  return resolution === "abandoned" || resolution === "retried" ? resolution : null;
}

// ── Historique des exécutions ───────────────────────────────────────────────

export type HistoryFilter = "all" | "active" | "attention";
const HISTORY_FILTERS: readonly HistoryFilter[] = ["all", "active", "attention"];
const HISTORY_LIMIT_DEFAULT = 25;
const HISTORY_LIMIT_MAX = 100;

type HistoryRow = {
  id: string;
  threadId: string;
  kind: "dm" | "group" | "routine";
  status: string;
  usedSteps: number;
  maxSteps: number;
  usedHandoffs: number;
  maxHandoffs: number;
  usedTokens: string | number;
  tokenBudget: string | number;
  errorCode: string | null;
  errorMessage: string | null;
  finalOutput: string | null;
  recoveryState: unknown;
  createdAt: Date | string;
  startedAt: Date | string | null;
  endedAt: Date | string | null;
  botName: string | null;
  botSlug: string | null;
  botFace: unknown;
  groupId: string | null;
  groupName: string | null;
  initiatorName: string | null;
  initiatorEmail: string | null;
};

export function routinePublicFields(
  kind: string,
  recoveryState: unknown,
): { routineId: string | null; trigger: "manual" | "scheduled" | null } | Record<string, never> {
  if (kind !== "routine") return {};
  if (!recoveryState || typeof recoveryState !== "object" || Array.isArray(recoveryState)) {
    return { routineId: null, trigger: null };
  }
  const state = recoveryState as Record<string, unknown>;
  const routineId = typeof state.routineId === "string" && isUuid(state.routineId)
    ? state.routineId.toLowerCase()
    : null;
  const trigger = state.trigger === "manual" || state.trigger === "scheduled" ? state.trigger : null;
  return { routineId, trigger };
}

/** Un filtre inconnu ne vaut pas une erreur : il retombe sur la vue complète. */
export function readHistoryFilter(value: string | null): HistoryFilter {
  return HISTORY_FILTERS.includes(value as HistoryFilter) ? (value as HistoryFilter) : "all";
}

export function readHistoryLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return HISTORY_LIMIT_DEFAULT;
  return Math.min(HISTORY_LIMIT_MAX, parsed);
}

/**
 * `<iso>|<uuid>` : les deux moitiés de la clé de tri. Un curseur illisible est
 * ignoré plutôt que refusé : il ne vient jamais que d'une page précédente, et
 * repartir du début vaut mieux qu'une erreur devant l'opérateur.
 */
export function readHistoryCursor(value: string | null): { createdAt: string; id: string } | null {
  if (!value) return null;
  const separator = value.lastIndexOf("|");
  if (separator <= 0) return null;
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (Number.isNaN(Date.parse(createdAt))) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt, id };
}

function historyDto(row: HistoryRow): Record<string, unknown> {
  const startedAt = row.startedAt ? isoInstant(row.startedAt) : null;
  const endedAt = row.endedAt ? isoInstant(row.endedAt) : null;
  return {
    id: row.id,
    threadId: row.threadId,
    kind: row.kind,
    status: row.status,
    recoveryState: row.status === "unknown" ? "needs_review" : null,
    ...routinePublicFields(row.kind, row.recoveryState),
    usedSteps: row.usedSteps,
    maxSteps: row.maxSteps,
    usedHandoffs: row.usedHandoffs,
    maxHandoffs: row.maxHandoffs,
    usedTokens: Number(row.usedTokens),
    tokenBudget: Number(row.tokenBudget),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    finalOutput: row.finalOutput,
    createdAt: isoInstant(row.createdAt),
    startedAt,
    endedAt,
    // La durée n'a de sens qu'une fois l'exécution close; en vol, l'écran
    // compte lui-même depuis `startedAt`.
    durationMs: startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null,
    botName: row.botName,
    botSlug: row.botSlug,
    botFace: row.botFace ?? null,
    groupId: row.groupId,
    groupName: row.groupName,
    // L'e-mail ne sort pas de l'API d'historique : le nom d'affichage suffit à
    // dire QUI a lancé, et l'écran n'a aucune raison de porter un identifiant
    // nominatif de plus.
    initiatorName: row.initiatorName ?? (row.initiatorEmail ? row.initiatorEmail.split("@")[0]! : null),
  };
}
