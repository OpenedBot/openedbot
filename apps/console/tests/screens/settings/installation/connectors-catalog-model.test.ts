import { describe, expect, test } from "bun:test";
import type { BotDto, RuntimeHostProfileDto, RuntimeIntegrationMcpServerDto } from "@openedbot/contracts-api";
import { MCP_CONNECTOR_CATALOG } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import {
  catalogConnections,
  mcpDisconnectBlocker,
  FEATURED_CONNECTOR_IDS,
  botPickerOptions,
  catalogEntryOfServer,
  catalogSections,
  connectorDescriptionKey,
  mcpConnectBlocker,
} from "../../../../src/screens/settings/installation/connectors/connectors-catalog-model";
import { MCP_CONNECTOR_MARKS } from "../../../../src/components/mcp-connector-marks";
import { connectorInitial } from "../../../../src/components/mcp-connector-row";

const describeEntry = (entry: { id: string }) => `desc-${entry.id}`;
/** Une entrée hors « À la une », pour éprouver les sections par catégorie. */
const offFeatured = { ...MCP_CONNECTOR_CATALOG[0]!, id: "acme", name: "Acme", category: "dev" as const };
const withCategory = [...MCP_CONNECTOR_CATALOG, offFeatured];

describe("les sections du catalogue", () => {
  test("à la une puis par catégorie, chaque entrée une seule fois", () => {
    // Tout le catalogue d'openedbot est à la une : aucune section de catégorie.
    expect(catalogSections(MCP_CONNECTOR_CATALOG, describeEntry, "").map((section) => section.key)).toEqual(["featured"]);
    const sections = catalogSections(withCategory, describeEntry, "");
    expect(sections.map((section) => section.key)).toEqual(["featured", "dev"]);
    expect(sections[0]!.entries.map((entry) => entry.id)).toEqual([...FEATURED_CONNECTOR_IDS]);
    const ids = sections.flatMap((section) => section.entries.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(withCategory.length);
  });

  test("la recherche porte sur le nom et la description, et retire les sections vides", () => {
    expect(catalogSections(withCategory, describeEntry, "  CLOUD ").flatMap((s) => s.entries.map((e) => e.id))).toEqual(["cloudflare"]);
    expect(catalogSections(withCategory, describeEntry, "desc-acme").map((s) => s.key)).toEqual(["dev"]);
    expect(catalogSections(withCategory, describeEntry, "zzz")).toEqual([]);
  });

  test("chaque entrée du catalogue a sa phrase et sa marque", () => {
    expect(MCP_CONNECTOR_CATALOG.map((entry) => entry.id)).toEqual(["notion", "linear", "cloudflare"]);
    for (const entry of MCP_CONNECTOR_CATALOG) {
      expect(connectorDescriptionKey(entry.id)).not.toBeNull();
      expect(MCP_CONNECTOR_MARKS[entry.id]?.path.length ?? 0).toBeGreaterThan(10);
    }
  });
});

describe("la porte de « Ajouter »", () => {
  const base = { writable: true, featuresPending: false, features: ["mcp_oauth_profile"] };
  test("profil, rôle puis hôte, dans cet ordre", () => {
    expect(mcpConnectBlocker(base)).toBeNull();
    expect(mcpConnectBlocker({ ...base, hasProfile: false })).toBe("profile");
    expect(mcpConnectBlocker({ ...base, hasProfile: false, writable: false })).toBe("profile");
    expect(mcpConnectBlocker({ ...base, writable: false })).toBe("role");
    expect(mcpConnectBlocker({ ...base, features: ["mcp_oauth"] })).toBe("host");
    // Les features pas encore lues ne sont pas un refus.
    expect(mcpConnectBlocker({ ...base, features: [], featuresPending: true })).toBeNull();
  });

  test("les bots proposés : sans archivés ni corbeille, sans profil grisés et après", () => {
    const bot = (id: string, name: string, extra: Partial<BotDto> = {}) =>
      ({ id, name, hermesProfile: id, archivedAt: null, ...extra }) as BotDto;
    const options = botPickerOptions([
      bot("z", "Zed"),
      bot("n", "Nul", { hermesProfile: null }),
      bot("a", "Alpha"),
      bot("x", "Archivé", { archivedAt: "2026-10-01T00:00:00Z" }),
      bot("d", "Supprimé", { archivedAt: "2026-10-01T00:00:00Z", deletedAt: "2026-10-02T00:00:00Z" }),
    ]);
    expect(options.map((option) => [option.bot.name, option.disabled])).toEqual([
      ["Alpha", null],
      ["Zed", null],
      ["Nul", "profile"],
    ]);
  });
});

describe("un serveur de l'hôte vient-il du catalogue ?", () => {
  test("même nom, même endpoint (barre finale comprise), en OAuth", () => {
    expect(catalogEntryOfServer({ name: "notion", endpoint: "https://mcp.notion.com/mcp/", auth: "oauth" })?.id).toBe("notion");
    expect(catalogEntryOfServer({ name: "notion", endpoint: "https://mcp.notion.com/mcp", auth: "header" })).toBeNull();
    expect(catalogEntryOfServer({ name: "notion", endpoint: "https://evil.example/mcp", auth: "oauth" })).toBeNull();
    expect(catalogEntryOfServer({ name: "acme", endpoint: "https://mcp.acme.test/mcp", auth: "oauth" })).toBeNull();
  });
});

describe("« Connectés » : les connexions par bot", () => {
  const profile = (name: string, importedBotId: string | null, servers: string[]): RuntimeHostProfileDto => ({
    name, displayName: name.toUpperCase(), title: null, description: null, model: { default: null, provider: null },
    hasAvatar: false, routineCount: 0, routines: [], pinned: false,
    mcpServers: servers.map((server) => ({ name: server, enabled: server !== "notion" })),
    alreadyImported: importedBotId !== null, importedBotId,
  });
  const root = (name: string, url: string, token: boolean): RuntimeIntegrationMcpServerDto => ({
    name, transport: "http", endpoint: url, command: null, auth: "oauth", configEnabled: true, platformEnabled: true,
    toolsIncluded: null, toolsExcluded: null, envKeys: [], discoveredTools: null, unreachable: false, oauthTokenPresent: token,
  });
  const bots = [{ id: "b-dev", name: "Dev" }, { id: "b-rech", name: "Recherche" }] as BotDto[];

  test("une entrée par connecteur, ses bots par nom, et le jeton de la racine", () => {
    const connections = catalogConnections({
      catalog: MCP_CONNECTOR_CATALOG,
      profiles: [profile("rech", "b-rech", ["linear"]), profile("dev", "b-dev", ["linear", "notion"]), profile("orphan", null, ["cloudflare"])],
      bots,
      rootServers: [root("linear", "https://mcp.linear.app/mcp", false), root("cloudflare", "https://mcp.cloudflare.com/mcp", true)],
    });
    expect(connections.map((connection) => connection.entry.id)).toEqual(["notion", "linear", "cloudflare"]);
    const linear = connections.find((connection) => connection.entry.id === "linear")!;
    expect(linear.bots.map((link) => link.name)).toEqual(["Dev", "Recherche"]);
    expect(linear.rootToken).toBe(false);
    expect(connections.find((connection) => connection.entry.id === "notion")!.bots[0]!.enabled).toBe(false);
    // Le jeton seul à la racine compte ; un profil sans bot ne se déconnecte pas d'ici.
    expect(connections.find((connection) => connection.entry.id === "cloudflare")).toMatchObject({ bots: [], rootToken: true });
  });

  test("un serveur de la racine sans jeton, ou vers une autre adresse, n'est pas une connexion", () => {
    expect(catalogConnections({
      catalog: MCP_CONNECTOR_CATALOG,
      profiles: null,
      bots: null,
      rootServers: [root("linear", "https://mcp.linear.app/mcp", false), root("notion", "https://evil.example/mcp", true)],
    })).toEqual([]);
  });

  test("une entrée connectée ne revient ni à la une ni dans sa catégorie", () => {
    const ids = catalogSections(MCP_CONNECTOR_CATALOG, () => "", "", new Set(["linear", "cloudflare"]))
      .flatMap((section) => section.entries.map((entry) => entry.id));
    expect(ids).not.toContain("linear");
    expect(ids).not.toContain("cloudflare");
    expect(ids).toContain("notion");
  });

  test("« Déconnecter » : opérateur qui écrit, et hôte qui annonce mcp_profile_disconnect", () => {
    expect(mcpDisconnectBlocker({ writable: false, featuresPending: false, features: ["mcp_profile_disconnect"] })).toBe("role");
    expect(mcpDisconnectBlocker({ writable: true, featuresPending: false, features: ["mcp_oauth_profile"] })).toBe("host");
    expect(mcpDisconnectBlocker({ writable: true, featuresPending: true, features: [] })).toBeNull();
    expect(mcpDisconnectBlocker({ writable: true, featuresPending: false, features: ["mcp_profile_disconnect"] })).toBeNull();
  });
});

describe("l'initiale d'un logo sans marque", () => {
  test("jamais une moitié d'emoji : la première lettre, sinon le premier graphème", () => {
    expect(connectorInitial("👁️ Vision / Image Analysis")).toBe("V");
    expect(connectorInitial("  attio")).toBe("a");
    expect(connectorInitial("🧪")).toBe("🧪");
    expect(connectorInitial("")).toBe("?");
  });
});
