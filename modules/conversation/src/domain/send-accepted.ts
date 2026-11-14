import type {
  MessageReplyPreview,
  RunDto,
  ThreadMessageDto,
  WorkflowDto,
} from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { MessageContent } from "@openedbot/contracts-api";
import { displayContent, type StoredAttachment } from "./attachments";
import type { ReplyPromptContext } from "./message-reply";

export function acceptedUserMessage(input: {
  id: string;
  clientSubmissionId?: string | null;
  runId: string;
  text: string;
  stored: readonly StoredAttachment[];
  replyTarget: ReplyPromptContext | null;
  createdAt: string;
}): ThreadMessageDto {
  const replyTo = replyPreview(input.replyTarget);
  return {
    id: input.id,
    clientSubmissionId: input.clientSubmissionId ?? null,
    role: "user",
    content: displayContent(input.text, input.stored),
    runId: input.runId,
    createdAt: input.createdAt,
    authorBot: null,
    replyTo,
    reactions: [],
  };
}

function replyPreview(target: ReplyPromptContext | null): MessageReplyPreview | null {
  if (!target) return null;
  const role = target.role === "assistant" ? "assistant" : "user";
  return {
    id: target.id,
    role,
    content: Array.isArray(target.content) ? target.content : [],
    authorBot: null,
  };
}

export function acceptedQueuedRun(input: {
  id: string;
  botId: string;
  text: string;
  workflowId: string | null;
  stepKind: RunDto["stepKind"];
  stackDepth: number;
  createdAt: string;
}): RunDto {
  return {
    id: input.id,
    status: "queued",
    botId: input.botId,
    input: input.text,
    output: null,
    usage: null,
    error: null,
    errorCode: null,
    hermesResponseId: null,
    model: null,
    runtimeSession: null,
    createdAt: input.createdAt,
    startedAt: null,
    endedAt: null,
    lastEventAt: null,
    workflowId: input.workflowId,
    stepIndex: 0,
    stepKind: input.stepKind,
    stackDepth: input.stackDepth,
    completionKind: null,
    recoveryState: null,
  };
}

export function acceptedQueuedWorkflow(input: {
  id: string;
  kind: WorkflowDto["kind"];
  rootRunId: string;
  rootBotId: string | null;
  autonomyEnabled: boolean;
  maxSteps: number;
  maxHandoffs: number;
  usedHandoffs: number;
  tokenBudget: number;
  timeoutSeconds: number;
  createdAt: string;
}): WorkflowDto {
  const deadline = new Date(Date.parse(input.createdAt) + input.timeoutSeconds * 1000);
  return {
    id: input.id,
    kind: input.kind,
    status: "queued",
    rootRunId: input.rootRunId,
    rootBotId: input.rootBotId,
    usedSteps: 1,
    maxSteps: input.maxSteps,
    usedHandoffs: input.usedHandoffs,
    maxHandoffs: input.maxHandoffs,
    usedTokens: 0,
    tokenBudget: input.tokenBudget,
    deadlineAt: Number.isNaN(deadline.getTime()) ? input.createdAt : deadline.toISOString(),
    errorCode: null,
    errorMessage: null,
    recoveryState: null,
    autonomyEnabled: input.autonomyEnabled,
    notificationSequence: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function acceptedHandoffEvents(input: {
  runId: string;
  createdAt: string;
  sent: Record<string, unknown>;
  received: Record<string, unknown>;
}): StoredProductEvent[] {
  const occurredAt = new Date(input.createdAt);
  return [
    {
      cursor: 0,
      runId: input.runId,
      sequence: 0,
      type: "system.notice",
      payload: input.sent,
      occurredAt,
    },
    {
      cursor: 0,
      runId: input.runId,
      sequence: 1,
      type: "system.notice",
      payload: input.received,
      occurredAt,
    },
  ];
}

export function messagePreviewText(content: MessageContent, maxLength = 160): string | null {
  const text = content
    .filter((part): part is Extract<MessageContent[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}
