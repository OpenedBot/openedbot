import { isStrictUuid } from "@openedbot/contracts-primitives";
import type { BotDto } from "@openedbot/contracts-api";

/** UUID v4 (and neighbors of `crypto.randomUUID`): the only identifier of the `/bot` path. */
export function isRouteUuid(value: string): boolean {
  return isStrictUuid(value);
}

export type ConversationTo = "/bot/$botId";

export type ConversationHref = {
  to: ConversationTo;
  params: { botId: string };
  search: { task?: string; focus?: string };
};

/**
 * One bot, one thread: `/bot/:botId`.
 *
 * `?task=` no longer names an extra session, those no longer exist, but
 * a message VARIANT BRANCH (`message-version-routes.ts`, modes
 * `edit` and `regenerate`), which stays a non-default thread of the same bot. Without
 * `task`, it is the permanent thread.
 */
export function conversationHref(
  bot: Pick<BotDto, "id">,
  branch?: { threadId: string; isDefault: boolean } | null,
  extras?: { focus?: string },
): ConversationHref {
  const focus = extras?.focus ? { focus: extras.focus } : {};
  return {
    to: "/bot/$botId",
    params: { botId: bot.id },
    search: !branch || branch.isDefault ? focus : { task: branch.threadId, ...focus },
  };
}

/** Former `/c/:slug` → `/bot` or `/cs`. `null` if the slug does not exist (no guess). */
export function resolveLegacyConversation(
  slug: string,
  search: { task?: string; focus?: string },
  bots: ReadonlyArray<Pick<BotDto, "id" | "slug">>,
): ConversationHref | null {
  const bot = bots.find((candidate) => candidate.slug === slug);
  if (!bot) return null;
  return {
    to: "/bot/$botId",
    params: { botId: bot.id },
    search: {
      ...(search.task ? { task: search.task } : {}),
      ...(search.focus ? { focus: search.focus } : {}),
    },
  };
}

/** Href string for `<a>` outside TanStack and for notifications. */
export function conversationPath(botId: string, taskId?: string, focus?: string): string {
  const path = taskId
    ? `/bot/${encodeURIComponent(botId)}?task=${encodeURIComponent(taskId)}`
    : `/bot/${encodeURIComponent(botId)}`;
  if (!focus) return path;
  return `${path}${path.includes("?") ? "&" : "?"}focus=${encodeURIComponent(focus)}`;
}
