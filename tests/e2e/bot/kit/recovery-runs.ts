import { createHash } from "node:crypto";
import { SQL } from "bun";
import type { BotDto, RuntimeGatewayRestartDto, RuntimeGatewayStatusDto } from "@openedbot/contracts-api";
import { preparedBot, requireEvidence, requireNoForeignRuns, waitUntil } from "./acceptance";
import type { ScenarioContext } from "./scenario";

export type RecoveryRun = {
  id: string; status: string; remoteId: string | null; externalState: string;
  remoteStopState: string | null; errorCode: string | null; workflowId: string | null;
};
export type HeldRun = { runId: string; gateId: string; remoteId: string; t0: number };
const KNOWN_TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function recoveryRun(context: ScenarioContext, runId: string): Promise<RecoveryRun> {
  const [row] = await context.lab.db<RecoveryRun[]>`
    select id, status, hermes_run_id as "remoteId", external_state as "externalState",
           remote_stop_state as "remoteStopState", error_code as "errorCode", workflow_id as "workflowId"
      from runs where id = ${runId} and organization_id = ${context.session.organizationId}`;
  requireEvidence(row, `Recovery run ${runId} disappeared.`);
  return row;
}

export async function gatewayStatus(context: ScenarioContext): Promise<RuntimeGatewayStatusDto> {
  return context.session.api("GET", "/api/runtime/integrations/gateway");
}

export async function finishGatewayRestart(context: ScenarioContext, job: RuntimeGatewayRestartDto): Promise<void> {
  const result = await waitUntil("Gateway restart", async () => context.session.api<RuntimeGatewayRestartDto>(
    "GET", `/api/runtime/integrations/gateway/restart/${job.jobId}`), (value) => value.status !== "running", context.config.cleanupTimeoutMs);
  requireEvidence(result.status === "ok", `Gateway restart ended ${result.status}: ${result.error ?? "no error code"}.`);
}

/** A real, harmless gated tool call keeps the run active until the test decides. */
export async function recoveryBot(context: ScenarioContext, name: string): Promise<BotDto> {
  requireEvidence(context.session.hasFeature("approval_policy"), "approval_policy is required to hold a real recovery run.");
  const bot = await preparedBot(context, name, "Follow the requested tool call exactly once. Never retry a refused tool. A refused print is harmless; then return the requested marker.");
  const enabled = await context.session.api<{ applied: boolean; enabled: boolean }>(
    "POST", `/api/bots/${bot.id}/capabilities/toolsets/code_execution`, { enabled: true });
  requireEvidence(enabled.applied && enabled.enabled, "The code_execution toolset was not applied to the disposable profile.");
  if ((await gatewayStatus(context)).restartPending) {
    await requireNoForeignRuns(context, bot.id);
    const job = await context.session.api<RuntimeGatewayRestartDto>("POST", "/api/runtime/integrations/gateway/restart", undefined, 202);
    await finishGatewayRestart(context, job);
  }
  await waitUntil("Manual approval policy", async () => {
    const [policy] = await context.lab.db<Array<{ mode: string; effective: Date | null }>>`
      select approval_policy_mode as mode, approval_policy_effective_at as effective from bots where id = ${bot.id}`;
    return policy;
  }, (policy) => policy?.mode === "ask_writes" && Boolean(policy.effective), context.config.runTimeoutMs);
  return bot;
}

export async function holdRecoveryRun(context: ScenarioContext, bot: BotDto, marker: string): Promise<HeldRun> {
  const t0 = Date.now();
  const { runId } = await context.session.api<{ runId: string }>("POST", `/api/threads/${bot.threadId}/messages`, {
    input: `Call execute_code exactly once with Python code print(${JSON.stringify(marker)}). Do not use another tool. After the tool result, including a refusal, reply exactly ${marker}.`,
  }, 202);
  const gate = await waitUntil("Real identified approval gate", async () => {
    const run = await recoveryRun(context, runId);
    requireEvidence(!KNOWN_TERMINAL.has(run.status) && run.status !== "unknown", `Recovery run ended ${run.status} before its gate.`);
    const [approval] = await context.lab.db<Array<{ id: string; requestId: string | null; tool: string | null }>>`
      select id, hermes_request_id as "requestId", tool_key as tool from approval_requests
       where run_id = ${runId} and status = 'pending' order by gate_ordinal limit 1`;
    return { run, approval };
  }, ({ run, approval }) => Boolean(run.remoteId && approval?.requestId && approval.tool), context.config.runTimeoutMs);
  requireEvidence(gate.run.remoteId && gate.approval?.id, "Held run has no remote identity or gate.");
  return { runId, gateId: gate.approval.id, remoteId: gate.run.remoteId, t0 };
}

