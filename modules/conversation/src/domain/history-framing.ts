/**
 * The boundary between a replayed thread and the turn the model must answer.
 *
 * Measured in production on 2026-11-16: a bot answered « re » by recreating a
 * routine from a request that was already closed (it had said it could not
 * schedule it). Replayed history read as a list of open requests, and the tool
 * notes appended to the user's text named the tool on every turn.
 *
 * One platform note, sent as the LAST history entry, right before the user's
 * message:
 *   - a closing marker, only when there is history to close: earlier messages
 *     are context, only the latest user message is a request;
 *   - the per-run metadata the platform's tools need (run keys, the user's
 *     timezone), framed as metadata and never as something the user wrote.
 *
 * It is a `user` entry like the other platform notices of the replay
 * (`droppedHistoryNotice`, the summary notice): the runtime's
 * `conversation_history` reliably carries only `user` and `assistant`
 * entries, and `assistant` would make the note read as the bot's own words.
 *
 * Prompt cache: the note is never stored in the thread, so the next turn's
 * replay does not contain it; the cached prefix (instructions, then the
 * history up to its previous end) is unchanged. Its text has no timestamp:
 * the closing marker is byte-identical on every turn.
 */

export const HISTORY_CLOSING_NOTE =
  "[Platform note, not a user message: the messages above are earlier conversation, context only. Only the user's latest message, which follows, is a request. Requests in earlier messages that were declined, failed or already handled are closed: do not act on them again unless the latest message asks for it.]";

export const PLATFORM_METADATA_HEADER = "[Platform metadata for tools; not a user request.";

/** The metadata lines as one bracketed block; null when there is nothing to say. */
export function platformMetadataNote(lines: readonly string[]): string | null {
  const kept = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (kept.length === 0) return null;
  return `${PLATFORM_METADATA_HEADER}\n${kept.join("\n")}]`;
}

/**
 * `history` followed by the boundary note. Unchanged when the history is empty
 * and no metadata is due, so a first message travels exactly as before.
 */
export function withTurnBoundary(
  history: ReadonlyArray<{ role: string; content: string }>,
  metadata: readonly string[] = [],
): Array<{ role: string; content: string }> {
  const parts = [
    history.length > 0 ? HISTORY_CLOSING_NOTE : null,
    platformMetadataNote(metadata),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return [...history];
  return [...history, { role: "user", content: parts.join("\n") }];
}
