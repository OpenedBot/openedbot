import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider, useT, type Locale } from "../../src/lib/i18n";
import { PROGRESS_QUERY_MAX_CHARS, toolProgressLabel } from "../../src/lib/tool-progress-label";

afterEach(cleanup);

/** Renders the label through the real provider, so the FR and EN dictionaries are the shipped ones. */
function label(locale: Locale, tool: string, preview?: string): string {
  window.localStorage.setItem("ohb:locale", locale);
  let out = "";
  function Probe() {
    out = toolProgressLabel(useT().t, tool, preview);
    return null;
  }
  render(<I18nProvider><Probe /></I18nProvider>);
  cleanup();
  return out;
}

const fr = (tool: string, preview?: string) => label("fr", tool, preview);
const en = (tool: string, preview?: string) => label("en", tool, preview);

describe("toolProgressLabel", () => {
  test("names the query of a web search", () => {
    expect(fr("web_search", "cours du bitcoin en euros")).toBe("Recherche : cours du bitcoin en euros");
    expect(en("web_search", '"bitcoin price"')).toBe("Searching: bitcoin price");
  });

  test("cuts a long query", () => {
    const label = fr("web_search", "mot ".repeat(60));
    expect(label.startsWith("Recherche : ")).toBe(true);
    expect(label.length).toBeLessThanOrEqual("Recherche : ".length + PROGRESS_QUERY_MAX_CHARS);
    expect(label.endsWith("…")).toBe(true);
  });

  test("shows the host of a page, never its path or query string", () => {
    expect(fr("web_extract", "https://www.lemonde.fr/a/b?token=secretvalue")).toBe("Lecture : lemonde.fr");
    expect(fr("web_extract", "meet.example.com/rec/42")).toBe("Lecture : meet.example.com");
    expect(fr("web_extract", "no site here")).toBe("Lit le web…");
  });

  test("shows a file name without its directory", () => {
    expect(fr("write_file", "/home/bot/note.txt")).toBe("Écrit note.txt");
    expect(en("read_file", "src/app.ts")).toBe("Reading app.ts");
    expect(fr("patch", "a/b/c.ts")).toBe("Modifie c.ts");
    expect(fr("write_file", "$(rm -rf *)")).toBe("Modifie un fichier…");
  });

  test("never shows a command, and falls back to the family verb", () => {
    expect(fr("terminal", "curl -H 'Authorization: Bearer abcdefgh12345' https://x")).toBe("Exécute des commandes…");
    expect(fr("web_search")).toBe("Cherche sur le web…");
    expect(fr("mcp__notion__create_page", "title")).toBe("Travaille dans notion…");
    expect(fr("skill_manage", "x")).toBe("Utilise skill_manage…");
  });

  test("a secret in a query is redacted", () => {
    expect(fr("web_search", "token=abcdefghijkl1234")).not.toContain("abcdefghijkl1234");
  });
});
