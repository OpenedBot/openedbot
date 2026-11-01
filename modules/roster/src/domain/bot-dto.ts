import { isoOrNull } from "@openedbot/contracts-primitives";
import type { BotFaceSpec, BotPermissionMode, BotReplyLanguage, BotSpeechRate } from "@openedbot/contracts-api";

export type BotRow = {
  id: string;
  threadId: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string;
  model: string | null;
  reasoningEffort: string | null;
  sectionId: string;
  position: number;
  pinned: boolean;
  face: BotFaceSpec | null;
  voiceId: string | null;
  label: string | null;
  replyLanguage: BotReplyLanguage;
  notifyOnFinish: boolean;
  /** `numeric` PostgreSQL : le driver le rend en chaîne décimale. */
  speechRate: number | string;
  permissionMode: BotPermissionMode;
  hermesProfile: string | null;
  hermesProfileManaged?: boolean;
  approvalPolicyMode?: "ask_writes" | "block_writes" | "off" | null;
  approvalPolicyEffectiveAt?: Date | string | null;
  profileImportStatus?: "configuring" | "needs_attention" | null;
  profileProvisionStatus?: "preparing" | "failed" | null;
  hostCleanupStatus?: "pending" | "verifying" | "failed" | null;
  archivedAt: Date | string | null;
  deletedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  awaitingApproval: boolean;
  running?: boolean;
  unread?: boolean;
  hidden?: boolean;
  preview: string | null;
  lastActivityAt: Date | string;
  lastRunAt: Date | string | null;
  autonomyEnabled: boolean;
  autonomyMaxDepth: number;
  autonomyMaxSteps: number;
  autonomyMaxHandoffs: number;
  autonomyTimeoutSeconds: number;
  /** `bigint` PostgreSQL : le driver le rend en chaîne décimale. */
  autonomyTokenBudget: number | string;
};

/** Exporté pour la preuve de contrat : la DTO doit rester numérique. */
export function publicBot(row: BotRow) {
  const {
    autonomyEnabled,
    autonomyMaxDepth,
    autonomyMaxSteps,
    autonomyMaxHandoffs,
    autonomyTimeoutSeconds,
    autonomyTokenBudget,
    approvalPolicyMode: _approvalPolicyMode,
    approvalPolicyEffectiveAt: _approvalPolicyEffectiveAt,
    unread,
    running,
    hidden,
    ...rest
  } = row;
  const hostPolicy = row.hermesProfileManaged !== true ? null
    : !_approvalPolicyMode ? "unproven" as const
      : _approvalPolicyEffectiveAt ? "effective" as const : "pending" as const;
  return {
    ...rest,
    hostPolicy,
    speechRate: Number(row.speechRate) as BotSpeechRate,
    unread: Boolean(unread),
    running: Boolean(running),
    hidden: Boolean(hidden),
    hermesProfile: row.hermesProfile,
    hermesProfileManaged: row.hermesProfileManaged === true,
    isolation: "profile" as const,
    hasOwnRuntime: false,
    runtimeName: null,
    archivedAt: isoOrNull(row.archivedAt),
    deletedAt: isoOrNull(row.deletedAt),
    createdAt: isoOrNull(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
    lastActivityAt: isoOrNull(row.lastActivityAt),
    lastRunAt: isoOrNull(row.lastRunAt),
    autonomy: {
      enabled: autonomyEnabled,
      maxDepth: autonomyMaxDepth,
      maxSteps: autonomyMaxSteps,
      maxHandoffs: autonomyMaxHandoffs,
      timeoutSeconds: autonomyTimeoutSeconds,
      // Sans cette conversion le budget traverse HTTP en chaîne : le client le
      // juge non entier et le remplace silencieusement par le défaut.
      tokenBudget: Number(autonomyTokenBudget),
    },
  };
}
