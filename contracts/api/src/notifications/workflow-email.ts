export type WorkflowEmailPreferences = {
  approval: boolean;
  completed: boolean;
  failed: boolean;
  locale: "fr" | "en";
  checklistHidden: boolean;
};
export type ActivationDto = {
  machine: boolean;
  model: boolean;
  bot: boolean;
  result: boolean;
  machineOnline: boolean;
  firstBotId: string | null;
};
export type ConversationFileDto = {
  id: string;
  messageId: string;
  name: string;
  contentType: string;
  kind: "image" | "document";
  bytes: number;
  createdAt: string;
  role: "user" | "assistant" | "system";
};
export type ConversationFilesDto = {
  files: ConversationFileDto[];
  nextCursor: string | null;
};