export async function denyHeldRun(context: ScenarioContext, held: HeldRun): Promise<void> {
  await context.session.api("POST", `/api/approvals/${held.gateId}/respond`, { choice: "deny" }, 202);
}

export async function settledRecoveryRun(context: ScenarioContext, held: HeldRun): Promise<RecoveryRun> {
  return waitUntil("Recovery run settlement", () => recoveryRun(context, held.runId),
    (run) => KNOWN_TERMINAL.has(run.status), context.config.runTimeoutMs);
}

export async function proveRecoveryDispatch(context: ScenarioContext, held: HeldRun): Promise<{ dispatches: number; terminalEvents: number }> {
  const run = await recoveryRun(context, held.runId);
  requireEvidence(run.remoteId === held.remoteId, "Recovery changed the remote run identity.");
  const hash = createHash("sha256").update(held.runId).digest("hex");
  // The worker intentionally cannot read broker audit rows (migration 0080).
  // Use the API role with tenant RLS instead of widening worker privileges.
  requireEvidence(context.config.auditDatabaseUrl, "Broker evidence requires API_DATABASE_URL or E2E_AUDIT_DATABASE_URL.");
  const audit = new SQL({ url: context.config.auditDatabaseUrl, max: 1, connectionTimeout: 5 });
  let dispatches: Array<{ remoteId: string | null; status: number | null }>;
  try {
    dispatches = await audit.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${context.session.organizationId}, true)`;
      return tx<Array<{ remoteId: string | null; status: number | null }>>`
        select remote_id as "remoteId", status from runtime_link_dispatches
         where organization_id = ${context.session.organizationId} and runtime_id = ${context.session.runtime.id}
           and idempotency_key_hash = ${hash}`;
    });
  } finally { await audit.close(); }
  requireEvidence(dispatches.length === 1 && dispatches[0]?.remoteId === held.remoteId,
    "The broker journal must contain exactly one primary creation dispatch with the held remote identity.");
  const terminal = await context.lab.db<Array<{ count: number }>>`
    select count(*)::int as count from run_events where run_id = ${held.runId} and type in ('run.completed', 'run.error')`;
  requireEvidence(terminal[0]?.count === 1, "Recovery needs exactly one persisted terminal event.");
  await context.lab.events.waitTerminal(held.runId, context.config.runTimeoutMs);
  requireEvidence(context.lab.events.marksOf(held.runId).terminalEvents === 1, "Recovery needs exactly one observed SSE terminal.");
  return { dispatches: dispatches.length, terminalEvents: terminal[0].count };
}

export async function proveSsePersistence(context: ScenarioContext, runId: string): Promise<number> {
  const persisted = await context.lab.db<Array<{ sequence: number; type: string }>>`
    select sequence, type from run_events where run_id = ${runId} order by sequence`;
  const observed = context.lab.events.eventsOf(runId).map(({ sequence, type }) => ({ sequence, type }));
  requireEvidence(JSON.stringify(persisted) === JSON.stringify(observed), "Reconnected SSE differs from the persisted event sequence.");
  return observed.length;
}

/** Failure cleanup only: never called between a fault and its next-message assertion. */
export async function cleanRecoveryBot(context: ScenarioContext, bot: BotDto): Promise<void> {
  // The lab rechecks the full workflow/courier ownership and handles a run
  // becoming unknown during cancellation, before proving host removal.
  const result = await context.lab.purge(bot.id);
  requireEvidence(result.cleanup === "succeeded", `Recovery profile cleanup ended ${result.cleanup}.`);
}
