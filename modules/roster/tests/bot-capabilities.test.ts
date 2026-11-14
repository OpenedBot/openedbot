import { describe, expect, test } from "bun:test";
import { HermesClientError, type HermesHostProfile, type HermesMcpInventory } from "@openedbot/hermes";
import { botCapabilities, profileMcpServers } from "../src/domain/bot-capabilities";

describe("panneau des capacités d'un bot", () => {
  const base = {
    botId: "bot-1",
    hermesProfile: "pixel",
    runtimeName: "lab-runtime-01",
    usage: [{ tool: "web_search", calls: 12, failures: 1, lastUsedAt: "2026-08-25T10:00:00.000Z" }],
    usageWindowDays: 30,
  };

  test("un runtime muet n'emporte pas l'usage, qui sort de notre base", () => {
    const payload = botCapabilities({
      ...base,
      inventory: null,
      failure: new HermesClientError("Hermes est injoignable.", 502, "HERMES_UNREACHABLE"),
    });
    expect(payload.usage).toHaveLength(1);
    expect(payload.inventoryError).toEqual({ code: "HERMES_UNREACHABLE", message: "Hermes est injoignable." });
    expect(payload.toolsets).toBeNull();
  });

  test("une panne inattendue reste nommée plutôt que remontée telle quelle", () => {
    const payload = botCapabilities({ ...base, inventory: null, failure: new TypeError("fetch failed") });
    expect(payload.inventoryError?.code).toBe("HERMES_UNREACHABLE");
    expect(payload.inventoryError?.message).not.toContain("fetch failed");
  });

  test("sans runtime actif, l'écran lit « je n'ai pas pu regarder », pas « aucun outil »", () => {
    const payload = botCapabilities({ ...base, runtimeName: null, inventory: null, failure: null });
    expect(payload.inventoryError?.code).toBe("RUNTIME_REQUIRED");
  });

  // Les deux `null` de `toolsets` ne se soignent pas pareil : ici l'endpoint
  // manque au build, il n'y a rien à réparer et rien à signaler comme panne.
  test("un endpoint absent du build n'est pas une erreur", () => {
    const payload = botCapabilities({
      ...base,
      inventory: { toolsets: [], skills: null },
      failure: null,
    });
    expect(payload.inventoryError).toBeNull();
    expect(payload.skills).toBeNull();
    expect(payload.toolsets).toEqual([]);
  });

  test("la fenêtre de l'usage est publiée avec lui : la liste est datée, pas exhaustive", () => {
    const payload = botCapabilities({ ...base, usageWindowDays: 7, inventory: { toolsets: [], skills: [] }, failure: null });
    expect(payload.usageWindowDays).toBe(7);
  });

  describe("disponibilité réelle des toolsets", () => {
    const toolset = (name: string) => ({ name, label: name, description: null, enabled: true, configured: true, tools: ["t"] });
    const inventory = { toolsets: [toolset("browser"), toolset("web")], skills: [] };

    test("l'hôte qui mesure pose available et la raison sur le toolset concerné", () => {
      const payload = botCapabilities({
        ...base,
        inventory,
        failure: null,
        hostToolsets: {
          platform: "api_server",
          settable: ["browser", "web"],
          availability: [{ name: "browser", available: false, reason: "check_failed" }, { name: "web", available: true, reason: null }],
        },
      });
      expect(payload.toolsets?.map((row) => [row.name, row.available, row.unavailableReason])).toEqual([
        ["browser", false, "check_failed"],
        ["web", true, null],
      ]);
    });

    test("un hôte ancien (champ absent) laisse tout à null, jamais disponible", () => {
      const payload = botCapabilities({
        ...base,
        inventory,
        failure: null,
        hostToolsets: { platform: "api_server", settable: ["browser"], availability: null },
      });
      expect(payload.toolsets?.every((row) => row.available === null && row.unavailableReason === null)).toBe(true);
      expect(botCapabilities({ ...base, inventory, failure: null }).toolsets?.[0]?.available).toBeNull();
    });
  });
});

describe("serveurs MCP du profil d'un bot", () => {
  const profile = (mcpServers: HermesHostProfile["mcpServers"]) => ({ mcpServers }) as HermesHostProfile;
  // The root holds a token for linear: it is never the profile's.
  const root = {
    platform: "api_server",
    catalog: [],
    servers: [{ name: "linear", transport: "http", discoveredTools: ["issues"], unreachable: false, auth: "oauth", oauthTokenPresent: true }],
  } as unknown as HermesMcpInventory;

  test("les faits viennent de l'entrée du profil, jamais de la racine", () => {
    const [linear] = profileMcpServers(profile([
      { name: "linear", enabled: true, endpoint: "https://mcp.linear.app/mcp", auth: "oauth", oauthTokenPresent: false },
    ]), root);
    expect(linear).toEqual({
      name: "linear", enabled: true, transport: "http", tools: ["issues"], unreachable: false,
      endpoint: "https://mcp.linear.app/mcp", auth: "oauth", oauthTokenPresent: false,
    });
  });

  test("une adresse hors catalogue n'est rendue que sous sa forme publique : un secret de chemin, de requête ou d'identité ne sort pas", () => {
    const servers = profileMcpServers(profile([
      { name: "zapier", enabled: true, endpoint: "https://actions.zapier.com/mcp/sk-path-secret/sse", auth: "header", oauthTokenPresent: null },
      { name: "linear", enabled: true, endpoint: "https://user:pass@linear.internal.example/mcp?token=q", auth: "oauth", oauthTokenPresent: true },
    ]), null);
    expect(servers.map((server) => server.endpoint)).toEqual(["https://actions.zapier.com/...", "https://linear.internal.example/..."]);
    expect(JSON.stringify(servers)).not.toMatch(/sk-path-secret|user:pass|token=q/);
  });

  test("un hôte ancien ne dit rien : aucun fait inventé", () => {
    const [linear] = profileMcpServers(profile([{ name: "linear", enabled: true }]), root);
    expect(linear).toEqual({ name: "linear", enabled: true, transport: "http", tools: ["issues"], unreachable: false });
    expect(linear).not.toHaveProperty("oauthTokenPresent");
  });
});
