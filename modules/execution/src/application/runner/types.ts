import type { HermesPromptCacheTtl, HermesSessionCounters } from "@openedbot/hermes";
import type { ModelAssignmentMode } from "@openedbot/contracts-api";
import type { OperatorIdentity } from "@openedbot/roster/domain/bot-mode";
import type { RunEventRecord } from "@openedbot/contracts-events";

export type RunContext = {
  id: string;
  organizationId: string;
  threadId: string;
  botId: string;
  /**
   * Politique d'approbation de l'éditeur d'agent (0099) ; absente = `manual`.
   * `plan` pour un tour « plan d'abord » (0155), quel que soit le mode du bot.
   */
  permissionMode?: string | null;
  /** L'opérateur a demandé un plan pour ce tour (`runs.plan_only` / `workflows.plan_only`). */
  planOnly?: boolean;
  /** La consigne « plan d'abord » de CE tour, portée par l'entrée ; `null` si le bot est déjà en `plan`. */
  planTurnBlock?: string | null;
  input: string;
  attempts: number;
  hermesRunId: string | null;
  lastHermesSequence: number;
  botName: string;
  botSlug: string;
  botDescription: string | null;
  /** La persona du bot, DÉJÀ suivie de son bloc mémoire quand il y en a un. */
  instructions: string;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  /** `null` = le bot parle à la RACINE du runtime (profil Hermes optionnel). */
  hermesProfile: string | null;
  hermesProfileManaged: boolean;
  /** PERM2-1: who answers the bot's gates (`organizations.permission_pipeline`). */
  permissionPipeline?: string | null;
  /** PERM2-2: the host plugin enforces the bot's mode, proven by re-reading it. */
  hostPolicyProven?: boolean;
  /** PERM2-2: under `v2` a run starts only on a proven host policy. */
  hostPolicyRequired?: boolean;
  /** Persona + brief de section, SANS le bloc mémoire : recollé après l'inventaire. */
  personaInstructions: string;
  /** Le toolset `memory` du profil est actif dans cette session (lu à l'inventaire). */
  memoryToolEnabled?: boolean;
  /** Le toolset `web` du profil est actif dans cette session (lu à l'inventaire). */
  webToolsEnabled?: boolean;
  /** `routine_manage` est installé sur le runtime et activé pour ce bot (DEV-209). */
  routineToolEnabled: boolean;
  /** `bot_settings_propose` is installed on the runtime and enabled for this bot. */
  botSettingsToolEnabled: boolean;
  groupTurnPosition: number | null;
  groupId: string | null;
  /** Le titre du fil : celui de la session Hermes d'un salon (jamais le nom d'un membre). */
  threadTitle: string;
  /** `runs.group_state`, brut : valide (voir isGroupSendState) seulement sur un tour de salon. */
  groupState: unknown;
  /** Posé sur un run « entrant » de hand-off : l'id du courrier qui attend dans le fil d'origine. */
  originRunId: string | null;
  operator: OperatorIdentity;
  sessionId: string;
  runtimeId: string;
  /** Sélection posée sur le runtime, distincte du modèle résolu du run. */
  runtimeSelectedProvider: string | null;
  runtimeSelectedModel: string | null;
  /** `global` : le choix du runtime l'emporte sur le modèle propre du bot. */
  assignmentMode: ModelAssignmentMode;
  /**
   * Capacités annoncées par l'hôte (`hello` / `/v1/capabilities`). Une capacité
   * existe seulement si l'hôte la nomme : rien ne s'en déduit d'une version.
   */
  linkFeatures: string[];
  /** Connector relay; endpoint/token columns stay NULL. */
  reachability: "connector" | "direct";
  runtimeEndpoint: string | null;
  tokenCiphertext: string | null;
  tokenNonce: string | null;
  tokenTag: string | null;
  tokenKeyId: string | null;
  edgeAuthCiphertext?: string | null;
  edgeAuthNonce?: string | null;
  edgeAuthTag?: string | null;
  edgeAuthKeyId?: string | null;
  /** Dernier signe de vie du lien connecteur ; `null` pour un runtime direct. */
  linkLastSeenAt: Date | string | null;
  /** Instant de la connexion courante. Bouge au hello, pas au heartbeat. */
  linkConnectedAt: Date | string | null;
  /** `runtimes.toolset_epoch` as text (OHB-138): bumped by each relayed inventory write. */
  toolsetEpoch?: string | null;
  leaseGeneration: number;
  externalState: "not_started" | "creating" | "streaming" | "polling" | "stopping" | "settled" | "ambiguous";
  workflowId: string | null;
  /** `workflows.root_run_id`. Null hors workflow : le tour est alors l'id du run. */
  workflowRootRunId: string | null;
  stepIndex: number | null;
  stepKind: "root" | "delegated" | "continuation" | "group" | "memory" | "persona_draft" | "compaction" | null;
  /** The prompt-cache tier this run asks for (`promptCacheTierForRun`); null keeps the runtime's. */
  promptCacheTtl: HermesPromptCacheTtl | null;
  stackDepth: number;
  callerBotId: string | null;
  callerRunId: string | null;
  resumesRunId: string | null;
  autonomyEnabled: boolean;
  workflowAutonomyEnabled: boolean | null;
  workflowStatus: string | null;
  workflowDeadlineAt: Date | string | null;
  remoteStopState: "requested" | "confirmed" | "ambiguous" | "failed" | null;
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * Compteurs de session lus JUSTE AVANT la création du run. Posé par le
   * runner, jamais par la base : absent sur une reprise (run déjà créé chez
   * Hermes), auquel cas le coût de l'étape retombe sur le brut.
   */
  sessionCountersBefore?: HermesSessionCounters | null;
};

export type EventContext = Pick<RunContext, "organizationId" | "threadId" | "id">;
/** Ce que le trigger 0092 a posé sur la ligne : l'enveloppe le relit, ne le recalcule pas. */
export type RunEventIdentityRow = Pick<RunEventRecord, "cursor" | "botId" | "turnId" | "sessionKey" | "leaseGeneration">;
export type GroupRunContext = Pick<EventContext, "organizationId" | "threadId" | "id"> & {
  botId: string | null;
  groupId: string | null;
  workflowId?: string | null;
  stepIndex?: number | null;
};

export type LegacyGroupRunContext = Pick<EventContext, "organizationId" | "threadId" | "id"> & {
  groupId: string;
  groupTurnPosition: number;
  input: string;
};
export type HandoffChildContext = Pick<RunContext, "organizationId" | "id" | "originRunId" | "botName" | "botSlug"> & {
  botId: string | null;
};
export type WorkflowFailureContext = Pick<RunContext,
  "id" | "organizationId" | "threadId" | "groupId" | "workflowId" | "callerBotId" |
  "callerRunId" | "stackDepth" | "botName" | "botSlug"
>;
