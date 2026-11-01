import { describe, expect, test } from "bun:test";
import {
  connectedMcpPluginNames,
  matchMcpPlugin,
  segmentMcpPlugins,
} from "../../../src/lib/runtime/mcp-plugins";

const NAMES = ["notion", "github"];

describe("matchMcpPlugin", () => {
  test("le mot exact, quelle que soit sa casse ou ses accents", () => {
    expect(matchMcpPlugin("notion", NAMES)).toEqual({ name: "notion", kind: "exact" });
    expect(matchMcpPlugin("Notion", NAMES)).toEqual({ name: "notion", kind: "exact" });
    expect(matchMcpPlugin("NOTIÖN", ["notion"])).toEqual({ name: "notion", kind: "exact" });
  });

  test("un préfixe d'au moins trois lettres, et le nom préfixe du mot", () => {
    expect(matchMcpPlugin("not", NAMES)).toEqual({ name: "notion", kind: "approximate" });
    expect(matchMcpPlugin("notions", NAMES)).toEqual({ name: "notion", kind: "approximate" });
  });

  test("une coquille sur un mot d'au moins quatre lettres", () => {
    expect(matchMcpPlugin("notino", NAMES)).toEqual({ name: "notion", kind: "approximate" });
    expect(matchMcpPlugin("gitub", NAMES)).toEqual({ name: "github", kind: "approximate" });
  });

  test("deux coquilles, non : la coloration deviendrait du bruit", () => {
    expect(matchMcpPlugin("natian", NAMES)).toBeNull();
  });

  test("un mot trop court ne colore rien", () => {
    expect(matchMcpPlugin("no", NAMES)).toBeNull();
    expect(matchMcpPlugin("n", NAMES)).toBeNull();
  });

  test("l'affixe `mcp` du nom d'hôte n'oblige pas à le taper", () => {
    expect(matchMcpPlugin("notion", ["mcp-notion"])).toEqual({
      name: "mcp-notion",
      kind: "exact",
    });
    expect(matchMcpPlugin("notion", ["notion_mcp"])).toEqual({
      name: "notion_mcp",
      kind: "exact",
    });
  });

  test("l'exact bat le préfixe, puis le nom le plus court", () => {
    expect(matchMcpPlugin("notion", ["notion-calendar", "notion"])).toEqual({
      name: "notion",
      kind: "exact",
    });
    expect(matchMcpPlugin("noti", ["notion-calendar", "notion"])).toEqual({
      name: "notion",
      kind: "approximate",
    });
  });
});

describe("segmentMcpPlugins", () => {
  test("rend le texte d'origine, caractère pour caractère", () => {
    const text = "Regarde dans Notion, page « sprint » (notino ?)";
    const segments = segmentMcpPlugins(text, NAMES);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  test("isole le mot reconnu et son degré", () => {
    expect(segmentMcpPlugins("va sur notion stp", NAMES)).toEqual([
      { kind: "text", text: "va sur " },
      { kind: "plugin", text: "notion", name: "notion", match: "exact" },
      { kind: "text", text: " stp" },
    ]);
  });

  test("une mention de bot reste du texte", () => {
    expect(segmentMcpPlugins("@notion regarde", NAMES)).toEqual([
      { kind: "text", text: "@notion regarde" },
    ]);
  });

  test("sans plugin connecté, un seul segment de texte", () => {
    expect(segmentMcpPlugins("notion", [])).toEqual([{ kind: "text", text: "notion" }]);
    expect(segmentMcpPlugins("", NAMES)).toEqual([]);
  });

  test("le trait d'union fait partie du mot", () => {
    expect(segmentMcpPlugins("ouvre notion-calendar", ["notion-calendar"])).toEqual([
      { kind: "text", text: "ouvre " },
      {
        kind: "plugin",
        text: "notion-calendar",
        name: "notion-calendar",
        match: "exact",
      },
    ]);
  });
});

describe("connectedMcpPluginNames", () => {
  const server = (overrides: Partial<Parameters<typeof connectedMcpPluginNames>[0][number]>) => ({
    name: "notion",
    auth: "none" as const,
    platformEnabled: true,
    unreachable: false,
    oauthTokenPresent: null,
    ...overrides,
  });

  test("garde un serveur porté par la plateforme et joignable", () => {
    expect(connectedMcpPluginNames([server({})])).toEqual(["notion"]);
  });

  test("écarte un serveur non porté, injoignable, ou OAuth sans jeton", () => {
    expect(connectedMcpPluginNames([server({ platformEnabled: false })])).toEqual([]);
    expect(connectedMcpPluginNames([server({ unreachable: true })])).toEqual([]);
    expect(
      connectedMcpPluginNames([server({ auth: "oauth", oauthTokenPresent: false })]),
    ).toEqual([]);
  });

  test("un hôte qui ne dit rien du jeton n'est pas un refus", () => {
    expect(
      connectedMcpPluginNames([server({ auth: "oauth", oauthTokenPresent: null })]),
    ).toEqual(["notion"]);
  });
});
