import type { WorkflowStatus } from "../execution/runs";
import type { BotFaceSpec } from "../shared/bot-face";

export type InboxItemKind = "approval" | "needs_review" | "needs_you";

type InboxThreadRef = {
  threadId: string;
  isDefaultThread: boolean;
  botId: string | null;
  botSlug: string | null;
  botName: string | null;
  botFace: BotFaceSpec | null;
  groupId: string | null;
  groupName: string | null;
};

export type InboxApprovalItemDto = InboxThreadRef & {
  kind: "approval";
  id: string; // approvalId
  occurredAt: string; // created_at
  approvalId: string;
  runId: string;
  summary: string | null; // left(description,160), JAMAIS command
  expiresAt: string;
};

export type InboxNeedsReviewItemDto = InboxThreadRef & {
  kind: "needs_review";
  id: string; // workflowId
  occurredAt: string; // coalesce(ended_at, updated_at)
  workflowId: string;
  status: Extract<WorkflowStatus, "unknown" | "failed" | "expired">;
  recoveryState: "needs_review" | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  endedAt: string | null;
  initiatorName: string | null;
};

export type InboxNeedsYouItemDto = InboxThreadRef & {
  kind: "needs_you";
  id: string; // groupId
  occurredAt: string; // bot_groups.updated_at
};

export type InboxItemDto = InboxApprovalItemDto | InboxNeedsReviewItemDto | InboxNeedsYouItemDto;

export type InboxCountsDto = { approval: number; needsReview: number; needsYou: number; total: number };

export type InboxDto = { items: InboxItemDto[]; counts: InboxCountsDto };
