import { describe, expect, test } from "bun:test";
import { t } from "@openedbot/browser-i18n";
import type { Locale, MessageKey } from "@openedbot/browser-i18n";
import { searchHitMeta } from "../../src/lib/search-hit-meta";

const translate = (locale: Locale) => (key: MessageKey, params?: Record<string, string | number>) => t(locale, key, params);
const nineDaysAgo = new Date(Date.now() - 9 * 86_400_000).toISOString();
const hit = {
  kind: "message" as const,
  role: "assistant" as const,
  authorName: "Sniffer",
  conversationName: "Sniffer",
  groupId: null,
  occurredAt: nineDaysAgo,
};

describe("ligne de méta d'un résultat de recherche", () => {
  test("la réponse d'un bot : « Sniffer à vous · il y a 9 j »", () => {
    expect(searchHitMeta(hit, translate("fr"), "fr")).toBe("Sniffer à vous · il y a 9 j");
  });

  test("un message de l'opérateur dit à qui il a écrit", () => {
    expect(searchHitMeta({ ...hit, role: "user", authorName: null, conversationName: "Lead dev" }, translate("fr"), "fr"))
      .toBe("Vous à Lead dev · il y a 9 j");
  });

  test("dans un groupe, la réponse dit où elle a été écrite", () => {
    expect(searchHitMeta({ ...hit, authorName: "Lead dev", conversationName: "Équipe", groupId: "g-1" }, translate("fr"), "fr"))
      .toBe("Lead dev dans Équipe · il y a 9 j");
  });

  test("un titre de conversation trouvé, et un auteur inconnu", () => {
    expect(searchHitMeta({ ...hit, kind: "conversation", role: null, authorName: null }, translate("fr"), "fr"))
      .toBe("Conversation · il y a 9 j");
    expect(searchHitMeta({ ...hit, authorName: null }, translate("en"), "en")).toBe("Sniffer to you · 9 d ago");
  });
});
