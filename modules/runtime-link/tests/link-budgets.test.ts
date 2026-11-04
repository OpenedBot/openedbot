import { describe, expect, test } from "bun:test";
import {
  MCP_INSTALL_TIMEOUT_MS,
  MCP_MUTATION_TIMEOUT_MS,
  PROFILE_MUTATION_TIMEOUT_MS,
  SKILLS_HUB_INSTALL_TIMEOUT_MS,
  TOOLSET_MUTATION_TIMEOUT_MS,
} from "@openedbot/hermes";
import { RELAY_FIRST_RESPONSE_LIMIT_S } from "@openedbot/contracts-connector";
import { firstResponseBudgetMs } from "../src/application/link-budgets";

/**
 * L'hôte ne répond à une mutation longue qu'une fois la commande finie : le
 * broker ne coupe jamais avant le budget du client Hermes pour la même route.
 */
const DEFAULT_MS = RELAY_FIRST_RESPONSE_LIMIT_S * 1_000;

describe("délai de première réponse par famille de routes", () => {
  test("les mutations longues reçoivent le budget du client, préfixe /p/<slug> compris", () => {
    const cases: Array<[string, string, number]> = [
      ["POST", "/hermes-setup/toolsets/web", TOOLSET_MUTATION_TIMEOUT_MS],
      ["POST", "/p/bot-a/hermes-setup/toolsets/web", TOOLSET_MUTATION_TIMEOUT_MS],
      ["POST", "/hermes-setup/profiles", PROFILE_MUTATION_TIMEOUT_MS],
      ["POST", "/hermes-setup/profiles/bot-a/toolsets", PROFILE_MUTATION_TIMEOUT_MS],
      ["DELETE", "/hermes-setup/profiles/bot-a", PROFILE_MUTATION_TIMEOUT_MS],
      ["POST", "/hermes-setup/profiles/bot-a/skills/hub/install", SKILLS_HUB_INSTALL_TIMEOUT_MS],
      ["POST", "/hermes-setup/mcp/servers", MCP_MUTATION_TIMEOUT_MS],
      ["DELETE", "/hermes-setup/mcp/servers/github", MCP_MUTATION_TIMEOUT_MS],
      ["POST", "/hermes-setup/mcp/catalog/github", MCP_INSTALL_TIMEOUT_MS],
    ];
    for (const [method, path, expected] of cases) {
      expect([method, path, firstResponseBudgetMs(method, path, DEFAULT_MS)]).toEqual([method, path, expected]);
    }
    expect(TOOLSET_MUTATION_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MS);
  });

  test("les lectures et les autres routes gardent le délai du lien, jamais moins", () => {
    expect(firstResponseBudgetMs("GET", "/hermes-setup/profiles", DEFAULT_MS)).toBe(DEFAULT_MS);
    expect(firstResponseBudgetMs("GET", "/hermes-setup/mcp/servers", DEFAULT_MS)).toBe(DEFAULT_MS);
    expect(firstResponseBudgetMs("POST", "/v1/runs", DEFAULT_MS)).toBe(DEFAULT_MS);
    expect(firstResponseBudgetMs("POST", "/hermes-setup/providers/openai/credentials", DEFAULT_MS)).toBe(DEFAULT_MS);
    // Un délai par défaut plus long que la famille l'emporte.
    expect(firstResponseBudgetMs("POST", "/hermes-setup/toolsets/web", 300_000)).toBe(300_000);
  });
});
