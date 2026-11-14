/**
 * Domain types shared by the cloud API and the clients.
 *
 * They describe the shape of the data, not its storage. Keeping them here avoids
 * pulling the PostgreSQL driver into the UI bundles.
 */

export type MessageContent = Array<
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
    }
  /**
   * An attachment, as the THREAD shows it (US-CHAT-08): its identity
   * and the `id` of the row that keeps its bytes, not the bytes themselves. The
   * file STAYS in the message (table `message_attachments`, served by
   * `GET /api/attachments/:id`); inlining it here would make every thread
   * read carry the weight of all its images, including when nobody is
   * looking at them.
   */
  | {
      type: "attachment";
      /**
       * The `message_attachments` row that keeps the file,
       * `GET /api/attachments/:id`.
       *
       * OPTIONAL, and that is not a convenience: messages written between
       * the arrival of attachments and their durable storage carry a part
       * without an identifier, because their file was never stored
       * anywhere. Typing it required would make the database lie, and a React key
       * `undefined` is the first symptom one harvests. Without `id`, a
       * part is read but does not open: there is nothing to open.
       */
      id?: string;
      name: string;
      contentType: string;
      kind: "image" | "document";
      /** Size of the original file, not of its encoding: see `attachmentBytes`. */
      bytes: number;
    }
>;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RuntimeHealthStatus =
  | "unknown"
  | "healthy"
  | "unreachable"
  | "unauthorized"
  | "missing_feature"
  /** `connector` runtime whose link is not open: the host has not presented itself. */
  | "disconnected"
  /**
   * Reachable, token accepted, and yet no bot will answer, for lack of an
   * authenticated inference provider. This is the state of a fresh
   * install, and confusing it with `healthy` was the lie of the
   * « Tester » button: URL, token and provider are three settings, not one.
   */
  | "no_provider";
