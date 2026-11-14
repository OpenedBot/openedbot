/**
 * The context window the runtime applies to the configured model.
 *
 * `status` says where the figure comes from, and there is no third case: either
 * the host read it (`ok`), or nobody has it and the caller falls back to its
 * local table. The Hermes gateway publishes this number nowhere: neither
 * `/v1/models`, nor `/api/model/options`, nor `/v1/capabilities`. Only a host
 * that serves `edge-setup` can say it, because only upstream knows how to
 * resolve it (`agent/model_metadata.py`).
 *
 * `contextWindow` is `0` when it is unknown: never a guessed ceiling.
 */
export type RuntimeModelContextDto = {
  runtimeId: string;
  status: "ok" | "unsupported" | "disconnected" | "error";
  reason: "feature_absent" | "link_closed" | null;
  model: string | null;
  provider: string | null;
  /** What the agent applies: the config override, otherwise the detected value. */
  contextWindow: number;
  /** The detected value alone, when an override replaces it. */
  autoContextWindow: number;
  maxOutputTokens: number;
  /**
   * What the gateway places in front of every run (identity, memory, skills
   * index, tool schemas, MCP servers), measured on the host. `null` when
   * the host does not publish it yet: the bar then has only openedbot's share.
   */
  preamble: ContextPreambleDto | null;
  fetchedAt: string | null;
  error: string | null;
};

/** One preamble line item; `tokens: null` means present but not measured, never zero. */
export type ContextPreambleBucketDto = {
  key: "identity" | "memory" | "skills" | "tools" | "mcp";
  tokens: number | null;
  items: Array<{ name: string; tokens: number | null }>;
};

export type ContextPreambleDto = { buckets: ContextPreambleBucketDto[] };
