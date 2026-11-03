/**
 * Hermes 0.22.2 flags a tool result as failed when its first 500 characters
 * hold `"error"` at all (`agent/display.py`, `_detect_tool_failure`): a
 * successful `web_extract` whose results carry `"error": null` reads as a
 * failure. This says when that flag is a false positive, and stays on the
 * side of the failure whenever the proof is incomplete:
 *
 * - a result that parses as JSON is walked whole: no truthy `error`,
 *   `errors`, `exception`, `isError` or `is_error` at any depth, no
 *   `success: false`, no `status: "error"`, no `user_summary`, and no
 *   `message` beside a top-level `error` key (Hermes' own dict rule);
 * - a truncated result (the 500-character stream preview) is only cleared
 *   for the web tools, whose per-item `"error": null` is the known cause, and
 *   only when every `error` key of the head is empty and no other failure
 *   word shows;
 * - the terminal keeps its exit code as the only signal upstream.
 */
const ERROR_KEYS = new Set(["error", "errors", "exception", "iserror", "is_error"]);
const PREVIEW_CLEARABLE_TOOLS = new Set(["web_extract", "web_search"]);

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function carriesFailure(value: unknown, depth: number): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => carriesFailure(item, depth + 1));
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    const name = key.toLowerCase();
    if (ERROR_KEYS.has(name) && truthy(child)) return true;
    if (name === "success" && child === false) return true;
    if (name === "status" && child === "error") return true;
    if (name === "user_summary" && truthy(child)) return true;
    if (carriesFailure(child, depth + 1)) return true;
  }
  return false;
}

export function upstreamErrorFlagIsFalsePositive(tool: string, text: string | null): boolean {
  if (tool === "terminal" || !text) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const top = parsed as Record<string, unknown>;
    if ("error" in top && truthy(top.message)) return false;
    return !carriesFailure(top, 0);
  }
  if (!PREVIEW_CLEARABLE_TOOLS.has(tool)) return false;
  const head = text.slice(0, 500);
  if (/^\s*error/i.test(head) || /"(failed|exception|is_?error|errors|user_summary)"\s*:/i.test(head)) return false;
  if (/"success"\s*:\s*false/i.test(head) || /"status"\s*:\s*"error"/i.test(head)) return false;
  const keys = [...head.matchAll(/"error"\s*:\s*([^,}\]\s]*)/gi)];
  if (!keys.length) return false;
  return keys.every((match) => /^(null|false|""|)$/i.test(match[1] ?? ""));
}
