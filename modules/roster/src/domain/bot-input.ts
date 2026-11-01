import {
  BOT_PERMISSION_MODES,
  BOT_REPLY_LANGUAGES,
  BOT_SPEECH_RATES,
  type BotFaceSpec,
  type BotPermissionMode,
  type BotReplyLanguage,
  type BotSpeechRate,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { OPENEDBOT_SERVICE_PROFILES } from "@openedbot/runtimes/domain/runtime-contract";
import { isUuid } from "@openedbot/contracts-primitives";
import { assertString } from "@openedbot/platform-config/http-body";
import { AUTONOMY_CEILINGS, AUTONOMY_DEFAULTS, type AutonomyPolicy } from "./autonomous-workflow";
import { BotVoiceIdError, normalizeBotVoiceId } from "./bot-voice";
import { PERSONA_MAX_CHARS, resolveCreateInstructions } from "./persona";
import { readSectionId } from "./section-id";

/**
 * Les réglages de l'éditeur d'agent (0099), lus champ par champ : absent,
 * le champ ne change pas ; présent et invalide, la requête est refusée
 * plutôt que rognée.
 */
export function readEditorSettings(body: Record<string, unknown>): {
  label?: string | null;
  replyLanguage?: BotReplyLanguage;
  notifyOnFinish?: boolean;
  speechRate?: BotSpeechRate;
  permissionMode?: BotPermissionMode;
} {
  const out: ReturnType<typeof readEditorSettings> = {};
  if (Object.hasOwn(body, "label")) {
    if (body.label === null) out.label = null;
    else if (typeof body.label === "string") {
      const label = body.label.trim();
      if (label.length > 60) throw new HttpError(422, "BOT_LABEL_TOO_LONG", "Le libellé ne doit pas dépasser 60 caractères.");
      out.label = label || null;
    } else throw new HttpError(422, "BOT_LABEL_INVALID", "Libellé invalide.");
  }
  if (Object.hasOwn(body, "replyLanguage")) {
    if (!(BOT_REPLY_LANGUAGES as readonly unknown[]).includes(body.replyLanguage)) {
      throw new HttpError(422, "BOT_LANGUAGE_INVALID", "Langue de réponse inconnue.");
    }
    out.replyLanguage = body.replyLanguage as BotReplyLanguage;
  }
  if (Object.hasOwn(body, "notifyOnFinish")) {
    if (typeof body.notifyOnFinish !== "boolean") throw new HttpError(422, "BOT_NOTIFY_INVALID", "Réglage de notification invalide.");
    out.notifyOnFinish = body.notifyOnFinish;
  }
  if (Object.hasOwn(body, "speechRate")) {
    if (!(BOT_SPEECH_RATES as readonly unknown[]).includes(body.speechRate)) {
      throw new HttpError(422, "BOT_SPEECH_RATE_INVALID", "Vitesse de lecture inconnue.");
    }
    out.speechRate = body.speechRate as BotSpeechRate;
  }
  if (Object.hasOwn(body, "permissionMode")) {
    if (!(BOT_PERMISSION_MODES as readonly unknown[]).includes(body.permissionMode)) {
      throw new HttpError(422, "BOT_PERMISSION_MODE_INVALID", "Mode de permission inconnu.");
    }
    out.permissionMode = body.permissionMode as BotPermissionMode;
  }
  return out;
}

/**
 * La persona soumise, ou `null` si le corps n'en porte pas.
 *
 * Le dépassement est REFUSÉ et non rogné. Rogner à 100 000 caractères, ce que
 * faisait ce code, retirait au bot une partie de son cadrage sans le dire :
 * l'opérateur enregistrait, l'API répondait 200, et le premier symptôme était
 * un bot qui change de caractère plusieurs runs plus tard. Un 400 nommé se
 * corrige ; une troncature silencieuse ne se découvre pas.
 */
export function readInstructions(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const instructions = value.trim();
  if (instructions.length > PERSONA_MAX_CHARS) {
    throw new HttpError(
      400,
      "BOT_INSTRUCTIONS_TOO_LONG",
      `La persona dépasse ${PERSONA_MAX_CHARS} caractères.`,
    );
  }
  return instructions;
}

/** Même normalisation à la création et au patch ; le champ absent est géré par l'appelant. */
export function readVoiceId(value: unknown): string | null {
  try {
    return normalizeBotVoiceId(value);
  } catch (error) {
    if (error instanceof BotVoiceIdError) {
      throw new HttpError(400, error.code, error.message);
    }
    throw error;
  }
}

/** Validation stricte : le serveur refuse une politique hors plafond au lieu de masquer une faute de configuration. */
export function readAutonomy(value: unknown, defaults: true): AutonomyPolicy;
export function readAutonomy(value: unknown, defaults: false): Partial<AutonomyPolicy>;
export function readAutonomy(value: unknown, defaults: boolean): Partial<AutonomyPolicy> {
  if (value === undefined && defaults) return { ...AUTONOMY_DEFAULTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "AUTONOMY_POLICY_INVALID", "La politique d’autonomie est invalide.");
  }
  const input = value as Record<string, unknown>;
  const result: Partial<AutonomyPolicy> = defaults ? { ...AUTONOMY_DEFAULTS } : {};
  if (Object.hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean") throw autonomyError("enabled");
    result.enabled = input.enabled;
  }
  readBounded("maxDepth", 1, AUTONOMY_CEILINGS.maxDepth);
  readBounded("maxSteps", 1, AUTONOMY_CEILINGS.maxSteps);
  readBounded("maxHandoffs", 0, AUTONOMY_CEILINGS.maxHandoffs);
  readBounded("timeoutSeconds", 60, AUTONOMY_CEILINGS.timeoutSeconds);
  readBounded("tokenBudget", 1_000, AUTONOMY_CEILINGS.tokenBudget);
  return result;

  function readBounded(key: keyof Omit<AutonomyPolicy, "enabled">, minimum: number, maximum: number): void {
    if (!Object.hasOwn(input, key)) return;
    const candidate = input[key];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
      throw autonomyError(key);
    }
    result[key] = candidate as number;
  }
}

