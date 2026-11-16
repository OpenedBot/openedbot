import type { MessageReactionDto } from "@openedbot/contracts-api";
import { MESSAGE_REACTION_EMOJIS } from "@openedbot/conversation/domain/message-reply";
import type { ThreadView } from "../api";

/**
 * Reactions are independent toggles per member: one `message_reactions` row
 * per (member, message, emoji), so a member can hold ❤️ and 👍 on the same
 * reply at once. Every surface (chips, picker, context menu, touch sheet)
 * reads the same aggregate from the thread snapshot.
 */

const PALETTE_ORDER = new Map<string, number>(MESSAGE_REACTION_EMOJIS.map((emoji, index) => [emoji, index]));

/**
 * Palette order, not the server's (`order by emoji`, a byte order): a chip
 * added optimistically must not jump once the server copy replaces it.
 */
export function sortReactions(reactions: readonly MessageReactionDto[]): MessageReactionDto[] {
  const rank = (emoji: string) => PALETTE_ORDER.get(emoji) ?? PALETTE_ORDER.size;
  return [...reactions].sort((a, b) => rank(a.emoji) - rank(b.emoji) || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0));
}

export function reactedByMe(reactions: readonly MessageReactionDto[] | undefined, emoji: string): boolean {
  return Boolean(reactions?.some((reaction) => reaction.emoji === emoji && reaction.reactedByMe));
}

/** The aggregate once the current member's reaction for `emoji` is set to `on`. Unchanged input when already there. */
export function withMyReaction(
  reactions: readonly MessageReactionDto[],
  emoji: string,
  on: boolean,
): readonly MessageReactionDto[] {
  if (reactedByMe(reactions, emoji) === on) return reactions;
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (on) {
    return sortReactions(existing
      ? reactions.map((reaction) => reaction === existing ? { ...reaction, count: reaction.count + 1, reactedByMe: true } : reaction)
      : [...reactions, { emoji, count: 1, reactedByMe: true }]);
  }
  return reactions.flatMap((reaction) => {
    if (reaction !== existing) return [reaction];
    return reaction.count > 1 ? [{ ...reaction, count: reaction.count - 1, reactedByMe: false }] : [];
  });
}

/** Same snapshot (by identity) when the message is absent or already in that state. */
export function patchMessageReaction(view: ThreadView, messageId: string, emoji: string, on: boolean): ThreadView {
  let changed = false;
  const messages = view.messages.map((message) => {
    if (message.id !== messageId) return message;
    const current = message.reactions ?? [];
    const next = withMyReaction(current, emoji, on);
    if (next === current) return message;
    changed = true;
    return { ...message, reactions: [...next] };
  });
  return changed ? { ...view, messages } : view;
}
