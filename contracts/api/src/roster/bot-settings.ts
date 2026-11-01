import type { BotPermissionMode } from "../permissions/policy";
import type { BotAutonomyPolicyDto, BotReplyLanguage, BotSpeechRate } from "./bots";
import type { BotFaceSpec } from "../shared/bot-face";

/** Ce que le client peut modifier d'un bot : le slug et le profil Hermes sont immuables. */
export type UpdateBotInput = Partial<{
  name: string;
  description: string | null;
  instructions: string;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  pinned: boolean;
  face: BotFaceSpec | null;
  voiceId: string | null;
  archived: boolean;
  autonomy: Partial<BotAutonomyPolicyDto>;
  sectionId: string;
  label: string | null;
  replyLanguage: BotReplyLanguage;
  notifyOnFinish: boolean;
  speechRate: BotSpeechRate;
  permissionMode: BotPermissionMode;
}>;

/**
 * Alignement, en arrière-plan, des profils hôte des bots remis au modèle
 * global (`GET /api/bots/model-overrides/sync`). `done` compte les profils
 * traités, alignés ou en échec : la barre de progression le lit tel quel.
 * Un profil en échec n'est pas perdu : le worker relit le bloc `model` du
 * profil à chaque run et le réécrit s'il diffère.
 */
export type BotProfileModelSyncDto = {
  id: string;
  status: "running" | "done";
  total: number;
  done: number;
  aligned: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
};

/**
 * Réponse de `POST /api/bots/model-overrides/reset` : `cleared` bots ont perdu
 * leur modèle et leur effort propres, en base, avant la réponse. `sync` est
 * l'alignement hôte qui suit, `null` quand il n'y a rien à écrire sur l'hôte.
 */
export type BotModelResetDto = {
  cleared: number;
  sync: BotProfileModelSyncDto | null;
};

/**
 * Brouillon produit par `POST /api/bots/:botId/persona-drafts`.
 * Un bot existant est obligatoire : il n'y a pas de brouillon à la création.
 */
export type PersonaDraftDto = {
  status: "queued" | "starting" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "missing";
  runId: string | null;
  draft: string | null;
  hash: string | null;
};

/**
 * `routine_manage` pour UN bot (DEV-209) : l'outil MCP par lequel le bot gère
 * ses propres routines depuis la conversation.
 *
 * `available` dit si l'hôte sait l'installer (verbes MCP annoncés) ; `reason`
 * explique un `false`. `restartPending` : l'hôte attend un redémarrage du
 * gateway pour que les runs voient l'outil.
 */
export type BotRoutineToolDto = {
  available: boolean;
  reason: "https_required" | "runtime_required" | "host_unsupported" | "profile_unsupported" | null;
  enabled: boolean;
  restartPending: boolean;
};

/**
 * `bot_settings_propose` pour UN bot : l'outil MCP par lequel le bot PROPOSE
 * de changer sa persona et ses reglages legers (0099). Meme forme que
 * `BotRoutineToolDto`. Rien n'est applique sans l'operateur (parite amont :
 * une ecriture de SOUL.md demande toujours un humain, meme en `--yolo`).
 */
export type BotSettingsToolDto = BotRoutineToolDto;

/** Champs qu'un bot peut proposer de changer. Absent = inchange. */
export type BotSettingProposalFields = {
  instructions?: string;
  label?: string | null;
  replyLanguage?: BotReplyLanguage;
  notifyOnFinish?: boolean;
};

export type BotSettingProposalStatus = "pending" | "applied" | "rejected" | "superseded" | "stale";

/**
 * Une proposition du bot, rendue en carte dans le fil. `current` est la valeur
 * des memes champs au moment de la proposition ; `hash` lie les octets que
 * l'operateur a vus a ceux qu'il applique.
 */
export type BotSettingProposalDto = {
  id: string;
  botId: string;
  runId: string;
  threadId: string;
  status: BotSettingProposalStatus;
  reason: string | null;
  current: BotSettingProposalFields;
  proposed: BotSettingProposalFields;
  hash: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type BotSettingProposalDecisionInput = { decision: "apply" | "reject"; expectedHash: string };