function autonomyError(field: string): HttpError {
  return new HttpError(400, "AUTONOMY_POLICY_INVALID", `Le champ d’autonomie « ${field} » dépasse les limites autorisées.`);
}

/**
 * Les noms de profil que Hermes refuse de créer (`_RESERVED_NAMES` de
 * `hermes_cli/profiles.py`, hermes-agent). Le slug d'un bot devient le nom de
 * son profil géré : un bot nommé « Test » ne doit pas tomber dessus.
 */
export const HERMES_RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(["hermes", "default", "test", "tmp", "root", "sudo"]);

export function slugify(input: string): string {
  const slug = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
  if (!slug) throw new HttpError(400, "BOT_SLUG_INVALID", "Le slug du bot est invalide.");
  return HERMES_RESERVED_PROFILE_NAMES.has(slug) || OPENEDBOT_SERVICE_PROFILES.has(slug) ? `${slug}-bot` : slug;
}

export function isFace(value: unknown): value is BotFaceSpec {
  if (!value || typeof value !== "object") return false;
  const face = value as Partial<BotFaceSpec>;
  return typeof face.palette === "string" && typeof face.shape === "string" &&
    typeof face.eyes === "string" &&
    (face.mouth === undefined || typeof face.mouth === "string");
}

export type EditorSettings = ReturnType<typeof readEditorSettings>;

/** Un `POST /api/bots` lu et validé : le cas d'usage ne revoit plus le corps brut. */
export type CreateBotInput = {
  name: string;
  /** Le profil Hermes explicite demandé, ou `null` (profil géré si l'hôte l'annonce). */
  profile: string | null;
  slug: string;
  description: string | null;
  mission: string | null;
  instructions: string;
  greet: boolean;
  /** La langue de l'interface de l'opérateur, lue pour l'accueil seulement. */
  operatorLocale: "fr" | "en" | null;
  voiceId: string | null;
  autonomy: AutonomyPolicy;
  sectionId: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
  face: BotFaceSpec | null;
  /**
   * The editor settings (0099) chosen at creation, written in the SAME
   * transaction as the bot row: a bot is never born with the database
   * defaults while the operator picked something else.
   */
  editor: EditorSettings;
  /**
   * The creation attempt id minted by the client (0135). A replay of the same
   * id answers the bot already created instead of creating a second one.
   */
  clientRequestId: string | null;
  /**
   * The canonical form of the request that carries `clientRequestId`
   * (`creationRequestKey`), or `null` without an id. Its digest is stored
   * with the id (0136): a replay with another body is refused, never
   * answered with the first bot.
   */
  clientRequestKey: string | null;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * What a creation request id is bound to: the route (`scope`) and the body
 * as sent, keys sorted, `clientRequestId` left out. Two sends of the same
 * frozen request give the same key whatever the key order on the wire.
 */
export function creationRequestKey(scope: string, body: Record<string, unknown>): string {
  const { clientRequestId: _id, ...rest } = body;
  return JSON.stringify({ scope, body: canonicalValue(rest) });
}

/** `clientRequestId` is optional; present, it must be a UUID, never coerced. */
export function readClientRequestId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isUuid(value)) {
    throw new HttpError(400, "BOT_CREATE_REQUEST_ID_INVALID", "L’identifiant de la demande de création est invalide.");
  }
  return value.toLowerCase();
}

