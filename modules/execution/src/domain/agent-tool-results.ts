import { redactSecrets, sanitizeToolErrorMessage } from "./tool-text";
import { upstreamErrorFlagIsFalsePositive } from "./tool-error-flag";

const MAX_TOOL_FIELD_BYTES = 8 * 1024;
const encoder = new TextEncoder();

export type ProjectedToolResult = {
  tool: string;
  callId: string;
  input: string | null;
  result: string | null;
  errorMessage: string | null;
  exitCode: number | null;
  status: string | null;
  truncated: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringify(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readMessageContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        const item = record(part);
        return item?.type === "text" && typeof item.text === "string" ? item.text : null;
      })
      .filter((part): part is string => part !== null)
      .join("\n");
    return text || null;
  }
  return stringify(value);
}

function truncateUtf8(raw: string | null): { text: string | null; truncated: boolean } {
  if (raw === null) return { text: null, truncated: false };
  const safe = redactSecrets(raw);
  let bytes = 0;
  let text = "";
  for (const character of safe) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > MAX_TOOL_FIELD_BYTES) return { text, truncated: true };
    bytes += size;
    text += character;
  }
  return { text, truncated: false };
}

function parseArguments(raw: unknown): { value: unknown; serialized: string | null } {
  if (typeof raw === "string") {
    const parsed = parseJson(raw);
    return { value: parsed ?? raw, serialized: raw };
  }
  return { value: raw, serialized: stringify(raw) };
}

function inputForTool(tool: string, args: unknown, serialized: string | null): string | null {
  const input = record(args);
  if (tool === "execute_code") return stringify(input?.code);
  if (tool === "terminal") return stringify(input?.command);
  if (tool === "write_file") {
    const path = stringify(input?.path);
    const content = stringify(input?.content);
    if (path === null && content === null) return null;
    return content === null ? path : `${path ?? ""}\n${content}`;
  }
  return serialized;
}

function resultError(tool: string, resultText: string | null, parsed: Record<string, unknown> | null): string | null {
  const summary = typeof parsed?.user_summary === "string" ? parsed.user_summary : null;
  if (summary) return sanitizeToolErrorMessage(summary);

  const exitCodeValue = parsed?.exit_code ?? parsed?.returncode;
  const exitCode = typeof exitCodeValue === "number" && Number.isFinite(exitCodeValue)
    ? Math.trunc(exitCodeValue)
    : null;
  if (tool === "terminal" && exitCode !== null && exitCode !== 0) {
    const error = typeof parsed?.error === "string" && parsed.error.trim() ? parsed.error : `exit ${exitCode}`;
    return sanitizeToolErrorMessage(error);
  }

  if (parsed) {
    // `"error": null` is a success that names the key (Hermes tools do).
    const hasError = parsed.error !== null && parsed.error !== undefined && parsed.error !== false && parsed.error !== "";
    if (parsed.success === false || hasError) {
      const message = typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error
        : typeof parsed.message === "string" ? parsed.message : null;
      if (message) return sanitizeToolErrorMessage(message);
    }
  }

  if (resultText) {
    const head = resultText.slice(0, 500).toLowerCase();
    if ((head.includes('"error"') && !upstreamErrorFlagIsFalsePositive(tool, resultText)) || head.includes('"failed"')) {
      const fallback = parsed?.error ?? parsed?.message;
      if (typeof fallback === "string") return sanitizeToolErrorMessage(fallback);
    }
  }
  return null;
}

function readCallId(call: Record<string, unknown>, ordinal: number): string {
  const id = typeof call.id === "string" ? call.id.trim()
    : typeof call.tool_call_id === "string" ? call.tool_call_id.trim()
      : "";
  return id || `transcript-call-${ordinal}`;
}

/** Projette le transcript du tour en détails d'outil bornés et expurgés. */
export function projectToolResults(messages: unknown): ProjectedToolResult[] {
  if (!Array.isArray(messages)) return [];

  const results = new Map<string, unknown[]>();
  for (const message of messages) {
    const item = record(message);
    if (!item || item.role !== "tool" || typeof item.tool_call_id !== "string") continue;
    const callId = item.tool_call_id.trim();
    if (!callId) continue;
    const queue = results.get(callId) ?? [];
    queue.push(item.content);
    results.set(callId, queue);
  }

  const projected: ProjectedToolResult[] = [];
  for (const message of messages) {
    const item = record(message);
    if (!item || item.role !== "assistant" || !Array.isArray(item.tool_calls)) continue;
    for (const rawCall of item.tool_calls) {
      const call = record(rawCall);
      const fn = record(call?.function);
      const toolValue = typeof fn?.name === "string" ? fn.name : call?.name;
      const tool = typeof toolValue === "string" ? toolValue.trim() : "";
      if (!call || !tool) continue;

      const args = parseArguments(fn?.arguments ?? call.arguments ?? {});
      const callId = readCallId(call, projected.length + 1);
      const resultQueue = results.get(callId) ?? [];
      const resultText = resultQueue.length > 0 ? readMessageContent(resultQueue.shift()) : null;
      const parsed = resultText ? record(parseJson(resultText)) : null;
      const input = truncateUtf8(inputForTool(tool, args.value, args.serialized));
      const result = truncateUtf8(resultText);
      const exitValue = parsed?.exit_code ?? parsed?.returncode;
      const exitCode = typeof exitValue === "number" && Number.isFinite(exitValue) ? Math.trunc(exitValue) : null;
      const status = typeof parsed?.status === "string" ? sanitizeToolErrorMessage(parsed.status) : null;

      projected.push({
        tool,
        callId,
        input: input.text,
        result: result.text,
        errorMessage: resultError(tool, resultText, parsed),
        exitCode,
        status,
        truncated: input.truncated || result.truncated,
      });
    }
  }
  return projected;
}
