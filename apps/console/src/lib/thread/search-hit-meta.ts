import { ageSince, type Locale, type MessageKey } from "@openedbot/browser-i18n";
import type { GlobalSearchHitDto } from "@openedbot/conversation/domain/global-search";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * La ligne sous l'extrait d'un résultat de recherche, comme Grok Bot :
 * « Sniffer à vous · il y a 9 j », « Vous à Lead dev · il y a 2 j ». Dans un
 * groupe, la réponse dit où elle a été écrite (« Lead dev dans Équipe »).
 */
export function searchHitMeta(
  hit: Pick<GlobalSearchHitDto, "kind" | "role" | "authorName" | "conversationName" | "groupId" | "occurredAt">,
  t: Translate,
  locale: Locale,
): string {
  const who = hit.kind === "conversation"
    ? t("commandPalette.hitConversation")
    : hit.role === "user"
      ? t("commandPalette.hitFromYou", { name: hit.conversationName })
      : hit.groupId
        ? t("commandPalette.hitInGroup", { author: hit.authorName ?? hit.conversationName, name: hit.conversationName })
        : t("commandPalette.hitToYou", { author: hit.authorName ?? hit.conversationName });
  return `${who} · ${ageSince(locale, hit.occurredAt)}`;
}
