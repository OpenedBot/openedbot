import { describe, expect, test } from "bun:test";
import { replyPreviewSnippet } from "../src/domain/message-reply";

describe("replyPreviewSnippet", () => {
  test("flattens a card heading into one line", () => {
    expect(replyPreviewSnippet("## Réponses\n\n1. S = {3 ; 4}")).toBe("Réponses 1. S = {3 ; 4}");
  });

  test("truncates a course wall", () => {
    const wall = "Cours : les équations du second degré\n\nDéfinition\nUne équation du second degré est une équation qui peut s’écrire sous la forme : ax² + bx + c = 0";
    const snippet = replyPreviewSnippet(wall);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(92);
    expect(snippet.startsWith("Cours :")).toBe(true);
  });
});
