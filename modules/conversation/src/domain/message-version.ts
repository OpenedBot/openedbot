import type { MessageVersionFamilyDto } from "@openedbot/contracts-api";

export const MESSAGE_VERSION_FAMILY_LIMIT = 20;

export type MessageVersionPrecondition =
  | { kind: "accepted"; ordinal: number }
  | { kind: "conflict"; actualVersionCount: number }
  | { kind: "limit"; actualVersionCount: number };

/**
 * One family always contains the immutable original plus its durable branch
 * rows. `ordinal` is therefore also the number of branches that existed
 * immediately before the new one.
 */
export function messageVersionPrecondition(
  existingBranchCount: number,
  expectedVersionCount: number,
): MessageVersionPrecondition {
  const actualVersionCount = existingBranchCount + 1;
  if (expectedVersionCount !== actualVersionCount) return { kind: "conflict", actualVersionCount };
  if (actualVersionCount >= MESSAGE_VERSION_FAMILY_LIMIT) return { kind: "limit", actualVersionCount };
  return { kind: "accepted", ordinal: actualVersionCount };
}

export function currentMessageVersionIndex(family: MessageVersionFamilyDto): number {
  return family.versions.findIndex((version) =>
    version.threadId === family.currentThreadId && version.messageId === family.currentMessageId);
}
