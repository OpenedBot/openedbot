import { describe, expect, test } from "bun:test";
import { closeOpenMath, stabilizeStreamingThreadMarkdown } from "../../../src/lib/stream/streaming-markdown";

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
