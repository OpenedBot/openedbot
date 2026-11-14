import type { ApprovalRequestDto, BotPermissionMode, BotSettingProposalDto, SendMessageAccepted, ThreadSnapshot } from "@openedbot/contracts-api";
import type { PortableBotCreationDraft } from "@openedbot/roster/domain/bot-clone";

export type ThreadView = ThreadSnapshot & {
  approvals: ApprovalRequestDto[];
  /** The bot's proposals on its persona and its settings; absent from an earlier API. */
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
   * Provider of the requested model. `POST /api/bots` already reads it to lift
   * the ambiguity when two authenticated providers serve the same
   * model identifier; without it, the first in the catalog wins.
   */
  provider?: string;
  /** The bot speaks first: it introduces itself and asks a framing question. */
  greet?: boolean;
  /** The operator's interface language: the welcome's, when the bot does not impose one. */
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
 * Scope of an onboarding reset, as the cloud API reads it
 * in the body of `POST /api/onboarding/reset`. Declared locally until
 * `@openedbot/contracts-api` publishes it.
 */
export type OnboardingResetScope = "flag" | "full";

export type MobileConnectTicketDto = { ticketId: string; url: string; expiresAt: string };
