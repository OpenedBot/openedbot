import type { Usage } from "../shared/domain";

export type ProductRunStatus =
  | "queued"
  | "pending"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type RunDto = {
  id: string;
  status: ProductRunStatus;
  /**
   * Le bot qui exécute CE run.
   *
   * Groupes : le membre dont c'est le tour. DM : le bot du fil pour une étape
   * `root`, mais le bot DÉLÉGUÉ pour une étape `delegated` et l'appelant pour
   * sa `continuation` : un DM n'est pas mono-locuteur depuis les workflows
   * durables. `null` uniquement sur les courriers de hand-off legacy.
   */
  botId?: string | null;
  input: string;
  output: string | null;
  usage: Usage | null;
  error: string | null;
  /**
   * Code stable de l'échec (`runs.error_code`), par exemple `MODEL_UNAVAILABLE`
   * quand le fournisseur refuse le modèle (alors `model` nomme le modèle
   * refusé). `error` reste le texte lisible. Optionnel : une API antérieure ne
   * le porte pas.
   */
  errorCode?: string | null;
  hermesResponseId: string | null;
  /**
   * Le modèle qui a RÉELLEMENT exécuté ce tour (colonne `runs.model`), y
   * compris après un repli de fournisseur. Sans lui, un fil ne peut pas dire
   * quelle fenêtre de contexte s'appliquait au tour mesuré : le modèle courant
   * du bot n'est pas forcément celui d'il y a trois tours. Optionnel : une API
   * antérieure ne le porte pas.
   */
  model?: string | null;
  runtimeSession: {
    id: string;
    model: string | null;
    reasoningTokens: number | null;
    toolCallCount: number | null;
  } | null;
  /** `bot_greeting` pour l'accueil d'un bot neuf, absent sinon (les autres origines restent internes). */
  origin?: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  /** Métadonnées présentes pour une étape d'un workflow autonome durable. */
  workflowId?: string | null;
  stepIndex?: number | null;
  stepKind?: "root" | "delegated" | "continuation" | "group" | "memory" | "persona_draft" | "compaction" | null;
  /** Salon en mode équipe : `synthesis` marque le tour qui écrit la réponse finale. */
  groupPhase?: "synthesis" | null;
  stackDepth?: number | null;
  completionKind?: string | null;
  /** `needs_review` signifie que l'effet Hermes est ambigu et interdit toute relance aveugle. */
  recoveryState?: "needs_review" | null;
};

export type WorkflowStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "reconciling"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export type WorkflowDto = {
  id: string;
  kind: "dm" | "group" | "routine";
  status: WorkflowStatus;
  rootRunId: string;
  rootBotId: string | null;
  usedSteps: number;
  maxSteps: number;
  usedHandoffs: number;
  maxHandoffs: number;
  usedTokens: number;
  tokenBudget: number;
  deadlineAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  finalOutput?: string | null;
  recoveryState: "needs_review" | null;
  /** Présents seulement quand `kind = 'routine'`, extraits de `recovery_state`. */
  routineId?: string | null;
  trigger?: "manual" | "scheduled" | null;
  /** Politique figée à la création. Les anciens serveurs peuvent l'omettre. */
  autonomyEnabled?: boolean;
  /** Séquence durable des transitions destinées aux notifications. */
  notificationSequence?: number;
  createdAt: string;
  updatedAt: string;
};
