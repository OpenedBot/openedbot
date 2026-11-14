import type { BotCapabilitiesDto, BotDto, GroupDto, RuntimeGatewayRestartDto, RuntimeGatewayStatusDto } from "@openedbot/contracts-api";
import type { ScenarioContext } from "./scenario";
import type { Session } from "./session";
import type { Turn } from "./bots";
import { unsettledRunCount } from "./acceptance";

export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function completed(turn: Turn, expected?: string): string {
  const code = turn.marks?.terminalPayload?.errorCode;
  const diagnostic = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? `; ${code}` : "";
  invariant(turn.run?.status === "completed" && turn.marks?.terminalType === "run.completed" && turn.marks.terminalEvents === 1, `Run ${turn.runId} did not complete (${turn.run?.status ?? "missing"}${diagnostic}).`);
  const output = turn.run.output?.trim() ?? "";
  invariant(output.length > 0, `Run ${turn.runId} has no persisted output.`);
  if (expected !== undefined) invariant(output === expected, `Run ${turn.runId} did not return the exact fixture result.`);
  return output;
}

export async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) break;
    await Bun.sleep(Math.min(300, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error(`${label} did not settle within ${timeoutMs} ms.`);
}

export type ToolEvent = { type: string; payload: { tool?: string; toolCallId?: string; error?: boolean; resultExcerpt?: string | null; reason?: string; kind?: string } };
export function matchingToolResult(events: readonly ToolEvent[], tool: string, failed = false): ToolEvent {
  const calls = new Set<string>();
  for (const event of events) {
    if (event.payload.tool !== tool || typeof event.payload.toolCallId !== "string") continue;
    if (event.type === "tool.call") calls.add(event.payload.toolCallId);
    if (event.type === "tool.result" && event.payload.error === failed && calls.has(event.payload.toolCallId)) return event;
  }
  throw new Error(`No paired ${failed ? "failed" : "successful"} ${tool} call/result was persisted in call-before-result order.`);
}

export async function toolEvents(context: ScenarioContext, runId: string): Promise<ToolEvent[]> {
  return context.lab.db<ToolEvent[]>`select type, payload from run_events where organization_id = ${context.session.organizationId} and run_id = ${runId} order by sequence`;
}

export async function capabilities(session: Session, bot: BotDto): Promise<BotCapabilitiesDto> {
  const result = await session.api<BotCapabilitiesDto>("GET", `/api/bots/${bot.id}/capabilities`);
  invariant(result.scope === "profile" && result.hermesProfile === bot.hermesProfile && !result.inventoryError, "A readable, isolated profile inventory is required.");
  return result;
}

export async function toolset(session: Session, bot: BotDto, name: string, enabled: boolean): Promise<void> {
  const response = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/toolsets/${encodeURIComponent(name)}`, { enabled });
  invariant(response.enabled === enabled && response.applied, `Toolset ${name} was not applied to the owned profile.`);
}

export async function readyBot(context: ScenarioContext, name: string, instructions = "Follow the acceptance test exactly. Never invent a fixture value. Answer concisely."): Promise<BotDto> {
  const bot = await context.lab.create({ name, instructions, permissionMode: "bypass", greet: false });
  const provision = await context.lab.waitProvision(bot.id);
  invariant(provision.status === "succeeded", `Owned profile provision ended ${String(provision.status)}.`);
  await context.lab.setModel(bot, context.model);
  invariant(bot.hermesProfile, "A named profile is required.");
  return bot;
}

export async function noTools(session: Session, bot: BotDto): Promise<void> {
  // An empty platform list can expose another upstream composite toolset
  // (notably x_search). Verify a bounded fixed point before enabling a fixture.
  for (let pass = 0; pass <= 3; pass++) {
    const inventory = await capabilities(session, bot);
    invariant(inventory.toolsets !== null && inventory.mcpServers !== null, "Toolset or MCP inventory is unavailable.");
    const enabled = inventory.toolsets.filter((entry) => entry.enabled);
    const mcp = inventory.mcpServers.filter((entry) => entry.enabled);
    if (!enabled.length && !mcp.length) return;
    invariant(pass < 3, `Profile tools did not converge to disabled: ${JSON.stringify({ toolsets: enabled.map((entry) => entry.name), mcp: mcp.map((entry) => entry.name) })}`);
    for (const entry of enabled) await toolset(session, bot, entry.name, false);
    for (const entry of mcp) {
      const response = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/mcp/${encodeURIComponent(entry.name)}`, { enabled: false });
      invariant(response.applied && !response.enabled, `MCP ${entry.name} was not disabled.`);
    }
  }
}

