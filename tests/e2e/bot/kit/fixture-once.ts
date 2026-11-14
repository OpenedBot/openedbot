import type { BotDto } from '@openedbot/contracts-api';
import type { Turn } from './bots';
import type { ScenarioContext } from './scenario';
import { requireFixtureGate, requireFixtureOnceScope, type FixtureGate, type FixtureOnceScope } from './fixture-once-scope';

type BoundRun = { id: string; organizationId: string; botId: string | null; threadId: string; status: string; remoteId: string | null };
export type FixtureOnceTurn = Turn & { fixtureApprovals: number; fixtureGateForwardConfirmed: boolean };
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);

/** One identified fixture call may receive once. Never grants, session approval or a second request. */
export async function sendFixtureOnce(context: ScenarioContext, bot: BotDto, threadId: string, input: string, scope: FixtureOnceScope): Promise<FixtureOnceTurn> {
  return sendGuardedFixture(context, bot, threadId, input, scope);
}

/** Revocation probes fail on any gate; this path never sends an approval response. */
export async function sendFixtureWithoutApproval(context: ScenarioContext, bot: BotDto, threadId: string, input: string): Promise<FixtureOnceTurn> {
  return sendGuardedFixture(context, bot, threadId, input, null);
}

async function sendGuardedFixture(context: ScenarioContext, bot: BotDto, threadId: string, input: string, scope: FixtureOnceScope | null): Promise<FixtureOnceTurn> {
  const { session, lab, config } = context;
  if (scope) requireFixtureOnceScope(scope, bot, session.runtime.id);
  else if (!bot.hermesProfile || !bot.hermesProfileManaged) throw new Error('A managed disposable profile is required for the no-approval fixture turn.');
  const t0 = Date.now(), deadline = t0 + config.runTimeoutMs;
  const { runId } = await session.api<{ runId: string }>('POST', `/api/threads/${threadId}/messages`, { input }, 202);
  const acceptedMs = Date.now() - t0;
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error('Fixture admission returned no safe run identity.');
  const binding = { organizationId: session.organizationId, botId: bot.id, threadId, runId };
  let owned = false, lastStatus = '', attemptedGate: string | null = null, requestId: string | null = null;
  let fixtureApprovals = 0, fixtureGateForwardConfirmed = false, settled = false;
  try {
    do {
      let answeredNow = false;
      const [run] = await lab.db<BoundRun[]>`
        select id, organization_id as "organizationId", bot_id as "botId", thread_id as "threadId",
               status, hermes_run_id as "remoteId" from runs
         where id = ${runId} and organization_id = ${session.organizationId}`;
      if (!run || run.id !== runId || run.organizationId !== binding.organizationId || run.botId !== bot.id || run.threadId !== threadId) {
        throw new Error('Fixture run organization/bot/thread binding differs; no approval or foreign cancellation is allowed.');
      }
      owned = true; lastStatus = run.status;
      if (run.status === 'unknown') throw new Error(`Fixture run ${runId} is ambiguous; no approval retry is allowed.`);
      const gates = await lab.db<FixtureGate[]>`
        select a.id, a.organization_id as "organizationId", r.bot_id as "botId", a.thread_id as "threadId", a.run_id as "runId",
               a.hermes_request_id as "hermesRequestId", a.gate_kind as "gateKind", a.tool_key as "toolKey",
               a.descriptor_version as "descriptorVersion", a.gate_args as "gateArgs", a.status,
               a.forward_state as "forwardState", a.selected_choice as "selectedChoice", a.decision_state as "decisionState"
          from approval_requests a join runs r on r.organization_id = a.organization_id and r.id = a.run_id
         where a.run_id = ${runId} and a.organization_id = ${session.organizationId} order by a.gate_ordinal`;
      if (gates.length > 1) throw new Error('A fixture call raised duplicate/additional gates; a second once approval is forbidden.');
      const gate = gates[0];
      if (gate) {
        if (!scope) throw new Error('The revoked fixture turn raised an approval gate; no approval is allowed.');
        requireFixtureGate(gate, binding, scope);
        if (attemptedGate && (gate.id !== attemptedGate || gate.hermesRequestId !== requestId)) throw new Error('The fixture gate changed identity after once was sent.');
        if (gate.selectedChoice !== null && gate.selectedChoice !== 'once') throw new Error('The fixture gate was decided with a non-once choice.');
        if (['failed', 'ambiguous', 'expired'].includes(gate.forwardState)) throw new Error(`Fixture approval forwarding is ${gate.forwardState}.`);
        fixtureGateForwardConfirmed = gate.forwardState === 'confirmed' && gate.selectedChoice === 'once';
        if (!TERMINAL.has(run.status) && gate.status === 'pending' && gate.forwardState === 'pending' && gate.selectedChoice === null
          && (gate.decisionState === null || gate.decisionState === 'awaiting_human')) {
          if (attemptedGate) throw new Error('The fixture once response is unconfirmed; refusing a second mutation.');
          if (!run.remoteId) throw new Error('An identified fixture gate has no remote run identity.');
          attemptedGate = gate.id; requestId = gate.hermesRequestId; fixtureApprovals++;
          const answered = await session.api<{ always?: unknown }>('POST', `/api/approvals/${gate.id}/respond`, { choice: 'once' }, 202);
          if (answered?.always !== undefined) throw new Error('The fixture once response unexpectedly contains a durable grant outcome.');
          answeredNow = true;
        }
      } else if (attemptedGate) throw new Error('The fixture gate disappeared before its forwarding was confirmed.');
      if (TERMINAL.has(run.status) && (!gate || fixtureGateForwardConfirmed)) { settled = true; break; }
      if (answeredNow) continue;
      if (Date.now() < deadline) await Bun.sleep(Math.min(200, deadline - Date.now()));
    } while (Date.now() < deadline);
    if (!settled) throw new Error(`Fixture run ${runId} did not settle with confirmed once forwarding within ${config.runTimeoutMs} ms.`);
    const marks = await lab.events.waitTerminal(runId, Math.max(1, deadline - Date.now()));
    if (!marks) throw new Error('The fixture run has no observed terminal before the deadline.');
    return { runId, t0, acceptedMs, marks, run: await lab.run(runId), fixtureApprovals, fixtureGateForwardConfirmed };
  } catch (failure) {
    // Rejecting a gate never leaves an accidentally approved second action
    // running. This cancellation is limited to the independently bound run.
    if (owned && !TERMINAL.has(lastStatus)) {
      try { await session.api('POST', `/api/runs/${runId}/cancel`, undefined, 204); }
      catch (cleanup) {
        const reason = failure instanceof Error ? failure.message : 'Fixture action failed.';
        throw new AggregateError([failure, cleanup], `${reason} Cancellation of its owned run was also not confirmed.`);
      }
    }
    throw failure;
  }
}
