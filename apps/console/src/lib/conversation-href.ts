import { isStrictUuid } from "@openedbot/contracts-primitives";
import type { BotDto } from "@openedbot/contracts-api";

/** UUID v4 (et voisins `crypto.randomUUID`) : le seul identifiant du path `/bot`. */
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
 * Un bot, un fil : `/bot/:botId`.
 *
 * `?task=` ne désigne plus une session extra, elles n'existent plus, mais
 * une BRANCHE DE VARIANTE de message (`message-version-routes.ts`, modes
 * `edit` et `regenerate`), qui reste un fil non-default du même bot. Sans
 * `task`, c'est le fil permanent.
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

/** Ancien `/c/:slug` → `/bot` ou `/cs`. `null` si le slug n'existe pas (pas de guess). */
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

/** Href string pour les `<a>` hors TanStack et les notifications. */
export function conversationPath(botId: string, taskId?: string, focus?: string): string {
  const path = taskId
    ? `/bot/${encodeURIComponent(botId)}?task=${encodeURIComponent(taskId)}`
    : `/bot/${encodeURIComponent(botId)}`;
  if (!focus) return path;
  return `${path}${path.includes("?") ? "&" : "?"}focus=${encodeURIComponent(focus)}`;
}
