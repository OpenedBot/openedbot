import type { ApprovalRequestDto, BotPermissionMode, BotSettingProposalDto, SendMessageAccepted, ThreadSnapshot } from "@openedbot/contracts-api";
import type { PortableBotCreationDraft } from "@openedbot/roster/domain/bot-clone";

export type ThreadView = ThreadSnapshot & {
  approvals: ApprovalRequestDto[];
  /** Propositions du bot sur sa persona et ses réglages ; absent d'une API antérieure. */
  settingProposals?: BotSettingProposalDto[];
  /** Client cache has fetched at least one page before the recent window. */
  historyLoaded?: true;
};

export type SendMessageResult = SendMessageAccepted;

export type WorkflowRecoveryResult = SendMessageResult & { duplicateRisk?: true };

export type CreateBotInput = Omit<PortableBotCreationDraft, "instructions" | "reasoningEffort"> & {
  instructions?: string;
  mission?: string;
  reasoningEffort?: string;
  sectionId?: string;
  /**
   * Fournisseur du modèle demandé. `POST /api/bots` le lit déjà pour lever
   * l'ambiguïté quand deux fournisseurs authentifiés servent le même
   * identifiant de modèle ; sans lui, le premier du catalogue gagne.
   */
  provider?: string;
  /** Le bot parle en premier : il se présente et pose une question de cadrage. */
  greet?: boolean;
  /** La langue de l'interface de l'opérateur : celle de l'accueil quand le bot n'en impose pas. */
  locale?: "fr" | "en";
  /** Written with the bot row, in the same transaction (never a second PATCH). */
  permissionMode?: BotPermissionMode;
  /**
   * One UUID per creation attempt (0135): a retry with the same id AND the
   * same body answers the bot already created (`200`, `creationReplayed`)
   * instead of a second bot; another body under that id is a 409 (0136).
   */
  clientRequestId?: string;
};

/**
 * Portée d'une remise à zéro de l'accueil, telle que le cloud API la lit
 * dans le corps de `POST /api/onboarding/reset`. Déclarée localement tant
 * que `@openedbot/contracts-api` ne la publie pas.
 */
export type OnboardingResetScope = "flag" | "full";

export type MobileConnectTicketDto = { ticketId: string; url: string; expiresAt: string };
