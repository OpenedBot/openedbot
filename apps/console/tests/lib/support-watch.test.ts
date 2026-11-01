import { describe, expect, test } from "bun:test";
import type { SupportEventDto, SupportHistoryDto, SupportThreadSummaryDto } from "@openedbot/contracts-api";
import { isStaffReply, sumSupportUnread, supportWatchTarget } from "../../src/lib/support-watch";

function summary(over: Partial<SupportThreadSummaryDto> = {}): SupportThreadSummaryDto {
  return {
    conversationId: "11111111-1111-4111-8111-111111111111",
    status: "open",
    unreadCount: 0,
    cursor: 12,
    messageCount: 3,
    lastMessageAuthor: "staff",
    lastMessagePreview: "on regarde",
    lastMessageAt: "2026-09-12T08:05:00.000Z",
    createdAt: "2026-09-12T08:00:00.000Z",
    updatedAt: "2026-09-12T08:05:00.000Z",
    ...over,
  };
}

function history(conversations: SupportThreadSummaryDto[]): SupportHistoryDto {
  return { conversations };
}

function frame(over: Partial<SupportEventDto> = {}): SupportEventDto {
  return {
    cursor: 13,
    conversationId: "11111111-1111-4111-8111-111111111111",
    type: "support.message",
    payload: { author: "staff", messageId: "m-1", body: "on regarde" },
    occurredAt: "2026-09-12T08:06:00.000Z",
    ...over,
  };
}

describe("le compteur de la bulle", () => {
  test("additionne les non-lus de TOUS les fils", () => {
    // Quelqu'un qui a deux fils ouverts attend deux réponses, et la bulle doit
    // dire combien, pas sur lequel.
    expect(sumSupportUnread(history([
      summary({ unreadCount: 2 }),
      summary({ conversationId: "22222222-2222-4222-8222-222222222222", unreadCount: 1 }),
    ]))).toBe(3);
  });

  test("vaut zéro sur un historique vide", () => {
    expect(sumSupportUnread(history([]))).toBe(0);
  });
});

describe("le fil surveillé", () => {
  test("est le premier de l’historique, celui que le serveur a trié en tête", () => {
    const recent = summary({ conversationId: "22222222-2222-4222-8222-222222222222" });
    expect(supportWatchTarget(history([recent, summary()]))?.conversationId).toBe(recent.conversationId);
  });

  test("n’existe pas quand il n’y a aucun fil : rien à surveiller, aucun flux", () => {
    expect(supportWatchTarget(history([]))).toBeNull();
  });

  test("porte le curseur DÉJÀ compté, pour que le flux ne recompte pas l’historique", () => {
    // C'est la garantie qui empêche la bulle d'afficher « 4 » pour deux
    // réponses : le flux s'abonne après ce curseur.
    expect(supportWatchTarget(history([summary({ cursor: 41 })]))?.cursor).toBe(41);
  });
});

describe("ce qui incrémente le compteur", () => {
  test("une réponse du staff, et elle seule", () => {
    expect(isStaffReply(frame())).toBe(true);
    expect(isStaffReply(frame({ payload: { author: "guest", messageId: "m-2", body: "bonjour" } }))).toBe(false);
    expect(isStaffReply(frame({ type: "support.typing", payload: { author: "staff" } }))).toBe(false);
    expect(isStaffReply(frame({ type: "support.read", payload: {} }))).toBe(false);
  });
});