export function readCreateBotInput(body: Record<string, unknown>): CreateBotInput {
  const name = assertString(body.name, "Le nom du bot", { max: 100 });
  // Le profil explicite reste compatible avec les runtimes historiques et
  // est honoré puis vérifié. Si l'hôte annonce profile_management, l'absence
  // de profil déclenche la création nommée avant l'insert.
  const rawProfile = body.hermesProfile ?? body.profile;
  const profile = rawProfile === undefined || rawProfile === null || rawProfile === ""
    ? null
    : assertString(rawProfile, "Le profil Hermes", { max: 63 });
  const slug = slugify(typeof body.slug === "string" ? body.slug : name);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 1_000) : null;
  const mission = typeof body.mission === "string" ? body.mission.trim().slice(0, 1_000) : null;
  const instructions = resolveCreateInstructions({
    instructions: readInstructions(body.instructions),
    name,
    role: description,
    mission,
  });
  const voiceId = readVoiceId(body.voiceId);
  const autonomy = readAutonomy(body.autonomy, true);
  const editor = readEditorSettings(body);
  const clientRequestId = readClientRequestId(body.clientRequestId);
  return {
    name,
    profile,
    slug,
    description,
    mission,
    instructions,
    greet: body.greet === true,
    operatorLocale: body.locale === "fr" || body.locale === "en" ? body.locale : null,
    voiceId,
    autonomy,
    sectionId: typeof body.sectionId === "string" ? body.sectionId : null,
    model: typeof body.model === "string" ? body.model : null,
    provider: typeof body.provider === "string" ? body.provider : null,
    reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
    face: isFace(body.face) ? body.face : null,
    editor,
    clientRequestId,
    clientRequestKey: clientRequestId ? creationRequestKey("bots", body) : null,
  };
}

/**
 * Un `PATCH /api/bots/:botId` lu et validé. Pour les champs qui peuvent être
 * vidés (`description`, `model`, `reasoningEffort`, `face`, `voiceId`),
 * `undefined` veut dire « absent, ne pas toucher » et `null` « vider ».
 */
export type UpdateBotInput = {
  autonomy: Partial<AutonomyPolicy> | null;
  voiceId: string | null | undefined;
  editor: EditorSettings;
  sectionId: string | null;
  /** `model` ou `provider` est présent : le profil hôte doit suivre. */
  modelChanged: boolean;
  /** `archived: false` : la restauration exige un profil hôte vivant. */
  restoring: boolean;
  archived: boolean | null;
  name: string | null;
  description: string | null | undefined;
  instructions: string | null;
  model: string | null | undefined;
  provider: string | null;
  reasoningEffort: string | null | undefined;
  pinned: boolean | null;
  face: BotFaceSpec | null | undefined;
};

export function readUpdateBotInput(body: Record<string, unknown>): UpdateBotInput {
  const autonomy = Object.hasOwn(body, "autonomy") ? readAutonomy(body.autonomy, false) : null;
  const voiceId = Object.hasOwn(body, "voiceId") ? readVoiceId(body.voiceId) : undefined;
  const editor = readEditorSettings(body);
  const sectionId = Object.hasOwn(body, "sectionId") ? readSectionId(body.sectionId) : null;
  return {
    autonomy,
    voiceId,
    editor,
    sectionId,
    modelChanged: Object.hasOwn(body, "model") || Object.hasOwn(body, "provider"),
    restoring: body.archived === false,
    archived: typeof body.archived === "boolean" ? body.archived : null,
    name: typeof body.name === "string" ? body.name.trim().slice(0, 100) : null,
    description: Object.hasOwn(body, "description")
      ? (typeof body.description === "string" ? body.description.trim().slice(0, 1_000) : null)
      : undefined,
    instructions: readInstructions(body.instructions),
    model: Object.hasOwn(body, "model") ? (typeof body.model === "string" ? body.model : null) : undefined,
    provider: typeof body.provider === "string" ? body.provider : null,
    reasoningEffort: Object.hasOwn(body, "reasoningEffort")
      ? (typeof body.reasoningEffort === "string" ? body.reasoningEffort : null)
      : undefined,
    pinned: typeof body.pinned === "boolean" ? body.pinned : null,
    face: Object.hasOwn(body, "face") ? (isFace(body.face) ? body.face : null) : undefined,
  };
}

/** Ce que l'assistant de création demande avant que le bot existe : de quoi composer une persona. */
export type CreationDraftRequest = { name: string; role: string | null; mission: string | null };

export function readCreationDraftRequest(body: Record<string, unknown>): CreationDraftRequest {
  const name = assertString(body.name, "Le nom", { max: 80 });
  const role = body.role === undefined || body.role === null
    ? null
    : assertString(body.role, "Le rôle", { max: 200 });
  const mission = body.mission === undefined || body.mission === null
    ? null
    : assertString(body.mission, "La mission", { max: 1_000 });
  return { name, role, mission };
}

/** Le hash du brouillon que l'opérateur a lu, en minuscules : la confirmation l'oppose aux octets proposés. */
export function readPersonaDraftHash(body: Record<string, unknown>): string {
  return assertString(body.hash, "Le hash du brouillon", { min: 64, max: 64 }).toLowerCase();
}
