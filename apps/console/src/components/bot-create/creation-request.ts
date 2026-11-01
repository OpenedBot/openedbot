import type { BotDto, BotFaceSpec, BotPermissionMode } from "@openedbot/contracts-api";
import type { PortableBotCreationDraft } from "@openedbot/roster/domain/bot-clone";
import { api } from "../../lib/api";

/**
 * One bot creation, frozen when the operator clicks « Créer » : the sheet
 * closes and resets before the server answers, so the request never reads
 * the form again. `clientRequestId` makes it replayable (0135): sending the
 * SAME request twice (double click, lost response, « Réessayer » on the
 * waiting screen) answers the bot of the first attempt, never a second bot.
 */
export type BotCreationRequest = {
  clientRequestId: string;
  name: string;
  /** The few words under the name; also the persona role and the roster description. */
  role: string;
  mission: string;
  /** Exactly the persona text the sheet displayed: never recomposed on the way. */
  instructions: string;
  /** An explicit Hermes profile, only on hosts without `profile_management`. */
  hermesProfile: string | null;
  face: BotFaceSpec;
  permissionMode: BotPermissionMode;
  notifyOnFinish: boolean;
  greet: boolean;
  locale: "fr" | "en";
  /** Presentation settings and model carried by a duplicate (never its permission mode). */
  copied: Omit<PortableBotCreationDraft, "name" | "instructions" | "face" | "hermesProfile" | "label"> | null;
  /** The label a preset brings when the role field stays empty. */
  presetLabel: string | null;
};

/** The single API call of a creation: settings travel with the bot row. */
export async function sendBotCreation(request: BotCreationRequest): Promise<BotDto> {
  const label = request.role || request.presetLabel || null;
  // A duplicate keeps its source's long description; a new bot's description is its role.
  const description = request.copied?.description || request.role;
  return api.createBot({
    ...request.copied,
    name: request.name,
    ...(request.hermesProfile ? { hermesProfile: request.hermesProfile } : {}),
    face: request.face,
    instructions: request.instructions,
    ...(description ? { description } : {}),
    ...(request.mission ? { mission: request.mission } : {}),
    ...(label ? { label } : {}),
    permissionMode: request.permissionMode,
    notifyOnFinish: request.notifyOnFinish,
    greet: request.greet,
    locale: request.locale,
    clientRequestId: request.clientRequestId,
  });
}
