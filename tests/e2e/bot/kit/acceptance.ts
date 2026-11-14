import type { BotDto } from "@openedbot/contracts-api";
import type { ScenarioContext } from "./scenario";
import type { Turn } from "./bots";
import type { SQL } from "bun";

export function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function waitUntil<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`${label} did not reach the expected state within ${timeoutMs} ms.`);
}

export function completed(turn: Turn, expected?: string): void {
  const failure = turn.marks?.terminalPayload;
  requireEvidence(turn.run?.status === "completed", `Run ${turn.runId} ended ${turn.run?.status ?? "without persistence"}: ${String(failure?.errorCode ?? "")} ${String(failure?.message ?? "").slice(0, 200)}.`);
  requireEvidence(turn.marks?.terminalType === "run.completed" && turn.marks.terminalEvents === 1, `Run ${turn.runId} needs exactly one completed SSE terminal.`);
  if (expected) requireEvidence(turn.run.output?.includes(expected), `Run ${turn.runId} did not return the expected test marker.`);
}

/** Only disposable profile changes. No global permission or model preference writes. */
export async function preparedBot(context: ScenarioContext, name: string, instructions = "Follow the test instructions precisely. Reply concisely."): Promise<BotDto> {
  const { lab, session, model } = context;
  requireEvidence(session.hasFeature("profile_management"), "profile_management is required for disposable acceptance bots.");
  const bot = await lab.create({ name, instructions, greet: false, provider: model.provider, model: model.model, permissionMode: "manual" });
  const provision = await lab.waitProvision(bot.id);
  requireEvidence(provision.status === "succeeded", `Profile provision ended ${provision.status}.`);
  return bot;
}

/** Without an explicit dedicated-lab reservation, all visible tenants block a restart. */
export async function unsettledRunCount(db: SQL, organizationId: string, exceptBotId: string | null, exclusiveRuntime: boolean): Promise<number> {
  const rows = await db<Array<{ count: number }>>`
    select count(*)::int as count from runs
     where (${!exclusiveRuntime} or organization_id = ${organizationId})
       and (${exceptBotId}::uuid is null or bot_id is distinct from ${exceptBotId}::uuid)
       and status in ('queued', 'starting', 'running', 'awaiting_approval', 'relaying', 'unknown')`;
  requireEvidence(typeof rows[0]?.count === "number", "The runtime work inventory is unavailable.");
  return rows[0].count;
}

/** A reservation cannot bypass active work belonging to this runtime. */
export async function requireNoForeignRuns(context: ScenarioContext, botId: string): Promise<void> {
  const count = await unsettledRunCount(context.lab.db, context.session.organizationId, botId, context.config.exclusiveRuntime);
  requireEvidence(count === 0, "Runtime fault refused: other bots have active or ambiguous work.");
}
