export type OrderedEvent = { sequence: number; type: string; at: string };
const requireProof: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };

export function appendGatewayFrame(events: OrderedEvent[], frame: string, at = new Date().toISOString()): void {
  if (!frame.split("\n").some((line) => line.startsWith("data:"))) return;
  const id = frame.match(/^id:\s*(\d+)$/m), type = frame.match(/^event:\s*(.+)$/m)?.[1];
  requireProof(id && type, "Gateway SSE lacks ordered journal metadata.");
  const sequence = Number(id[1]), previous = events.at(-1)?.sequence;
  requireProof(Number.isSafeInteger(sequence) && (previous === undefined ? sequence === 1 : sequence === previous + 1), "SSE duplicate or sequence gap.");
  events.push({ sequence, type, at });
}

export function proveActiveRestart(input: {
  previousBoot: string; currentBoot: string; previousActive: boolean; sseStarted: boolean;
  runId: string; remoteId: string;
  run: { startedAt: string | null; endedAt: string | null; hermesResponseId: string | null };
}) {
  const at = Date.parse(input.currentBoot);
  requireProof(at > Date.parse(input.previousBoot), "API boot identity moved backwards; replica switching is not restart proof.");
  requireProof(input.previousActive && input.run.startedAt && Date.parse(input.run.startedAt) <= at
    && (!input.run.endedAt || Date.parse(input.run.endedAt) >= at), "API boot did not overlap the observed active run.");
  requireProof(input.run.hermesResponseId === input.remoteId, "Worker remote run identity changed.");
  requireProof(input.sseStarted, "No independent SSE evidence before restart.");
  return { from: input.previousBoot, to: input.currentBoot, observedAt: new Date().toISOString(), runId: input.runId, remoteId: input.remoteId };
}

/** Hermes carries semantic event names in JSON data.event; the SSE event field
 * may be the default "message". Journal control frames are explicit failures. */
export function appendParsedGatewayFrame(events: OrderedEvent[], frame: { id: string | null; event: string; data: string }, at?: string): void {
  if (frame.event === "replay-gap" || frame.event === "journal-truncated") throw new Error(`Gateway journal reported ${frame.event}; ordered coverage cannot be proven.`);
  let type = frame.event;
  try {
    const payload: unknown = JSON.parse(frame.data);
    if (payload && typeof payload === "object" && "event" in payload && typeof payload.event === "string") type = payload.event;
  } catch { /* The ordered metadata check below still applies to non-JSON frames. */ }
  requireProof(/^[a-z][a-z0-9_.-]{0,80}$/.test(type) && type !== "message", "Gateway SSE lacks a semantic event name.");
  appendGatewayFrame(events, `id: ${frame.id ?? ""}\nevent: ${type}\ndata: [content omitted]`, at);
}

export function provePrimaryRunIdentities(runs: Array<{ id: string; stepKind?: string | null }>, expectedIds: string[]): void {
  const primary = runs.filter((run) => run.stepKind === "root" || run.stepKind == null);
  requireProof(primary.length === expectedIds.length && new Set(primary.map((run) => run.id)).size === primary.length
    && expectedIds.every((id) => primary.some((run) => run.id === id)), "Primary root run identities are missing, unexpected or duplicated.");
}
