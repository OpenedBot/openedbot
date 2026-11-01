export const RUN_STEP_KINDS = [
  "root",
  "delegated",
  "continuation",
  "group",
  "memory",
  "persona_draft",
  "compaction",
] as const;

export type RunStepKind = (typeof RUN_STEP_KINDS)[number];

/** Runs de service : pas de bulle, pas d'avance salon, pas de `@slug`. */
export const SERVICE_STEP_KINDS = ["memory", "persona_draft", "compaction"] as const;

export type ServiceStepKind = (typeof SERVICE_STEP_KINDS)[number];

export function isServiceStepKind(kind: string | null | undefined): boolean {
  return kind != null && (SERVICE_STEP_KINDS as readonly string[]).includes(kind);
}