export async function ownGroup(session: Session, name: string, bots: BotDto[]): Promise<GroupDto> {
  invariant(bots.length >= 2, "An owned group requires two bots.");
  return session.api<GroupDto>("POST", "/api/groups", { name, memberIds: bots.map((bot) => bot.id), defaultResponder: { kind: "member", botId: bots[0]!.id } }, 201);
}

export async function deleteGroup(session: Session, id: string): Promise<void> {
  await session.api("POST", `/api/threads/${(await session.api<GroupDto>("GET", `/api/groups/${id}`)).threadId}/stop`, undefined, 204);
  const group = await session.api<GroupDto>("GET", `/api/groups/${id}`);
  await poll(() => session.api<{ runs: Array<{ status: string }> }>("GET", `/api/threads/${group.threadId}`),
    (value) => value.runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status)), 60_000, "Owned group cancellation");
  await session.api("DELETE", `/api/groups/${id}`, undefined, 204);
}

export async function restartIdleGateway(context: ScenarioContext, ownedBotIds: string[]): Promise<void> {
  invariant(context.session.hasFeature("gateway_restart"), "The runtime does not advertise gateway_restart.");
  const active = await unsettledRunCount(context.lab.db, context.session.organizationId, null, context.config.exclusiveRuntime);
  // Even owned work must settle before a restart. Never interrupt unrelated operators.
  invariant(active === 0, `Gateway restart refused: ${active} unsettled database run(s), owned bots ${ownedBotIds.length}.`);
  const before = await context.session.api<RuntimeGatewayStatusDto>("GET", "/api/runtime/integrations/gateway");
  invariant(before.activeSince !== null && Number.isFinite(Date.parse(before.activeSince)), "The gateway has no readable start timestamp before restart.");
  const job = await context.session.api<RuntimeGatewayRestartDto>("POST", "/api/runtime/integrations/gateway/restart", undefined, 202);
  const result = await poll(() => context.session.api<RuntimeGatewayRestartDto>("GET", `/api/runtime/integrations/gateway/restart/${encodeURIComponent(job.jobId)}`), (value) => value.status !== "running", context.config.runTimeoutMs, "Gateway restart");
  invariant(result.status === "ok", `Gateway restart ended ${result.status}.`);
  const after = await context.session.api<RuntimeGatewayStatusDto>("GET", "/api/runtime/integrations/gateway");
  invariant(after.activeSince !== null && Number.isFinite(Date.parse(after.activeSince))
    && Date.parse(after.activeSince) > Date.parse(before.activeSince), "The gateway restart job succeeded but its start timestamp did not advance.");
}

export async function keyedPost<T>(session: Pick<Session, "baseUrl" | "streamHeaders">, path: string, key: string, body?: unknown, expected = 202, timeoutMs = 60_000): Promise<{ body: T; replayed: boolean }> {
  const response = await fetch(`${session.baseUrl}${path}`, { method: "POST", redirect: "error", headers: { ...session.streamHeaders(), "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
  invariant(response.status === expected, `${path.split("?")[0]} answered ${response.status}, expected ${expected}.`);
  return { body: await response.json() as T, replayed: response.headers.get("Idempotency-Replayed") === "true" };
}

export type Workflow = { id: string; status: string; errorCode: string | null; usedSteps: number; usedHandoffs: number; endedAt?: string | null };
export const terminalWorkflow = (value: Workflow): boolean => ["completed", "failed", "expired", "cancelled", "unknown"].includes(value.status);
export async function settledWorkflow(context: ScenarioContext, workflowId: string): Promise<Workflow> {
  return poll(() => context.session.api<Workflow>("GET", `/api/workflows/${workflowId}`), terminalWorkflow, context.config.runTimeoutMs, `Workflow ${workflowId}`);
}
