import { describe, expect, test } from "bun:test";
import type { BotDto, RuntimeHostProfileDto, RuntimeIntegrationMcpServerDto, RuntimeProfileMcpServerDto } from "@openedbot/contracts-api";
import { MCP_CONNECTOR_CATALOG } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import {
  botCatalogOffer,
  botLinksToAuthorize,
  catalogConnections,
  catalogNameTaken,
  catalogEntryOfProfileServer,
  connectedBotLinks,
  isListedConnection,
  profileServerState,
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
/** An entry outside « À la une », to exercise the sections by category. */
const offFeatured = { ...MCP_CONNECTOR_CATALOG[0]!, id: "acme", name: "Acme", category: "dev" as const };
const withCategory = [...MCP_CONNECTOR_CATALOG, offFeatured];

describe("les sections du catalogue", () => {
  test("à la une puis par catégorie, chaque entrée une seule fois", () => {
    // The whole openedbot catalog is featured: no category section.
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
    // Features not read yet are not a refusal.
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
    // The token alone at the root counts; a profile with no bot does not disconnect from here.
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

describe("« connecté » est prouvé : un état par bot × connecteur", () => {
  const LINEAR = "https://mcp.linear.app/mcp";
  const facts = (token: boolean | null, endpoint = LINEAR): RuntimeProfileMcpServerDto =>
    ({ name: "linear", enabled: true, endpoint, auth: "oauth", oauthTokenPresent: token });
  const old: RuntimeProfileMcpServerDto = { name: "linear", enabled: true };
  const profile = (name: string, botId: string, servers: RuntimeProfileMcpServerDto[]): RuntimeHostProfileDto => ({
    name, displayName: name, title: null, description: null, model: { default: null, provider: null },
    hasAvatar: false, routineCount: 0, routines: [], pinned: false, mcpServers: servers, alreadyImported: true, importedBotId: botId,
  });
  const bots = [{ id: "b-a", name: "A" }, { id: "b-b", name: "B" }, { id: "b-c", name: "C" }] as BotDto[];
  const linearOf = (profiles: RuntimeHostProfileDto[]) =>
    catalogConnections({ catalog: MCP_CONNECTOR_CATALOG, profiles, bots, rootServers: null }).find((connection) => connection.entry.id === "linear");

  test("l'état d'un serveur de profil : prouvé, à autoriser, ou inconnu (hôte ancien, non vérifié, autre mode)", () => {
    expect(profileServerState(facts(true))).toBe("connected");
    expect(profileServerState(facts(false))).toBe("authorize");
    expect(profileServerState(facts(null))).toBe("unknown");
    expect(profileServerState(old)).toBe("unknown");
    expect(profileServerState({ auth: "header", oauthTokenPresent: null })).toBe("unknown");
  });

  test("l'identité d'un serveur de profil : nom ET adresse en OAuth quand l'hôte les dit, le nom seul sinon", () => {
    expect(catalogEntryOfProfileServer(facts(true))?.id).toBe("linear");
    expect(catalogEntryOfProfileServer(facts(true, "https://linear.internal.example/mcp"))).toBeNull();
    expect(catalogEntryOfProfileServer({ ...facts(true), auth: "header" })).toBeNull();
    expect(catalogEntryOfProfileServer(old)?.id).toBe("linear");
  });

  test("un bot dont le profil a seulement hérité ou recopié l'entrée n'est pas connecté", () => {
    const linear = linearOf([profile("a", "b-a", [facts(false)])])!;
    expect(linear.bots.map((link) => [link.name, link.state])).toEqual([["A", "authorize"]]);
    expect(connectedBotLinks(linear)).toEqual([]);
    expect(botLinksToAuthorize(linear).map((link) => link.botId)).toEqual(["b-a"]);
    // Neither in « Connectés » nor out of the catalog.
    expect(isListedConnection(linear)).toBe(false);
  });

  test("prouvé, inconnu et à autoriser ensemble : les deux premiers comptent, le troisième est à autoriser", () => {
    const linear = linearOf([profile("a", "b-a", [facts(true)]), profile("b", "b-b", [old]), profile("c", "b-c", [facts(false)])])!;
    expect(connectedBotLinks(linear).map((link) => [link.name, link.state])).toEqual([["A", "connected"], ["B", "unknown"]]);
    expect(botLinksToAuthorize(linear).map((link) => link.name)).toEqual(["C"]);
    expect(isListedConnection(linear)).toBe(true);
  });

  test("hôte ancien : exactement la lecture d'avant (porter l'entrée = connecté)", () => {
    const linear = linearOf([profile("a", "b-a", [old])])!;
    expect(linear.bots.map((link) => link.state)).toEqual(["unknown"]);
    expect(isListedConnection(linear)).toBe(true);
  });

  test("un serveur importé à la main sous le nom « linear » vers une autre adresse n'est pas une connexion Linear", () => {
    expect(linearOf([profile("a", "b-a", [facts(true, "https://linear.internal.example/mcp")])])).toBeUndefined();
  });

  test("un nom pris par un autre serveur du profil : refusé au choix et grisé au catalogue de la fiche ; hôte ancien : rien de pris", () => {
    const entry = MCP_CONNECTOR_CATALOG.find((candidate) => candidate.id === "linear")!;
    const other = facts(true, "https://linear.internal.example/...");
    const bare: RuntimeProfileMcpServerDto = { name: "linear", enabled: false, endpoint: null, auth: "none", oauthTokenPresent: null };
    expect(catalogNameTaken([other], entry)).toBe(true);
    expect(catalogNameTaken([bare], entry)).toBe(true);
    expect(catalogNameTaken([facts(false)], entry)).toBe(false);
    expect(catalogNameTaken([old], entry)).toBe(false);
    expect(catalogNameTaken(undefined, entry)).toBe(false);
    const offer = (servers: RuntimeProfileMcpServerDto[] | null) => botCatalogOffer(servers, MCP_CONNECTOR_CATALOG).map(({ entry: offered, taken }) => [offered.id, taken]);
    expect(offer([other])).toEqual([["notion", false], ["linear", true], ["cloudflare", false]]);
    expect(offer([facts(false)])).toEqual([["notion", false], ["cloudflare", false]]);
    expect(offer([old])).toEqual([["notion", false], ["cloudflare", false]]);
    expect(offer(null)).toEqual([]);
    const picker = botPickerOptions([{ id: "b-a", name: "A", hermesProfile: "a", archivedAt: null }] as BotDto[], () => true);
    expect(picker.map((option) => option.disabled)).toEqual(["taken"]);
  });

  test("le jeton de la racine seul garde l'entrée listée, même si les bots sont à autoriser", () => {
    const root = { name: "linear", transport: "http", endpoint: LINEAR, command: null, auth: "oauth", configEnabled: true, platformEnabled: true,
      toolsIncluded: null, toolsExcluded: null, envKeys: [], discoveredTools: null, unreachable: false, oauthTokenPresent: true } as RuntimeIntegrationMcpServerDto;
    const linear = catalogConnections({ catalog: MCP_CONNECTOR_CATALOG, profiles: [profile("a", "b-a", [facts(false)])], bots, rootServers: [root] })
      .find((connection) => connection.entry.id === "linear")!;
    expect(isListedConnection(linear)).toBe(true);
    expect(connectedBotLinks(linear)).toEqual([]);
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
