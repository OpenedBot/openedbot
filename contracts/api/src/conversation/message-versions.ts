/** One immutable fork of a user message.  Every non-original entry lives in a
 * separate bot task/thread and therefore in a fresh Hermes session. */
export type MessageVersionLinkDto = {
  threadId: string;
  messageId: string;
  ordinal: number;
  kind: "original" | "edit" | "regenerate";
};

export type MessageVersionFamilyDto = {
  rootThreadId: string;
  rootMessageId: string;
  currentThreadId: string;
  currentMessageId: string;
  versions: MessageVersionLinkDto[];
};

export type MessageVersionFamilyListDto = { families: MessageVersionFamilyDto[] };

export type CreateMessageVersionInput = {
  mode: "edit" | "regenerate";
  /** Required for edit; regenerate reuses the immutable source text. */
  input?: string;
  /** Optimistic family size, including the original version. */
  expectedVersionCount: number;
};

export type MessageVersionCreatedDto = {
  accepted: true;
  duplicate: boolean;
  mode: "edit" | "regenerate";
  rootThreadId: string;
  rootMessageId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  branchThreadId: string;
  branchMessageId: string;
  runId: string;
  workflowId: string;
  ordinal: number;
  status: "queued";
  notificationEligible: boolean;
  workflowUpdatedAt: string;
};
