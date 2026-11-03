import { describe, expect, test } from "bun:test";
import { labWords, rehypeLabWords } from "../../../src/lib/dev/thread-lab-rehype";

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

describe("labWords", () => {
  test("gives the text back byte for byte", () => {
    for (const sample of ["", "un", "deux mots ", "  espaces  au début", "ligne\nsuivante"]) {
      expect(labWords(sample).join("")).toBe(sample);
    }
  });
});

describe("rehypeLabWords", () => {
  test("wraps every word in a span and keeps the text", () => {
    const tree = run(rehypeLabWords, { type: "root", children: [element("p", [text("Bonjour le monde")])] });
    expect(spans(tree, "lab-word").map(textOf)).toEqual(["Bonjour ", "le ", "monde"]);
    expect(textOf(tree)).toBe("Bonjour le monde");
  });

  test("never splits code", () => {
    const tree = run(rehypeLabWords, { type: "root", children: [element("pre", [element("code", [text("const a = 1")])])] });
    expect(spans(tree, "lab-word")).toEqual([]);
  });
});
