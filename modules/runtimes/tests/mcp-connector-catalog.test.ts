import { describe, expect, test } from "bun:test";
import {
  MCP_CONNECTOR_CATALOG,
  MCP_CONNECTOR_CATALOG_VERSION,
  mcpCatalogRootMatch,
  mcpConnectorEntry,
  mcpPublicServerEndpoint,
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

  test("un homonyme à la racine ne sert que s'il pointe au même endpoint en OAuth", () => {
    const linear = mcpConnectorEntry("linear")!;
    expect(mcpCatalogRootMatch(linear, { endpoint: "https://mcp.linear.app/mcp/", auth: "oauth" })).toBe("same");
    expect(mcpCatalogRootMatch(linear, { endpoint: "https://mcp.linear.app/mcp", auth: "header" })).toBe("conflict");
    expect(mcpCatalogRootMatch(linear, { endpoint: "https://evil.example/mcp", auth: "oauth" })).toBe("conflict");
    expect(mcpCatalogRootMatch(linear, { endpoint: null, auth: "oauth" })).toBe("conflict");
  });

  test("la forme publique d'une adresse : l'URL du catalogue pour son entrée, l'origine seule pour tout le reste", () => {
    expect(mcpPublicServerEndpoint({ name: "linear", endpoint: "https://mcp.linear.app/mcp/", auth: "oauth" })).toBe("https://mcp.linear.app/mcp");
    expect(mcpPublicServerEndpoint({ name: "linear", endpoint: "https://u:p@linear.internal.example/mcp?k=v", auth: "oauth" })).toBe("https://linear.internal.example/...");
    expect(mcpPublicServerEndpoint({ name: "linear", endpoint: "https://mcp.linear.app/mcp", auth: "header" })).toBe("https://mcp.linear.app/...");
    expect(mcpPublicServerEndpoint({ name: "zapier", endpoint: "https://actions.zapier.com/mcp/sk-x/sse", auth: "none" })).toBe("https://actions.zapier.com/...");
    expect(mcpPublicServerEndpoint({ name: "local", endpoint: null, auth: "none" })).toBeNull();
  });
});
