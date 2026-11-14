import type { BotDto, RoutineDto, RoutineExecutionPageDto, RoutineRunAcceptedDto, RuntimeGatewayStatusDto } from "@openedbot/contracts-api";
import type { Scenario, ScenarioContext } from "../kit/scenario";
import { completed, invariant, keyedPost, noTools, poll, readyBot, restartIdleGateway, settledWorkflow, toolset, type Workflow } from "../kit/p1-evidence";
import { recoveryRun } from "../kit/recovery-runs";

type RoutineGate = { status: string; remoteId: string | null; gateId: string | null; requestId: string | null; tool: string | null };

/** A short provider reply must never turn a cancellation test into a timing race. */
export async function waitRoutineCancellationGate(context: ScenarioContext, runId: string): Promise<RoutineGate> {
  return poll(async () => {
    const [row] = await context.lab.db<RoutineGate[]>`
      select r.status, r.hermes_run_id as "remoteId", gate.id as "gateId",
             gate.hermes_request_id as "requestId", gate.tool_key as tool
        from runs r left join lateral (
          select id, hermes_request_id, tool_key from approval_requests
           where organization_id = r.organization_id and run_id = r.id and status = 'pending'
           order by gate_ordinal limit 1
        ) gate on true
       where r.organization_id = ${context.session.organizationId} and r.id = ${runId}`;
    invariant(row, "The owned routine run disappeared before cancellation.");
    invariant(!["completed", "failed", "cancelled", "unknown"].includes(row.status),
      `Routine ended ${row.status} before the identified cancellation gate.`);
    return row;
  }, (row) => ["running", "awaiting_approval"].includes(row.status)
    && Boolean(row.remoteId && row.gateId && row.requestId) && row.tool === "execute_code",
  context.config.runTimeoutMs, "Active routine execute_code approval gate");
}

