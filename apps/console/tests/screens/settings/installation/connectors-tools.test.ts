import { describe, expect, test } from "bun:test";
import { splitToolsetLabel } from "../../../../src/screens/settings/installation/connectors/connectors-tools";

describe("splitToolsetLabel", () => {
  test("l'emoji de tête de Hermes devient la tuile, le nom se lit sans lui", () => {
    expect(splitToolsetLabel("👁️ Vision / Image Analysis")).toEqual({ glyph: "👁️", name: "Vision / Image Analysis" });
    expect(splitToolsetLabel("⚡ Code Execution")).toEqual({ glyph: "⚡", name: "Code Execution" });
    expect(splitToolsetLabel("👨‍💻 Pair")).toEqual({ glyph: "👨‍💻", name: "Pair" });
  });

  test("sans emoji, ou réduit à un emoji, le libellé reste entier", () => {
    expect(splitToolsetLabel("Terminal")).toEqual({ glyph: null, name: "Terminal" });
    expect(splitToolsetLabel("🔧")).toEqual({ glyph: null, name: "🔧" });
    expect(splitToolsetLabel("A2A ⚡")).toEqual({ glyph: null, name: "A2A ⚡" });
  });
});
