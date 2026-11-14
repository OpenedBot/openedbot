import { describe, expect, test } from "bun:test";
import {
  connectedMcpPluginNames,
  profileMcpPluginNames,
  matchMcpPlugin,
  matchMcpPluginsByPrefix,
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

describe("profileMcpPluginNames : les serveurs du profil du bot", () => {
  const oauth = (name: string, token: boolean | null) =>
    ({ name, enabled: true, auth: "oauth" as const, oauthTokenPresent: token });

  test("un connecteur autorisé pour le bot se colore ; sans jeton, désactivé, il ne se colore pas", () => {
    expect(profileMcpPluginNames({ mcpFacts: true, mcpServers: [
      oauth("linear", true),
      oauth("notion", false),
      { ...oauth("cloudflare", true), enabled: false },
      { name: "docs", enabled: true, auth: "header", oauthTokenPresent: null },
      oauth("unchecked", null),
      // An entry the host does not describe (not a mapping): unknown, not a refusal.
      { name: "legacy", enabled: true },
    ] })).toEqual(["linear", "docs", "unchecked", "legacy"]);
  });

  test("un profil décrit sans serveur : aucun connecteur, pas la racine", () => {
    expect(profileMcpPluginNames({ mcpFacts: true, mcpServers: [] })).toEqual([]);
  });

  test("le profil ne dit rien (non lu, absent, hôte ancien) : la lecture de la racine garde la main", () => {
    expect(profileMcpPluginNames(undefined)).toBeNull();
    expect(profileMcpPluginNames(null)).toBeNull();
    expect(profileMcpPluginNames({ mcpServers: [] })).toBeNull();
    expect(profileMcpPluginNames({ mcpServers: [{ name: "linear", enabled: true }] })).toBeNull();
  });
});

describe("matchMcpPluginsByPrefix", () => {
  test("an empty query lists every connector, in input order", () => {
    expect(matchMcpPluginsByPrefix("", ["mcp-notion", "github"])).toEqual(["mcp-notion", "github"]);
  });

  test("the prefix is read on the alias stripped of its mcp affix", () => {
    expect(matchMcpPluginsByPrefix("no", ["github", "mcp-notion"])).toEqual(["mcp-notion"]);
    expect(matchMcpPluginsByPrefix("NÖ", ["notion-mcp"])).toEqual(["notion-mcp"]);
  });

  test("exact names come before prefixes, then input order", () => {
    expect(matchMcpPluginsByPrefix("notion", ["notion-calendar", "notion"])).toEqual([
      "notion",
      "notion-calendar",
    ]);
  });

  test("no typo tolerance: a miss is a miss", () => {
    expect(matchMcpPluginsByPrefix("notino", ["notion"])).toEqual([]);
    expect(matchMcpPluginsByPrefix("zz", ["notion"])).toEqual([]);
  });
});
