import { describe, expect, test } from "bun:test";
import {
  closeOpenMath,
  splitMarkdownBlocks,
  splitMarkdownBlocksFrom,
  stabilizeStreamingThreadMarkdown,
  type MarkdownBlockSplit,
} from "../../../src/lib/stream/streaming-markdown";

describe("closeOpenMath", () => {
  test("closes an open display block", () => {
    expect(closeOpenMath("$$ax^2")).toBe("$$ax^2\n$$");
  });

  test("closes an open inline dollar", () => {
    expect(closeOpenMath("Soit $x")).toBe("Soit $x$");
  });

  test("leaves balanced math alone", () => {
    expect(closeOpenMath("$$a$$ and $b$")).toBe("$$a$$ and $b$");
  });

  test("ignores dollars inside a fence", () => {
    expect(closeOpenMath("```\n$ not math\n```")).toBe("```\n$ not math\n```");
  });
});

describe("stabilizeStreamingThreadMarkdown", () => {
  test("closes both a fence and math", () => {
    expect(stabilizeStreamingThreadMarkdown("```ts\nconst x")).toBe("```ts\nconst x\n```");
    expect(stabilizeStreamingThreadMarkdown("La racine $x")).toBe("La racine $x$");
  });
});

describe("splitMarkdownBlocksFrom", () => {
  // Answers streamed one character at a time: every intermediate split must
  // be the full split of that prefix, whatever the resumed cut.
  const answers = [
    "# Titre\n\nUn paragraphe.\n\n- un\n- deux\n\n- trois, liste lâche\n\nFin.",
    "Avant\n\n1 seul\n\n1. un\n2. deux\n\nAprès",
    "Texte\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nSuite\n\n$$\na\n\nb\n$$\n\nFin",
    "Un\n\n  indenté\n\nDeux\n\n[lien]: https://example.com\n\nTrois",
    "A\n\n<div>\n\nB\n\n</div>\n\nC",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAprès le tableau\n\n> citation\n\n-\n\n- puce",
    // « 1 » coupe, « 1. » prolonge la liste lâche : la coupe n'est pas encore décidée.
    "- a\n- b\n\n1. c\n\nFin",
  ];
  for (const answer of answers) {
    test(`matches a full split at every prefix of ${JSON.stringify(answer.slice(0, 24))}`, () => {
      let split: MarkdownBlockSplit | undefined;
      for (let length = 0; length <= answer.length; length += 1) {
        const prefix = answer.slice(0, length);
        split = splitMarkdownBlocksFrom(split, prefix);
        expect(split.blocks).toEqual(splitMarkdownBlocks(prefix));
      }
    });
  }

  test("starts over when the text is not an extension", () => {
    const first = splitMarkdownBlocksFrom(undefined, "Un\n\nDeux\n\nTrois");
    const replaced = splitMarkdownBlocksFrom(first, "Autre\n\nchose");
    expect(replaced.blocks).toEqual(["Autre", "chose"]);
    expect(splitMarkdownBlocksFrom(replaced, "Autre\n\nchose")).toBe(replaced);
  });

  test("keeps the settled blocks it reuses", () => {
    const first = splitMarkdownBlocksFrom(undefined, "Un\n\nDeux\n\nTr");
    const next = splitMarkdownBlocksFrom(first, "Un\n\nDeux\n\nTrois");
    expect(next.blocks).toEqual(["Un", "Deux", "Trois"]);
    expect(next.starts).toEqual([0, 4, 10]);
  });
});