export const routines: Scenario = {
  id: "routines",
  title: "Routines openedbot : horloge, rejeu et annulation",
  summary: "Le scheduler openedbot déclenche une occurrence visible, un lancement rejoué conserve son identité et l'annulation libère le fil sans redéclenchement après pause.",
  async run(context) {
    const { session, lab, rec, config } = context;
    const proof = `ROUTINE_${crypto.randomUUID().replaceAll("-", "")}`;
    let bot!: BotDto;
    let routine: RoutineDto | undefined;
    let activeWorkflow: string | undefined;
    const executions = () => session.api<RoutineExecutionPageDto>("GET", `/api/routines/${routine!.id}/executions?limit=100`);
    try {
      await rec.step("Bot et routine de test sur l'horloge openedbot", async () => {
        bot = await readyBot(context, "E2E Routine");
        await noTools(session, bot);
        routine = await session.api<RoutineDto>("POST", `/api/bots/${bot.id}/routines`, { name: `E2E ${lab.tag}`, schedule: "* * * * *", timezone: "UTC", message: `Reply exactly ${proof}. No tools, no delegation.`, enabled: true }, 201);
        invariant(routine.enabled && routine.nextRunAt, "The routine has no scheduled occurrence.");
        return { routineId: routine.id, nextRunAt: routine.nextRunAt };
      });
      await rec.step("Une occurrence planifiée, un résultat dans le fil", async () => {
        const page = await poll(executions, (value) => value.executions.some((entry) => entry.trigger === "scheduled" && entry.outcome === "fired"), config.runTimeoutMs, "Scheduled openedbot occurrence");
        // Freeze the cadence before the next minute; only our routine is changed.
        routine = await session.api<RoutineDto>("PATCH", `/api/routines/${routine!.id}`, { enabled: false });
        invariant(!routine.enabled && routine.nextRunAt === null, "The routine was not paused.");
        const scheduled = page.executions.filter((entry) => entry.trigger === "scheduled" && entry.outcome === "fired");
        invariant(scheduled.length === 1 && scheduled[0]?.runId && scheduled[0].workflowId, "The scheduled slot produced no unique run/workflow.");
        activeWorkflow = scheduled[0].workflowId;
        const state = await settledWorkflow(context, activeWorkflow);
        invariant(state.status === "completed", `Scheduled workflow ended ${state.status}.`);
        completed(await lab.follow(scheduled[0].runId, Date.now()), proof);
        invariant(await lab.answered(bot.threadId, scheduled[0].runId), "The routine's answer is absent from the bot thread.");
        activeWorkflow = undefined;
        return { runId: scheduled[0].runId, trigger: "scheduled", scheduledOccurrences: scheduled.length };
      });
      await rec.step("Réponse perdue : même clé, même occurrence", async () => {
        const key = crypto.randomUUID();
        const path = `/api/routines/${routine!.id}/runs`;
        const first = await keyedPost<RoutineRunAcceptedDto>(session, path, key);
        activeWorkflow = first.body.workflowId;
        const replay = await keyedPost<RoutineRunAcceptedDto>(session, path, key);
        invariant(replay.replayed && first.body.runId === replay.body.runId && first.body.workflowId === replay.body.workflowId, "Replaying a routine launch created a second occurrence.");
        const state = await settledWorkflow(context, first.body.workflowId);
        invariant(state.status === "completed", `Manual workflow ended ${state.status}.`);
        completed(await lab.follow(first.body.runId, Date.now()), proof);
        const page = await executions();
        const manual = page.executions.filter((entry) => entry.trigger === "manual" && entry.runId === first.body.runId);
        invariant(manual.length === 1, "The idempotent manual occurrence has duplicate execution receipts.");
        activeWorkflow = undefined;
        return { runId: first.body.runId, replayed: true, receipts: manual.length };
      });
      await rec.step("Annulation d'une occurrence et reprise du fil", async () => {
        invariant(session.hasFeature("approval_policy"), "Routine cancellation needs a real manual approval gate.");
        await session.api("PATCH", `/api/bots/${bot.id}`, {
          permissionMode: "manual", instructions: "Follow the requested execute_code call exactly once. Do not answer before attempting that tool. Never retry a refused tool.",
        });
        await toolset(session, bot, "code_execution", true);
        if (session.hasFeature("gateway_restart")) {
          const gateway = await session.api<RuntimeGatewayStatusDto>("GET", "/api/runtime/integrations/gateway");
          if (gateway.restartPending) await restartIdleGateway(context, [bot.id]);
        }
        await poll(async () => {
          const [policy] = await lab.db<Array<{ mode: string; effective: Date | null }>>`
            select approval_policy_mode as mode, approval_policy_effective_at as effective from bots
             where id = ${bot.id} and organization_id = ${session.organizationId}`;
          return policy;
        }, (policy) => policy?.mode === "ask_writes" && Boolean(policy.effective), config.runTimeoutMs, "Owned routine manual policy");
        routine = await session.api<RoutineDto>("PATCH", `/api/routines/${routine!.id}`, {
          enabled: false, neverWait: false,
          message: `Call execute_code exactly once with Python code print(${JSON.stringify(`CANCEL_${lab.tag}`)}). No other tool. Wait for the tool result before answering.`,
        });
        invariant(!routine.enabled && !routine.neverWait, "The owned cancellation routine must stay paused and allow an approval gate.");
        const started = await keyedPost<RoutineRunAcceptedDto>(session, `/api/routines/${routine!.id}/runs`, crypto.randomUUID());
        activeWorkflow = started.body.workflowId;
        const gate = await waitRoutineCancellationGate(context, started.body.runId);
        await session.api("POST", `/api/workflows/${activeWorkflow}/cancel`, undefined, 204);
        const state = await settledWorkflow(context, activeWorkflow);
        invariant(state.status === "cancelled", `The cancelled occurrence ended ${state.status}.`);
        const pending = await lab.db<Array<{ id: string }>>`select id from runs where organization_id = ${session.organizationId} and workflow_id = ${activeWorkflow}
          and status in ('queued','starting','running','awaiting_approval','relaying','unknown')`;
        invariant(pending.length === 0, "Cancellation left an unsettled routine run.");
        const cancelled = await recoveryRun(context, started.body.runId);
        invariant(cancelled.status === "cancelled" && cancelled.remoteStopState === "confirmed",
          "The active routine cancellation was not confirmed by Hermes.");
        activeWorkflow = undefined;
        await noTools(session, bot);
        await session.api("PATCH", `/api/bots/${bot.id}`, { instructions: "Do not call any tool. Reply exactly with the requested marker." });
        const next = `AFTER_CANCEL_${lab.tag}`;
        completed(await lab.send(bot.threadId, `No tools. Reply exactly ${next}.`), next);
        return { cancelled: true, gateId: gate.gateId, activeBeforeCancel: gate.status, remoteStopConfirmed: true, nextMessageCompleted: true };
      });
      await rec.step("La pause tient au-delà du créneau suivant", async () => {
        const deadline = Math.floor(Date.now() / 60_000) * 60_000 + 62_000;
        const before = (await executions()).executions.filter((entry) => entry.trigger === "scheduled").length;
        await poll(async () => {
          const count = (await executions()).executions.filter((entry) => entry.trigger === "scheduled").length;
          invariant(count === before, "A paused routine fired again.");
          return Date.now() >= deadline;
        }, Boolean, Math.min(config.runTimeoutMs, deadline - Date.now() + 2_000), "Paused routine observation");
        return { scheduledExecutions: before, crossedNextMinute: true };
      });
    } finally {
      try {
        if (activeWorkflow) {
          await session.api("POST", `/api/workflows/${activeWorkflow}/cancel`, undefined, 204);
          await poll(() => session.api<Workflow>("GET", `/api/workflows/${activeWorkflow}`), (state) => state.status === "cancelled" || state.status === "completed" || state.status === "failed" || state.status === "expired", config.runTimeoutMs, "Owned routine cancellation");
        }
      } finally { if (routine) await session.api("DELETE", `/api/routines/${routine.id}`, undefined, 204); }
    }
  },
};
