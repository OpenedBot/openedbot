import type { MessageAttachmentInput } from "./attachments";

export type MessageSubmissionDraft = {
  input: string;
  attachments: readonly MessageAttachmentInput[];
  /** Le message cité fait partie de l'opération logique et de son idempotence. */
  replyToId?: string | null;
  /** « Planifier d'abord » : le tour ne fait qu'un plan (0155), et compte dans l'idempotence. */
  planOnly?: boolean;
};

export type IdempotentMessageSubmission = MessageSubmissionDraft & {
  idempotencyKey: string;
};

/**
 * Reuses the key only for the exact logical submission that just failed.
 * A changed character or attachment starts a new operation, while an
 * authentication/network replay remains safely idempotent.
 */
export function prepareMessageSubmission(
  previous: IdempotentMessageSubmission | null,
  draft: MessageSubmissionDraft,
  createKey: () => string,
): IdempotentMessageSubmission {
  if (previous && sameDraft(previous, draft)) return previous;
  return {
    input: draft.input,
    attachments: [...draft.attachments],
    ...(draft.replyToId ? { replyToId: draft.replyToId } : {}),
    ...(draft.planOnly ? { planOnly: true } : {}),
    idempotencyKey: createKey(),
  };
}

function sameDraft(left: MessageSubmissionDraft, right: MessageSubmissionDraft): boolean {
  if (
    left.input !== right.input ||
    (left.replyToId ?? null) !== (right.replyToId ?? null) ||
    (left.planOnly === true) !== (right.planOnly === true) ||
    left.attachments.length !== right.attachments.length
  ) return false;
  return left.attachments.every((attachment, index) => {
    const other = right.attachments[index];
    if (
      !other ||
      attachment.name !== other.name ||
      attachment.contentType !== other.contentType ||
      attachment.kind !== other.kind ||
      attachment.content.length !== other.content.length
    ) {
      return false;
    }
    return attachment.content.every((part, partIndex) => {
      const otherPart = other.content[partIndex];
      if (!otherPart || part.type !== otherPart.type) return false;
      return part.type === "text"
        ? otherPart.type === "text" && part.text === otherPart.text
        : otherPart.type === "image" && part.image === otherPart.image;
    });
  });
}
