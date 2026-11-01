import type { HermesReasoningEffort, RuntimeHealthStatus } from "@openedbot/contracts-api";

export const NONE = "__none__";
/** Relecture de la configuration, et du catalogue d'un runtime injoignable. */
export const RUNTIME_POLL_MS = 3_000;
/** Relecture de la configuration tant qu'un modèle est vérifié en arrière-plan. */
export const SELECTION_POLL_MS = 1_500;

export type Preference = {
  provider: string | null;
  model: string | null;
  effort: HermesReasoningEffort | null;
};

export type AssignmentMode = "global" | "perBot";

export type RuntimeOffline = {
  status: Extract<RuntimeHealthStatus, "disconnected" | "unreachable">;
  /** Dernier signe de vie du lien, horodaté par le serveur ; `null` s'il n'y en a pas. */
  since: string | null;
  /** Fin de la dernière relecture (réussie ou non) de la requête qui lèvera le voile, en ms. */
  lastAttemptAt: number;
  /** Cette requête est en vol. */
  checking: boolean;
};
