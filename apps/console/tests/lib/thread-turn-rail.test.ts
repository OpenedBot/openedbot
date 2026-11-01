import { describe, expect, test } from "bun:test";
import type { ThreadMessageDto } from "@openedbot/contracts-api";
import { buildThreadRailTurns } from "../../src/lib/thread-turn-rail";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  authorBot?: ThreadMessageDto["authorBot"],
): ThreadMessageDto {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    runId: null,
    createdAt: "2026-10-08T00:00:00.000Z",
    authorBot: authorBot ?? null,
  };
}

const bot = { id: "bot-1", name: "Recette", slug: "recette", face: null };

describe("buildThreadRailTurns", () => {
  test("un trait par message opérateur, la réponse est le premier assistant", () => {
    expect(buildThreadRailTurns([
      message("u1", "user", "Question une"),
      message("a1", "assistant", "Réponse une"),
      message("u2", "user", "Question deux"),
      message("a2", "assistant", "Réponse deux"),
    ])).toEqual([
      { targetId: "message:u1", question: "Question une", answer: "Réponse une" },
      { targetId: "message:u2", question: "Question deux", answer: "Réponse deux" },
    ]);
  });

  test("un user écrit par un autre bot ne prend pas de trait et ne vole pas la réponse", () => {
    expect(buildThreadRailTurns([
      message("u1", "user", "Brief"),
      message("in", "user", "Je prends le panier", bot),
      message("a1", "assistant", "Synthèse"),
      message("a2", "assistant", "Deuxième contribution"),
    ])).toEqual([
      { targetId: "message:u1", question: "Brief", answer: "Synthèse" },
    ]);
  });
});
