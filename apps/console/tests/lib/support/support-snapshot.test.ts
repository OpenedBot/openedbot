import { describe, expect, test } from "bun:test";
import type { SupportSnapshotDto } from "@openedbot/contracts-api";
import {
  applySupportFrame,
  mergeSupportSnapshot,
  pendingMessage,
} from "../../../src/lib/support/support-snapshot";

function snapshot(messages: SupportSnapshotDto["messages"] = []): SupportSnapshotDto {
  return {
    conversationId: "11111111-1111-4111-8111-111111111111",
    email: "visiteur@example.test",
    status: "open",
    messages,
    cursor: 10,
    unreadCount: 0,
    createdAt: "2026-09-12T08:00:00.000Z",
    updatedAt: "2026-09-12T08:00:00.000Z",
  };
}

const staffFrame = {
  cursor: 11,
  type: "support.message",
  payload: { messageId: "m-staff", author: "staff", staffName: "Elodie", body: "on regarde" },
  occurredAt: "2026-09-12T08:01:00.000Z",
};

describe("application d'une trame du guichet", () => {
  test("ajoute la réponse du staff avec son nom", () => {
    const next = applySupportFrame(snapshot(), staffFrame);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({ author: "staff", staffName: "Elodie", body: "on regarde" });
  });

  test("une trame rejouée ne double pas le message", () => {
    const once = applySupportFrame(snapshot(), staffFrame);
    const twice = applySupportFrame(once, staffFrame);
    expect(twice.messages).toHaveLength(1);
    // Même objet : aucun rendu inutile.
    expect(twice).toBe(once);
  });

  test("trie par date, même si les trames arrivent à l'envers", () => {
    const late = applySupportFrame(snapshot(), staffFrame);
    const early = applySupportFrame(late, {
      cursor: 9,
      type: "support.message",
      payload: { messageId: "m-guest", author: "guest", body: "bonjour" },
      occurredAt: "2026-09-12T07:59:00.000Z",
    });
    expect(early.messages.map((message) => message.id)).toEqual(["m-guest", "m-staff"]);
  });

  test("le message confirmé remplace la bulle optimiste du même texte", () => {
    const optimistic = snapshot([pendingMessage("abc", "bonjour")]);
    const confirmed = applySupportFrame(optimistic, {
      cursor: 12,
      type: "support.message",
      payload: { messageId: "m-guest", author: "guest", body: "bonjour" },
      occurredAt: "2026-09-12T08:02:00.000Z",
    });
    expect(confirmed.messages).toHaveLength(1);
    expect(confirmed.messages[0]?.id).toBe("m-guest");
  });

  test("un changement d'état ferme ou réouvre le fil, et ne bouge pas sinon", () => {
    const closed = applySupportFrame(snapshot(), {
      cursor: 13,
      type: "support.status",
      payload: { status: "closed" },
      occurredAt: "2026-09-12T08:03:00.000Z",
    });
    expect(closed.status).toBe("closed");
    expect(applySupportFrame(closed, {
      cursor: 14,
      type: "support.status",
      payload: { status: "closed" },
      occurredAt: "2026-09-12T08:04:00.000Z",
    })).toBe(closed);
  });

  test("une trame de frappe ne touche pas au fil", () => {
    const base = snapshot();
    expect(applySupportFrame(base, {
      cursor: 0,
      type: "support.typing",
      payload: { author: "staff" },
      occurredAt: "2026-09-12T08:05:00.000Z",
    })).toBe(base);
  });

  test("une trame difforme est ignorée plutôt que rendue", () => {
    const base = snapshot();
    expect(applySupportFrame(base, {
      cursor: 15,
      type: "support.message",
      payload: { author: "staff" },
      occurredAt: "2026-09-12T08:06:00.000Z",
    })).toBe(base);
  });
});

describe("fusion d'un instantané serveur", () => {
  test("garde la bulle optimiste que le serveur n'a pas encore rendue", () => {
    const previous = snapshot([pendingMessage("abc", "toujours là")]);
    const merged = mergeSupportSnapshot(previous, snapshot());
    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]?.body).toBe("toujours là");
  });

  test("laisse tomber la bulle optimiste que le serveur confirme", () => {
    const previous = snapshot([pendingMessage("abc", "bonjour")]);
    const merged = mergeSupportSnapshot(previous, snapshot([
      { id: "m-guest", author: "guest", staffName: null, body: "bonjour",
      attachments: [], createdAt: "2026-09-12T08:00:01.000Z" },
    ]));
    expect(merged.messages.map((message) => message.id)).toEqual(["m-guest"]);
  });
});
