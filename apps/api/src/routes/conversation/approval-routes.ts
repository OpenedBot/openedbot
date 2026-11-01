import { Hono } from "hono";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { logEvent } from "@openedbot/platform-observability";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { appendDecisionTx, type DecisionChoice } from "@openedbot/execution/application/decision-journal";
import { isAlwaysChoice } from "@openedbot/execution/domain/permission-always";
import { createBotPermissionGrantTx } from "@openedbot/roster/sql/permission-grants";
import { activeRuntimeIdTx, setTerminalDangerAlwaysTx } from "@openedbot/runtimes/sql/permission-settings";
import type { ApprovalAlwaysChoice, ApprovalRespondDto } from "@openedbot/contracts-api";
import {
  alwaysErrorCode,
  alwaysOffered,
  approvalKind,
  mayAnswerAlways,
  type AlwaysGateRow,
} from "./approval-always";

export function approvalRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/:approvalId/respond", async (context) => {
    const auth = context.get("auth");
    // Approuver une action shell/FS/réseau est un privilège: réservé aux administrateurs.
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const choice = body.choice;
    // PERM2-4: an "Always" is an extended choice of the API only; Hermes
    // still receives `once`. `session` and `always` stay refused.
    const always = isAlwaysChoice(choice) ? choice : null;
    if (choice !== "once" && choice !== "deny" && !always) {
      throw new HttpError(400, "APPROVAL_CHOICE_INVALID", "Cette décision n’est pas autorisée.");
    }
    if (always && !mayAnswerAlways(auth)) {
      throw new HttpError(403, "APPROVAL_ALWAYS_FORBIDDEN", "Seul un propriétaire ou un administrateur de l’espace peut choisir « Toujours ».");
    }
    const decided: DecisionChoice = always ? "once" : choice as DecisionChoice;
    const result = await withTenant(db, auth.organizationId, async (tx) => {
      const pointers = await tx<Array<{ runId: string; workflowId: string | null }>>`
        select approval.run_id as "runId", run.workflow_id as "workflowId"
          from approval_requests approval
          join runs run on run.organization_id = approval.organization_id and run.id = approval.run_id
         where approval.organization_id = ${auth.organizationId} and approval.id = ${context.req.param("approvalId")}
           and approval.status = 'pending' and approval.forward_state = 'pending'
           and (approval.decision_state is null or approval.decision_state = 'awaiting_human')
      `;
      const pointer = pointers[0];
      if (!pointer) throw new HttpError(409, "APPROVAL_NOT_PENDING", "Cette décision a déjà été traitée.");
      const runs = await tx<Array<{ status: string; hermesRunId: string | null }>>`
        select status, hermes_run_id as "hermesRunId" from runs
         where organization_id = ${auth.organizationId} and id = ${pointer.runId}
         for update
      `;
      const workflow = pointer.workflowId
        ? (await tx<Array<{ status: string }>>`
            select status from workflows where organization_id = ${auth.organizationId} and id = ${pointer.workflowId}
             for update
          `)[0]
        : null;
      const rows = await tx<Array<{ id: string; threadId: string; runId: string; expiresAt: Date | string } & AlwaysGateRow>>`
        select id, thread_id as "threadId", run_id as "runId", expires_at as "expiresAt",
               decision_state as "decisionState", gate_kind as "gateKind", tool_key as "toolKey",
               gate_args as "gateArgs", choices, decision_detail->>'effectiveMode' as "effectiveMode",
               (select o.permission_pipeline from organizations o where o.id = approval_requests.organization_id) as pipeline
          from approval_requests
         where organization_id = ${auth.organizationId} and id = ${context.req.param("approvalId")}
           and status = 'pending' and forward_state = 'pending'
           and (decision_state is null or decision_state = 'awaiting_human')
         for update
      `;
      const approval = rows[0];
      if (!approval) throw new HttpError(409, "APPROVAL_NOT_PENDING", "Cette décision a déjà été traitée.");
      if (!runAwaitsAnswer(runs[0]) || (workflow && isWorkflowStopped(workflow.status))) {
        await tx`
          update approval_requests set status = 'expired', forward_state = 'expired', resolved_at = now()
           where organization_id = ${auth.organizationId} and id = ${approval.id}
        `;
        return { expired: false as const, inactive: true as const };
      }
      if (new Date(approval.expiresAt).getTime() <= Date.now()) {
        await tx`update approval_requests set status = 'expired', resolved_at = now() where id = ${approval.id}`;
        // Retourner puis lever APRÈS le commit : une exception ici annulerait
        // exactement la transition que le client vient de constater. Le worker
        // reconnaît aussi une gate déjà `expired` et passe par handleFailure :
        // c'est lui qui avance un salon ou livre l'échec d'un hand-off.
        return { expired: true as const, inactive: false as const };
      }
      // Snapshot bot/action/type dans l'enveloppe de la chaîne : supprimer le bot
      // annule les pointeurs live, et GET /decisions doit encore les afficher.
      const snapshots = await tx<Array<{ botId: string | null; botName: string | null; action: string | null }>>`
        select coalesce(r.bot_id, t.bot_id)::text as "botId",
               coalesce(b.name, '') as "botName",
               coalesce(a.command, '') as action
          from approval_requests a
          left join runs r on r.organization_id = a.organization_id and r.id = a.run_id
          left join threads t on t.organization_id = a.organization_id and t.id = a.thread_id
          left join bots b on b.organization_id = a.organization_id and b.id = coalesce(r.bot_id, t.bot_id)
         where a.organization_id = ${auth.organizationId} and a.id = ${approval.id}
      `;
      const snapshot = snapshots[0];
      // PERM2-4: "Always" is offered again at click time, or nothing is
      // decided. Its record lives in a savepoint: if it fails, the gate is
      // still answered `once` and `decision_detail.grantError` says so.
      let alwaysOutcome: { choice: ApprovalAlwaysChoice; saved: boolean; error?: string } | null = null;
      let alwaysDetail: Record<string, string> | null = null;
      if (always) {
        if (alwaysOffered(approval, auth) !== always) {
          throw new HttpError(409, "APPROVAL_ALWAYS_UNAVAILABLE", "« Toujours » n’est plus proposé pour cette demande : autorisez une fois ou refusez.");
        }
        const actor = { userId: auth.userId, kind: "member" as const, agencyOrganizationId: null };
        await tx`savepoint permission_always`;
        try {
          if (always === "always_bot_tool") {
            if (!snapshot?.botId || !approval.toolKey) throw new Error("PERMISSION_GRANT_TARGET_MISSING");
            const grant = await createBotPermissionGrantTx(tx, {
              organizationId: auth.organizationId, botId: snapshot.botId, toolKey: approval.toolKey, actor, approvalId: approval.id,
            });
            alwaysDetail = { always, grantId: grant.id };
          } else {
            const runtimeId = await activeRuntimeIdTx(tx, auth.organizationId);
            if (!runtimeId) throw new Error("RUNTIME_NOT_FOUND");
            const setting = await setTerminalDangerAlwaysTx(tx, { organizationId: auth.organizationId, runtimeId, value: true, actor });
            if (!setting) throw new Error("RUNTIME_NOT_FOUND");
            alwaysDetail = { always, runtimeSettingId: setting.id };
          }
          await tx`release savepoint permission_always`;
          alwaysOutcome = { choice: always, saved: true };
        } catch (error) {
          await tx`rollback to savepoint permission_always`;
          const code = alwaysErrorCode(error);
          alwaysDetail = { always, grantError: code };
          alwaysOutcome = { choice: always, saved: false, error: code };
          logEvent("approval.always_save_failed", { approvalId: approval.id, choice: always, code });
        }
      }
      const envelope = {
        version: 1 as const,
        organizationId: auth.organizationId,
        approvalRequestId: approval.id,
        threadId: approval.threadId,
        runId: approval.runId,
        actorUserId: auth.userId,
        choice: decided,
        occurredAt: new Date().toISOString(),
        botId: snapshot?.botId ?? null,
        botName: snapshot?.botName || null,
        action: snapshot?.action ?? "",
        kind: approvalKind(approval),
        ...(alwaysDetail?.grantId ? { grantId: alwaysDetail.grantId } : {}),
        ...(alwaysDetail?.runtimeSettingId ? { runtimeSettingId: alwaysDetail.runtimeSettingId } : {}),
      };
      // PERM2-1: a pipeline gate records who answered it; its stage keeps why
      // it came to a human. The forwarding claim re-checks the interdictions
      // of a human `once` before Hermes receives it.
      await tx`
        update approval_requests set status = ${decided === "deny" ? "denied" : "approved"},
          selected_choice = ${decided}, resolved_at = now(), resolved_by = ${auth.userId},
          decided_by_kind = case when decision_state is null then null
            else ${auth.actingFleetId ? "agency" : "member"} end,
          decision_state = case when decision_state is null then null else 'decided' end,
          decision_detail = case when decision_state is null or ${alwaysDetail === null} then decision_detail
            else coalesce(decision_detail, '{}'::jsonb) || ${alwaysDetail ?? {}}::jsonb end
         where id = ${approval.id}
      `;
      const decision = await appendDecisionTx(tx, {
        organizationId: auth.organizationId,
        threadId: approval.threadId,
        runId: approval.runId,
        approvalRequestId: approval.id,
        actorUserId: auth.userId,
        choice: decided,
        envelope,
      });
      return { expired: false as const, inactive: false as const, decision, always: alwaysOutcome };
    });
    if (result.inactive) {
      throw new HttpError(409, "APPROVAL_RUN_NOT_ACTIVE", "Le run associé n’attend plus cette autorisation.");
    }
    if (result.expired) {
      throw new HttpError(409, "APPROVAL_EXPIRED", "Cette demande d’autorisation a expiré.");
    }
    const response: ApprovalRespondDto = { decision: result.decision, ...(result.always ? { always: result.always } : {}) };
    return context.json(response, 202);
  });
  return routes;
}

/**
 * The run can still take this answer: it waits at the gate, or it is being
 * resumed after its worker lost the lease (requeued after a transient link
 * failure, or claimed and not yet reattached) with its Hermes run still
 * parked at the gate. The resume puts an answered, unforwarded gate back in
 * `awaiting_approval` and forwards it. Measured 2026-10-31: a worker restart
 * left a gated run `queued` for 46 s; « Refuser » then expired the gate as
 * inactive, nothing reached Hermes, and the run stayed parked until the
 * next message stopped it.
 */
export function runAwaitsAnswer(run: { status: string; hermesRunId: string | null } | undefined): boolean {
  if (!run) return false;
  if (run.status === "awaiting_approval") return true;
  return (run.status === "queued" || run.status === "starting") && run.hermesRunId !== null;
}

function isWorkflowStopped(status: string): boolean {
  return ["completed", "failed", "cancelled", "expired", "unknown"].includes(status);
}
