import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import katex from "katex";
import { ThreadMarkdown } from "../../src/components/thread-markdown";
import { MATH_MERMAID_FIXTURE } from "../../src/lib/dev/math-mermaid-fixture";
import { I18nProvider } from "../../src/lib/i18n";

afterEach(cleanup);

// The `/dev/math` fixture through the thread markdown: KaTeX must still
// produce its outer classes (globals.css and stream-tail-rehype.ts select on
// them) and both mermaid fences must reach the diagram renderer.
describe("math + mermaid fixture", () => {
  test("KaTeX stays on 0.18.x", () => {
    expect(katex.version).toMatch(/^0\.18\./);
  });

  test("inline, display and matrix math render with the outer KaTeX classes", () => {
    const { container } = render(
      <I18nProvider>
        <ThreadMarkdown>{MATH_MERMAID_FIXTURE}</ThreadMarkdown>
      </I18nProvider>,
    );
    const display = container.querySelectorAll(".katex-display");
    expect(display.length).toBe(3);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(5);
    expect(container.querySelector(".katex-mathml")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
    // The matrix is laid out (its cells are in the HTML rendering), not echoed.
    const html = [...container.querySelectorAll(".katex-html")].map((node) => node.textContent ?? "").join(" ");
    expect(html).not.toContain("pmatrix");
    expect(html).toContain("147");
  });

  test("both mermaid fences reach the diagram renderer (source shown until it draws)", () => {
    const { container } = render(
      <I18nProvider>
        <ThreadMarkdown>{MATH_MERMAID_FIXTURE}</ThreadMarkdown>
      </I18nProvider>,
    );
    const drawn = container.querySelectorAll("[aria-label='Mermaid diagram']").length;
    const pending = [...container.querySelectorAll("pre.not-prose")]
      .map((node) => node.textContent ?? "")
      .filter((text) => text.startsWith("flowchart LR") || text.startsWith("sequenceDiagram")).length;
    expect(drawn + pending).toBe(2);
  });
});
