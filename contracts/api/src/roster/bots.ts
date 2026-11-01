import type { BotPermissionMode } from "../permissions/policy";
import type { BotFaceSpec } from "../shared/bot-face";

type BotIsolation = "profile";

export type BotAutonomyPolicyDto = {
  enabled: boolean;
  maxDepth: number;
  maxSteps: number;
  maxHandoffs: number;
  timeoutSeconds: number;
  tokenBudget: number;
};

export type BotPurgeResultDto = {
  id: string;
  hostCleanup: "queued" | "none";
};

/** La langue de réponse imposée au bot ; `auto` suit celle de l'opérateur. */
export const BOT_REPLY_LANGUAGES = ["auto", "en", "fr", "es", "de", "it", "pt", "ja", "tr"] as const;

export type BotReplyLanguage = (typeof BOT_REPLY_LANGUAGES)[number];

/** Vitesse de lecture à voix haute des réponses du bot. */
export const BOT_SPEECH_RATES = [0.75, 1, 1.25, 1.5] as const;

export type BotSpeechRate = (typeof BOT_SPEECH_RATES)[number];

export type BotDto = {
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
  /** Identifiant public de synthèse vocale ; `null` reprend la voix par défaut du client. */
  voiceId: string | null;
  /** Éditeur d'agent (0099). Absents sur les serveurs antérieurs. */
  label?: string | null;
  replyLanguage?: BotReplyLanguage;
  notifyOnFinish?: boolean;
  speechRate?: BotSpeechRate;
  permissionMode?: BotPermissionMode;
  hermesProfile: string | null;
  /** openedbot created and owns the corresponding named host profile. */
  /** Absent on responses from servers before OHB-28. */
  hermesProfileManaged?: boolean;
  profileImportStatus?: "configuring" | "needs_attention" | null;
  profileProvisionStatus?: "preparing" | "failed" | null;
  hostCleanupStatus?: "pending" | "verifying" | "failed" | null;
  /**
   * PERM2-2: whether the host plugin is proven to enforce the bot's mode.
   * `pending`: written, not yet in force (gateway restart, older host);
   * `unproven`: the last write or re-read failed. `null`: no managed profile.
   * Absent on older servers.
   */
  hostPolicy?: "effective" | "pending" | "unproven" | null;
  isolation: BotIsolation;
  hasOwnRuntime: false;
  runtimeName: string | null;
  awaitingApproval: boolean;
  /** Un run de ce fil est actif ou en reprise. Absent sur les anciens serveurs. */
  running?: boolean;
  /** Activité bot/runtime postérieure au dernier accusé de lecture de l’utilisateur courant. */
  unread?: boolean;
  /** Préférence personnelle : le fil est retiré du roster courant, sans être archivé ni supprimé. */
  hidden?: boolean;
  preview: string | null;
  lastActivityAt: string;
  archivedAt: string | null;
  /**
   * Corbeille : l'opérateur a supprimé ce bot, ses sessions runtime ne sont
   * pas encore effacées. Toujours accompagné de `archivedAt`. Absent sur les
   * anciens serveurs.
   */
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  /** Politique bornée appliquée aux workflows multi-bots lancés par ce bot. */
  autonomy?: BotAutonomyPolicyDto;
  /**
   * Écriture du bloc `model` du profil hôte, relue. Présent quand cette
   * réponse a tenté `hostSetProfileModel` (création, PATCH modèle, ou
   * sélection runtime pour les bots sans modèle propre). Un échec hôte ne
   * bloque pas la mise à jour openedbot : `applied: false`.
   */
  profileModel?: { applied: boolean };
  /**
   * Only on a `POST /api/bots` answered `200`: its `clientRequestId` was
   * already used with the same body, this is the bot the first attempt
   * created (0135). The same id with another body is a 409
   * `BOT_CREATION_REQUEST_REUSED` (0136).
   */
  creationReplayed?: true;
};
