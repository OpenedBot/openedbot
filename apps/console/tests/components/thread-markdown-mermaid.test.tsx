import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { MermaidSvg, ThreadMarkdown } from "../../src/components/thread-markdown";
import { drawnMermaid, forgetMermaidDrawings, keepMermaid } from "../../src/lib/stream/mermaid-drawings";

// The drawing itself needs a real layout engine; this is the SVG Mermaid returns.
const SVG = '<svg id="drawn" viewBox="0 0 400 300" style="max-width: 400px;"><text>UserController</text></svg>';

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  forgetMermaidDrawings();
});

describe("Mermaid diagram", () => {
  test("a click opens the drawing large", async () => {
    const view = render(<I18nProvider><MermaidSvg svg={SVG} /></I18nProvider>);
    const open = view.getByRole("button", { name: "Agrandir le diagramme" });
    expect(open.querySelector("svg#drawn")).not.toBeNull();
    expect(view.queryByRole("dialog")).toBeNull();

    fireEvent.click(open);
    const dialog = await view.findByRole("dialog");
    expect(dialog.textContent).toContain("Diagramme");
    expect(dialog.querySelector("svg#drawn")?.textContent).toBe("UserController");
  });

  test("Enter on the focused diagram opens it too", async () => {
    const view = render(<I18nProvider><MermaidSvg svg={SVG} /></I18nProvider>);
    fireEvent.keyDown(view.getByRole("button", { name: "Agrandir le diagramme" }), { key: "Enter" });
    expect(await view.findByRole("dialog")).toBeDefined();
  });
});

describe("Mermaid drawings kept for the session", () => {
  const SOURCE = "flowchart LR\n    A --> B";
  const FENCE = "```mermaid\n" + SOURCE + "\n```";

  test("a row mounted back by scrolling shows its drawing at once, never its source", () => {
    keepMermaid(SOURCE, false, SVG);
    const view = render(<I18nProvider><ThreadMarkdown>{FENCE}</ThreadMarkdown></I18nProvider>);
    // First render, before any effect could draw: the diagram, and no source block.
    expect(view.container.querySelector("svg#drawn")).not.toBeNull();
    expect(view.container.querySelector("pre")).toBeNull();
  });

  test("a diagram not drawn yet shows its source, as before", () => {
    const view = render(<I18nProvider><ThreadMarkdown>{FENCE}</ThreadMarkdown></I18nProvider>);
    expect(view.container.querySelector("pre")?.textContent).toBe(SOURCE);
    expect(view.container.querySelector("svg#drawn")).toBeNull();
  });

  test("a drawing belongs to one source and one theme", () => {
    keepMermaid(SOURCE, false, SVG);
    expect(drawnMermaid(SOURCE, false)).toBe(SVG);
    expect(drawnMermaid(SOURCE, true)).toBeNull();
    expect(drawnMermaid(SOURCE + "\n    B --> C", false)).toBeNull();
  });

  test("beyond the limit the drawing kept longest ago leaves, a re-kept one stays", () => {
    keepMermaid("first", false, "<svg>first</svg>");
    keepMermaid("second", false, "<svg>second</svg>");
    for (let index = 0; index < 62; index += 1) keepMermaid(`filler ${index}`, false, "<svg/>");
    keepMermaid("first", false, "<svg>first</svg>");
    keepMermaid("one more", false, "<svg/>");
    expect(drawnMermaid("first", false)).toBe("<svg>first</svg>");
    expect(drawnMermaid("second", false)).toBeNull();
    expect(drawnMermaid("one more", false)).toBe("<svg/>");
  });
});
