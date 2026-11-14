import { clear, createStore, del, entries, set } from "idb-keyval";
import type { MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import type { IdempotentMessageSubmission } from "@openedbot/conversation/domain/message-submission";

export type PendingMessageDraft = {
  input: string;
  attachments: MessageAttachmentInput[];
  replyToId?: string | null;
  planOnly?: boolean;
};

export type PendingMessageRequest = {
  threadId: string;
  scope: string;
  rosterKey: string;
  owner: string;
  generation: number;
  submission: IdempotentMessageSubmission;
  draft: PendingMessageDraft;
  persisted?: boolean;
};

let database: ReturnType<typeof createStore> | undefined;
function store() {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable");
  return database ??= createStore("openedbot-pending-messages", "messages");
}

function prefix(owner: string, scope: string): string {
  return JSON.stringify([owner, scope]);
}

function key(request: PendingMessageRequest): string {
  return `${prefix(request.owner, request.scope)}:${request.submission.idempotencyKey}`;
}

function isDraft(value: unknown): value is PendingMessageDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<PendingMessageDraft>;
  return typeof draft.input === "string" && (draft.replyToId == null || typeof draft.replyToId === "string")
    && (draft.planOnly === undefined || typeof draft.planOnly === "boolean")
    && Array.isArray(draft.attachments) && draft.attachments.every((attachment) =>
      attachment && typeof attachment.name === "string" && typeof attachment.contentType === "string"
      && (attachment.kind === "image" || attachment.kind === "document") && Array.isArray(attachment.content)
      && attachment.content.every((part: unknown) => {
        if (!part || typeof part !== "object") return false;
        return "type" in part && (part.type === "text" && "text" in part && typeof part.text === "string"
          || part.type === "image" && "image" in part && typeof part.image === "string");
      }));
}

/** Separate from the query cache: builds must never invalidate an unsent message. */
export const pendingMessageStore = {
  generation: 0,
  memory: new Map<string, { request: PendingMessageRequest; failed: boolean }>(),
  async read(owner: string, scope: string): Promise<PendingMessageRequest | null> {
    if (typeof indexedDB === "undefined") return null;
    const generation = this.generation;
    for (const [storedKey, value] of await entries<string, unknown>(store())) {
      if (typeof storedKey !== "string" || !storedKey.startsWith(`${prefix(owner, scope)}:`)) continue;
      if (!value || typeof value !== "object") throw new Error("Invalid pending message");
      const request = value as Partial<PendingMessageRequest>;
      if (request.owner !== owner || request.scope !== scope || typeof request.threadId !== "string"
        || typeof request.rosterKey !== "string" || !isDraft(request.draft) || !isDraft(request.submission)
        || typeof request.submission.idempotencyKey !== "string") throw new Error("Invalid pending message");
      if (generation !== this.generation) return null;
      return { threadId: request.threadId, scope, owner, rosterKey: request.rosterKey,
        submission: request.submission, draft: request.draft, generation, persisted: true };
    }
    return null;
  },
  async write(request: PendingMessageRequest): Promise<void> {
    if (request.generation !== this.generation) throw new Error("Pending message session was cleared");
    await set(key(request), request, store());
    // Sign-out can finish while the transaction was waiting: do not resurrect
    // the old user's words or dispatch the request under a new session.
    if (request.generation !== this.generation) {
      await del(key(request), store());
      throw new Error("Pending message session was cleared");
    }
  },
  async remove(request: PendingMessageRequest): Promise<void> {
    await del(key(request), store());
  },
  async clear(): Promise<void> {
    this.generation += 1;
    this.memory.clear();
    if (typeof indexedDB !== "undefined") await clear(store());
  },
};
