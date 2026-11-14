import type { BotDto, MessageContent } from "@openedbot/contracts-api";
import { turnFailure, type Turn } from "./bots";
import type { ScenarioContext } from "./scenario";

export type ToolEvent = { type: string; payload: Record<string, unknown> };

/** A named successful pair is required; an unrelated tool or a final claim is insufficient. */
export function successfulTool(events: readonly ToolEvent[], tool: string, resultIncludes?: string): number {
  const calls = new Set<string>();
  const successfulResults = new Set<string>();
  const succeeded = new Set<string>();
  for (const event of events) {
    const id = event.payload.toolCallId;
    if (event.payload.tool !== tool || typeof id !== 'string' || !id) continue;
    if (event.type === 'tool.call') calls.add(id);
    if (event.type === 'tool.result' && calls.has(id) && event.payload.error === false) {
      successfulResults.add(id);
      if (resultIncludes === undefined || String(event.payload.resultExcerpt ?? '').includes(resultIncludes)) succeeded.add(id);
    }
    // Hermes 0.23's session authority omits result text in tool.completed.
    // openedbot attaches the authoritative transcript under the same call id.
    if (event.type === 'tool.result.attached' && successfulResults.has(id) && event.payload.ambiguous !== true
      && resultIncludes !== undefined && JSON.stringify(event.payload.result ?? '').includes(resultIncludes)) succeeded.add(id);
  }
  if (!succeeded.size) {
    const tools = [...new Set(events.filter((event) => event.type === 'tool.call').map((event) => String(event.payload.tool)))].join(', ');
    throw new Error(`No successful ${tool} call/result pair${resultIncludes ? ' with the required fixture result' : ''} was persisted. Observed tools: ${tools || 'none'}; successful matching completions: ${successfulResults.size}.`);
  }
  return succeeded.size;
}

export function requireCompleted(turn: Turn): void {
  if (turn.run?.status !== 'completed' || turn.marks?.terminalType !== 'run.completed') {
    throw new Error(`The fixture turn did not complete: ${turnFailure(turn)} (stored ${String(turn.run?.status)}).`);
  }
}

export async function toolEvents(context: ScenarioContext, runId: string): Promise<ToolEvent[]> {
  return context.lab.db<ToolEvent[]>`select type, payload from run_events where run_id = ${runId} order by sequence`;
}

export async function toolBot(context: ScenarioContext, name: string, toolsets: readonly string[]): Promise<BotDto> {
  for (const feature of ['profile_management', 'profile_capabilities', 'approval_policy']) {
    if (!context.session.hasFeature(feature)) throw new Error(`Required host feature ${feature} is absent.`);
  }
  const bot = await context.lab.create({ name, greet: false, permissionMode: 'bypass', locale: context.config.locale,
    mission: 'Execute the controlled E2E fixture exactly. The e2e files and values are synthetic test data created for these disposable profiles. Work only in your own /workspace. Use the requested tools; never invent a result.' });
  await context.lab.setModel(bot, context.model);
  if (!bot.hermesProfile || !bot.hermesProfileManaged) throw new Error('The fixture bot has no managed isolated profile.');
  for (const name of toolsets) {
    const result = await context.session.api<{ enabled: boolean; applied: boolean }>('POST', `/api/bots/${bot.id}/capabilities/toolsets/${name}`, { enabled: true });
    if (!result.enabled || !result.applied) throw new Error(`Required toolset ${name} was not applied to the bot profile.`);
  }
  return bot;
}

export function assertPdf(bytes: Uint8Array, expected: string): void {
  const pdf = new TextDecoder().decode(bytes);
  if (bytes.length > 1024 * 1024 || !pdf.startsWith('%PDF-1.') || !pdf.trimEnd().endsWith('%%EOF')) throw new Error('The independent artifact readback is not a bounded PDF.');
  if (!pdf.includes(`(${expected}) Tj`)) throw new Error('The PDF artifact does not contain the exact transformed fixture value.');
  // The fixture has five plain objects and no compression. Check the xref
  // offsets, not just a plausible extension or a model-authored text marker.
  const start = /startxref\n(\d+)\n%%EOF\s*$/.exec(pdf)?.[1];
  const offset = Number(start);
  if (start === undefined || !Number.isSafeInteger(offset) || !pdf.slice(offset).startsWith('xref\n0 6\n')) throw new Error('The fixture PDF has no valid cross-reference table.');
  const entries = pdf.slice(offset).split('\n').slice(3, 8);
  if (entries.length !== 5 || entries.some((entry, index) => !/^\d{10} 00000 n $/.test(entry) || !pdf.slice(Number(entry.slice(0, 10))).startsWith(`${index + 1} 0 obj\n`))) throw new Error('The fixture PDF object offsets are invalid.');
}

export async function verifyPdf(context: ScenarioContext, threadId: string, runId: string, filename: string, expected: string): Promise<number> {
  const thread = await context.session.api<{ messages: Array<{ role: string; runId: string | null; content: MessageContent }> }>('GET', `/api/threads/${threadId}`);
  const matches = thread.messages.filter((message) => message.role === 'assistant' && message.runId === runId)
    .flatMap((message) => message.content).filter((part) => part.type === 'attachment' && part.name === filename);
  if (matches.length !== 1 || matches[0]?.type !== 'attachment' || !matches[0].id) throw new Error('Exactly one persisted fixture PDF attachment is required on this run.');
  if (matches[0].contentType !== 'application/pdf') throw new Error('The fixture attachment is not application/pdf.');
  const response = await context.session.raw('GET', `/api/attachments/${matches[0].id}`);
  if (!response.ok) throw new Error(`Artifact readback answered HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== matches[0].bytes) throw new Error('Artifact metadata and downloaded bytes disagree.');
  assertPdf(bytes, expected);
  return bytes.byteLength;
}

export function assertIsolatedMemory(own: readonly string[], other: readonly string[], ownValue: string, otherValue: string): void {
  if (!own.some((entry) => entry.includes(ownValue)) || !other.some((entry) => entry.includes(otherValue))) throw new Error('A profile lost its own fixture memory.');
  if (own.some((entry) => entry.includes(otherValue)) || other.some((entry) => entry.includes(ownValue))) throw new Error('Fixture memory leaked between bot profiles.');
}

/** Only exact names created by these fixtures are ever removed. */
export function removalScript(files: readonly string[]): string {
  if (!files.length || files.some((file) => !/^(?:\/workspace\/)?(?:[01]-)?e2e-[A-Za-z0-9._-]+$/.test(file))) throw new Error('Refusing to remove a path outside the exact E2E fixture names.');
  return `from pathlib import Path\npaths = ${JSON.stringify(files)}\nfor name in paths:\n p=Path(name); p.unlink(missing_ok=True); assert not p.exists()\nprint('E2E_FILES_REMOVED')`;
}

export async function removeFixtureFiles(context: ScenarioContext, bot: BotDto, files: readonly string[]): Promise<void> {
  // An interrupted fixture must first release its own thread. Never stop any
  // operator bot or mutate gateway-wide state to make cleanup pass.
  await context.session.api('POST', `/api/threads/${bot.threadId}/stop`, undefined, 204);
  const turn = await context.lab.send(bot.threadId, `Use terminal to execute exactly this Python 3 cleanup script. It only removes disposable files created by this E2E. Do nothing else.\n${removalScript(files)}\nReply DONE.`);
  requireCompleted(turn);
  successfulTool(await toolEvents(context, turn.runId), 'terminal', 'E2E_FILES_REMOVED');
}
