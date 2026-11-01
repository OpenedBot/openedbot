import { describe, expect, test } from "bun:test";
import {
  MCP_CONNECTOR_CATALOG,
  MCP_CONNECTOR_CATALOG_VERSION,
  mcpCatalogOffer,
  mcpCatalogRootMatch,
  mcpConnectorEntry,
} from "../src/domain/mcp-connector-catalog";

// The host's MCP server-name grammar (edge-setup operator, API MCP_NAME_PATTERN),
// narrowed to lowercase: the id is the server's name on the host.
const HOST_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

describe("le catalogue des connecteurs MCP", () => {
  test("chaque entrée est un nom de serveur valide, unique, en https, sans endpoint SSE legacy", () => {
    const ids = MCP_CONNECTOR_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of MCP_CONNECTOR_CATALOG) {
      expect(entry.id).toMatch(HOST_NAME);
      const url = new URL(entry.url);
      expect(url.protocol).toBe("https:");
      expect(entry.url.length).toBeLessThanOrEqual(2_048);
      expect(url.pathname.endsWith("/sse")).toBe(false);
      expect(new URL(entry.source).protocol).toBe("https:");
      expect(entry.auth).toBe("dcr");
      expect(entry.verifiedAt).toBe(MCP_CONNECTOR_CATALOG_VERSION);
    }
  });

  test("n'offre pas les éditeurs qui exigent une application inscrite ou filtrent les clients", () => {
    for (const excluded of ["github", "slack", "google", "gmail", "asana", "hubspot", "figma", "vercel", "dropbox", "clickup", "intercom", "atlassian"]) {
      expect(mcpConnectorEntry(excluded)).toBeNull();
    }
    expect(mcpConnectorEntry("linear")?.url).toBe("https://mcp.linear.app/mcp");
  });

  test("l'offre d'un bot retire ce que son profil porte déjà, activé ou non, et rien quand le profil est illisible", () => {
    const offer = mcpCatalogOffer([{ name: "linear", enabled: true }, { name: "notion", enabled: false }, { name: "custom", enabled: true }]);
    expect(offer.some((entry) => entry.id === "linear" || entry.id === "notion")).toBe(false);
    expect(offer.length).toBe(MCP_CONNECTOR_CATALOG.length - 2);
    expect(mcpCatalogOffer([])).toHaveLength(MCP_CONNECTOR_CATALOG.length);
    expect(mcpCatalogOffer(null)).toEqual([]);
  });

  test("un homonyme à la racine ne sert que s'il pointe au même endpoint en OAuth", () => {
    const linear = mcpConnectorEntry("linear")!;
    expect(mcpCatalogRootMatch(linear, { endpoint: "https://mcp.linear.app/mcp/", auth: "oauth" })).toBe("same");
    expect(mcpCatalogRootMatch(linear, { endpoint: "https://mcp.linear.app/mcp", auth: "header" })).toBe("conflict");
    expect(mcpCatalogRootMatch(linear, { endpoint: "https://evil.example/mcp", auth: "oauth" })).toBe("conflict");
    expect(mcpCatalogRootMatch(linear, { endpoint: null, auth: "oauth" })).toBe("conflict");
  });
});
