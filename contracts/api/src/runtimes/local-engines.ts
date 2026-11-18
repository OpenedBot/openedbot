/**
 * The agent CLIs `edge-setup connect` links from a user's own machine
 * (`hello.engine`), each as a dedicated runtime of that machine. The Go side
 * lists the same engines in `edge-setup/internal/agents/registry.go`.
 */
export const LOCAL_ENGINES = {
  "local:codex": { label: "Codex", provider: "openai-codex" },
  "local:claude": { label: "Claude Code", provider: "claude-code" },
  "local:grok": { label: "Grok", provider: "grok-cli" },
  "local:gemini": { label: "Gemini CLI", provider: "gemini-cli" },
  "local:opencode": { label: "OpenCode", provider: "opencode-cli" },
} as const;

export type LocalEngine = keyof typeof LOCAL_ENGINES;

export function isLocalEngine(value: unknown): value is LocalEngine {
  return typeof value === "string" && Object.hasOwn(LOCAL_ENGINES, value);
}
