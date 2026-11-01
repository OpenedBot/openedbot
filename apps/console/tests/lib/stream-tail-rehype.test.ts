import { describe, expect, test } from "bun:test";
import { rehypeStreamTail, STREAM_TAIL_CHARS } from "../../src/lib/stream-tail-rehype";

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

const text = (value: string): Node => ({ type: "text", value });
const element = (tagName: string, children: Node[]): Node => ({ type: "element", tagName, properties: {}, children });

function textOf(node: Node): string {
  return node.type === "text" ? node.value ?? "" : (node.children ?? []).map(textOf).join("");
}

function spans(node: Node, className: string): Node[] {
  const own = node.type === "element" && Array.isArray(node.properties?.className) && (node.properties.className as string[]).includes(className) ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap((child) => spans(child, className))];
}

function run(plugin: () => (tree: never) => void, tree: Node): Node {
  plugin()(tree as never);
  return tree;
}

describe("rehypeStreamTail", () => {
  test("puts the last characters of the last text in the blurred tail, then the caret", () => {
    const tree = run(rehypeStreamTail, {
      type: "root",
      children: [element("p", [text("Premier")]), element("p", [text("La réponse arrive")])],
    });
    const [tail] = spans(tree, "ohb-stream-tail");
    expect(textOf(tail!)).toBe("arrive".slice(-STREAM_TAIL_CHARS));
    expect(spans(tree, "ohb-stream-caret")).toHaveLength(1);
    expect(textOf(tree)).toBe("PremierLa réponse arrive");
  });

  test("while the stream writes code, no blurred tail: the caret follows the block", () => {
    const tree = run(rehypeStreamTail, {
      type: "root",
      children: [element("p", [text("Voici le code")]), element("pre", [element("code", [text("x = 1")])])],
    });
    expect(spans(tree, "ohb-stream-tail")).toEqual([]);
    expect(tree.children?.at(-1)).toMatchObject({ tagName: "span", properties: { className: ["ohb-stream-caret"] } });
    expect(textOf(tree)).toBe("Voici le codex = 1");
  });

  test("a fresh empty bullet keeps the caret on itself, never on the paragraph before", () => {
    const tree = run(rehypeStreamTail, {
      type: "root",
      children: [element("p", [text("Principes :")]), text("\n"), element("ul", [element("li", [])])],
    });
    expect(spans(tree, "ohb-stream-tail")).toEqual([]);
    expect(tree.children?.at(-1)).toMatchObject({ properties: { className: ["ohb-stream-caret"] } });
  });

  test("an empty tree still gets its caret", () => {
    const tree = run(rehypeStreamTail, { type: "root", children: [] });
    expect(spans(tree, "ohb-stream-caret")).toHaveLength(1);
  });
});
