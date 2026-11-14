/** What a new Hermes run is created with (`POST /v1/runs`), split out of `contracts.ts`. */

/** An image handed to the model as an `image_url` part, never pasted into `input`. */
export type HermesRunImage = {
  name: string;
  /** `data:image/...;base64,...`, the only inline form the gateway accepts. */
  dataUrl: string;
};

export type CreateHermesRunInput = {
  input: string;
  /** Present and non-empty: `input` travels as one multimodal user message. */
  images?: readonly HermesRunImage[];
  instructions: string;
  sessionId: string;
  model?: string | null;
  provider?: string | null;
  reasoningEffort?: string | null;
  /**
   * The model's fast mode (`model_options.fast`, Hermes `service_tier:
   * priority` or Anthropic `speed: fast`). The caller sends it only for a
   * model the catalogue marks `fast`: Hermes forwards it without checking.
   */
  fast?: boolean;
  /**
   * The prompt-cache tier of this run (`model_options.prompt_cache_ttl`,
   * honoured by the edge-setup hook `openedbot_prompt_cache_ttl`). Absent: the
   * runtime's configured tier. A host without the hook ignores the key.
   */
  promptCacheTtl?: HermesPromptCacheTtl | null;
  conversationHistory?: Array<{ role: string; content: string }>;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type HermesPromptCacheTtl = "5m" | "1h";
