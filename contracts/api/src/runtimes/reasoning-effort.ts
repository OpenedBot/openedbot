/** Levels accepted by Hermes (`model_options.reasoning_effort`). */
export const HERMES_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type HermesReasoningEffort = (typeof HERMES_REASONING_EFFORTS)[number];

export const HERMES_REASONING_EFFORT_LABELS: Record<HermesReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
};

export const DEFAULT_REASONING_EFFORT: HermesReasoningEffort = "medium";

export function isHermesReasoningEffort(value: unknown): value is HermesReasoningEffort {
  return (
    typeof value === "string" &&
    (HERMES_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}
