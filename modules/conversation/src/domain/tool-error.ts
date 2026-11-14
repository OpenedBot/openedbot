import type { ToolErrorDto } from "@openedbot/contracts-api";

/** Classify explicit evidence only; arbitrary output is not a user-facing message. */
export function toolErrorCode(detail: unknown): NonNullable<ToolErrorDto["errorCode"]> {
  if (typeof detail !== "string") return "TOOL_EXECUTION_FAILED";
  // A terminal envelope can also contain an approval note. The actual Python
  // exception takes precedence over that metadata, including in truncated JSON.
  if (/\bModuleNotFoundError\s*:\s*No module named\s+/i.test(detail)) return "PYTHON_DEPENDENCY_MISSING";
  if (/\bCommand required approval\b|\bapproval_required\b/i.test(detail)) return "APPROVAL_REQUIRED";
  return "TOOL_EXECUTION_FAILED";
}
