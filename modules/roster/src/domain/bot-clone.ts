import type { BotAutonomyPolicyDto, BotDto, BotFaceSpec, BotReplyLanguage, BotSpeechRate } from "@openedbot/contracts-api";
import { normalizeAutonomyPolicy } from "./autonomous-workflow";
import { PERSONA_MAX_CHARS } from "./persona";
import { BOT_REPLY_LANGUAGES, BOT_SPEECH_RATES, isHermesReasoningEffort, type HermesReasoningEffort } from "@openedbot/contracts-api";

export const BOT_CLONE_NAME_MAX_CHARS = 100;
/** The `bots.label` check of 0099. */
export const BOT_CLONE_LABEL_MAX_CHARS = 60;
export const BOT_CLONE_DESCRIPTION_MAX_CHARS = 1_000;
export const BOT_CLONE_HERMES_PROFILE_MAX_CHARS = 63;

/**
 * Payload portable de création. Sa forme est volontairement plus petite que
 * `BotDto` : aucune identité, position, activité ou relation de workspace ne
 * peut traverser cette projection.
 */
export type PortableBotCreationDraft = {
  name: string;
  description?: string;
  /** Mission libre, distincte du rôle (`description`). Sert à composer la persona initiale. */
  mission?: string;
  instructions: string;
  model?: string;
  reasoningEffort?: HermesReasoningEffort;
  face?: BotFaceSpec;
  /** Nouveau profil choisi pour la copie, jamais le profil de la source. */
  hermesProfile?: string;
  /** Présent seulement quand le DTO source expose cette capacité. */
  autonomy?: BotAutonomyPolicyDto;
  /**
   * Presentation settings of the agent editor (0099), carried so the copy
   * looks and reads like its source. `permissionMode` is deliberately NOT
   * here: a copy is born `manual`, approval rules are never inherited.
   */
  label?: string;
  replyLanguage?: BotReplyLanguage;
  notifyOnFinish?: boolean;
  speechRate?: BotSpeechRate;
  voiceId?: string;
};

export type BotCloneDraftOptions = {
  /** Libellé localisable placé entre parenthèses après le nom. */
  copyLabel?: string;
  /** Profil neuf explicitement choisi. Le profil source n'est jamais repris. */
  hermesProfile?: string | null;
  /** `false` permet à une surface qui ne supporte pas l'autonomie de l'omettre. */
  includeAutonomy?: boolean;
};

export type BotCloneDraftErrorCode =
  | "BOT_CLONE_INSTRUCTIONS_TOO_LONG"
  | "BOT_CLONE_DESCRIPTION_TOO_LONG"
  | "BOT_CLONE_HERMES_PROFILE_TOO_LONG"
  | "BOT_CLONE_HERMES_PROFILE_REUSED";

export class BotCloneDraftError extends Error {
  constructor(readonly code: BotCloneDraftErrorCode, message: string) {
    super(message);
    this.name = "BotCloneDraftError";
  }
}

function derivedName(sourceName: string, requestedLabel: string | undefined): string {
  const source = sourceName.trim() || "Bot";
  // Un label fourni par une traduction est de l'interface, pas une nouvelle
  // zone de texte libre : on le borne pour qu'il ne puisse pas évincer le nom.
  const label = (requestedLabel?.trim() || "copy").slice(0, 40);
  const suffix = ` (${label})`;
  const stem = source.slice(0, Math.max(1, BOT_CLONE_NAME_MAX_CHARS - suffix.length)).trimEnd() || "Bot";
  return `${stem}${suffix}`.slice(0, BOT_CLONE_NAME_MAX_CHARS);
}

function portableFace(face: BotFaceSpec | null): BotFaceSpec | undefined {
  if (!face) return undefined;
  return {
    palette: face.palette,
    shape: face.shape,
    eyes: face.eyes,
    ...(typeof face.mouth === "string" ? { mouth: face.mouth } : {}),
    ...(typeof face.artwork === "string" ? { artwork: face.artwork } : {}),
    ...(typeof face.accessory === "string" ? { accessory: face.accessory } : {}),
  };
}

/**
 * Clone allowlisté d'un bot existant vers un brouillon sans effet de bord.
 *
 * Les instructions sont refusées au-delà de la borne serveur plutôt que
 * tronquées : perdre silencieusement une partie de la persona changerait le
 * comportement de la copie. Les champs absents/legacy restent simplement
 * absents du brouillon.
 */
export function botCreationDraftFromClone(
  source: BotDto,
  options: BotCloneDraftOptions = {},
): PortableBotCreationDraft {
  const instructions = source.instructions.trim();
  if (instructions.length > PERSONA_MAX_CHARS) {
    throw new BotCloneDraftError(
      "BOT_CLONE_INSTRUCTIONS_TOO_LONG",
      `Bot instructions exceed ${PERSONA_MAX_CHARS} characters`,
    );
  }
  const description = source.description?.trim() || undefined;
  if (description && description.length > BOT_CLONE_DESCRIPTION_MAX_CHARS) {
    throw new BotCloneDraftError(
      "BOT_CLONE_DESCRIPTION_TOO_LONG",
      `Bot description exceeds ${BOT_CLONE_DESCRIPTION_MAX_CHARS} characters`,
    );
  }

  const draft: PortableBotCreationDraft = {
    name: derivedName(source.name, options.copyLabel),
    instructions,
  };
  if (description) draft.description = description;
  if (source.model?.trim()) draft.model = source.model.trim();
  if (isHermesReasoningEffort(source.reasoningEffort)) draft.reasoningEffort = source.reasoningEffort;
  const face = portableFace(source.face);
  if (face) draft.face = face;

  const profile = options.hermesProfile?.trim() || undefined;
  if (profile && profile.length > BOT_CLONE_HERMES_PROFILE_MAX_CHARS) {
    throw new BotCloneDraftError(
      "BOT_CLONE_HERMES_PROFILE_TOO_LONG",
      `Hermes profile exceeds ${BOT_CLONE_HERMES_PROFILE_MAX_CHARS} characters`,
    );
  }
  if (profile && profile === source.hermesProfile?.trim()) {
    throw new BotCloneDraftError(
      "BOT_CLONE_HERMES_PROFILE_REUSED",
      "A cloned bot needs a distinct Hermes profile",
    );
  }
  if (profile) draft.hermesProfile = profile;

  if (options.includeAutonomy !== false && source.autonomy) {
    draft.autonomy = normalizeAutonomyPolicy(source.autonomy);
  }
  // Same bounds as the server reader (`readEditorSettings`): a label it would
  // refuse is dropped from the copy rather than failing the whole creation.
  const label = source.label?.trim();
  if (label && label.length <= BOT_CLONE_LABEL_MAX_CHARS) draft.label = label;
  if (source.replyLanguage && (BOT_REPLY_LANGUAGES as readonly string[]).includes(source.replyLanguage)) {
    draft.replyLanguage = source.replyLanguage;
  }
  if (typeof source.notifyOnFinish === "boolean") draft.notifyOnFinish = source.notifyOnFinish;
  if (source.speechRate !== undefined && (BOT_SPEECH_RATES as readonly number[]).includes(Number(source.speechRate))) {
    draft.speechRate = Number(source.speechRate) as BotSpeechRate;
  }
  if (source.voiceId?.trim()) draft.voiceId = source.voiceId.trim();
  return draft;
}
