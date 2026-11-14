/**
 * A tool failure (table `tool_errors`, 0037): what the runtime said, bounded
 * and written, or `null` when it said nothing: measured on `/v1/runs`,
 * `tool.completed` carries no text. The row exists anyway.
 */
export type ToolErrorDto = {
  id: string;
  botId: string;
  threadId: string;
  runId: string;
  /** The operator who sent the original message; `null` for a routine, a webhook, a hand-off. */
  userId: string | null;
  tool: string;
  toolCallId: string;
  /** Stable reason for localization; absent on older API versions. */
  errorCode?: "PYTHON_DEPENDENCY_MISSING" | "APPROVAL_REQUIRED" | "TOOL_EXECUTION_FAILED";
  /** Sanitized technical detail, never the default user-facing summary. */
  errorMessage: string | null;
  durationMs: number | null;
  occurredAt: string;
};

export type ToolErrorPageDto = {
  errors: ToolErrorDto[];
  /** `occurredAt|id` of the last row returned; `null` at the end of the list. */
  nextCursor: string | null;
};
