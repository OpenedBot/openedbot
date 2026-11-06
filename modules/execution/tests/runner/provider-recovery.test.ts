import { describe, expect, test } from "bun:test";
import {
  persistResolvedRunModel,
  profileCatalogMissingCurrent,
  profileModelWriteNeeded,
  servingProvider,
} from "../../src/application/runner/provider-recovery";

describe("persistResolvedRunModel", () => {
  test("écrit le modèle résolu au passage creating, lié en binding", async () => {
    const statements: string[] = [];
    const bindings: unknown[][] = [];
    const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push([...strings].join(" "));
      bindings.push(values);
      return Promise.resolve([{ id: "run-1" }]);
    }) as unknown as Bun.SQL;

    const wrote = await persistResolvedRunModel(
      db,
      { workerId: "worker-1" },
      { id: "run-1", organizationId: "org-1", leaseGeneration: 4 },
      "gpt-5.6-luna",
    );

    expect(wrote).toBe(true);
    expect(statements[0]).toContain("model =");
    expect(statements[0]).toContain("external_state = 'creating'");
    expect(bindings[0]).toContain("gpt-5.6-luna");
    expect(bindings[0]).toContain("run-1");
    expect(bindings[0]).toContain("org-1");
    expect(bindings[0]).toContain("worker-1");
    expect(bindings[0]).toContain(4);
  });

  test("sans ligne mise à jour : le bail a glissé", async () => {
    const db = (() => Promise.resolve([])) as unknown as Bun.SQL;
    const wrote = await persistResolvedRunModel(
      db,
      { workerId: "worker-1" },
      { id: "run-1", organizationId: "org-1", leaseGeneration: 1 },
      null,
    );
    expect(wrote).toBe(false);
  });
});

describe("profileCatalogMissingCurrent", () => {
  test("warns only under a named profile when the catalog current slot is empty and a selection is posed", () => {
    expect(profileCatalogMissingCurrent(
      { provider: null, model: null },
      { provider: "opencode-free", model: "gpt-5.6-luna" },
      "atlas",
    )).toBe(true);
    expect(profileCatalogMissingCurrent(
      { provider: "opencode-free", model: "gpt-5.6-luna" },
      { provider: "opencode-free", model: "gpt-5.6-luna" },
      "atlas",
    )).toBe(false);
    expect(profileCatalogMissingCurrent(
      { provider: null, model: null },
      { provider: "opencode-free", model: "gpt-5.6-luna" },
      null,
    )).toBe(false);
    expect(profileCatalogMissingCurrent(null, { provider: "opencode-free", model: null }, "atlas")).toBe(false);
  });
});

describe("profileModelWriteNeeded", () => {
  const resolved = { provider: "xai-oauth", model: "grok-4.6" };

  test("writes when the profile block names another provider or another model", () => {
    expect(profileModelWriteNeeded({ provider: "openai-codex", model: "gpt-5.6-luna" }, resolved, "atlas")).toBe(true);
    expect(profileModelWriteNeeded({ provider: "xai-oauth", model: "grok-4.3" }, resolved, "atlas")).toBe(true);
  });

  // Un bloc profil vide compte comme un écart : sans écriture le gateway
  // retomberait sur son propre défaut, pas sur la sélection openedbot.
  test("writes when the profile block is empty", () => {
    expect(profileModelWriteNeeded({ provider: null, model: null }, resolved, "atlas")).toBe(true);
  });

  test("writes nothing when the profile already carries the resolved pair", () => {
    expect(profileModelWriteNeeded({ provider: "xai-oauth", model: "grok-4.6" }, resolved, "atlas")).toBe(false);
    expect(profileModelWriteNeeded({ provider: " xai-oauth ", model: " grok-4.6 " }, resolved, "atlas")).toBe(false);
  });

  test("writes nothing outside a profile, without a catalog, or on an incomplete pair", () => {
    expect(profileModelWriteNeeded({ provider: "openai-codex", model: "gpt-5.6-luna" }, resolved, null)).toBe(false);
    expect(profileModelWriteNeeded(null, resolved, "atlas")).toBe(false);
    expect(profileModelWriteNeeded({ provider: "openai-codex", model: "gpt-5.6-luna" }, { provider: "xai-oauth", model: null }, "atlas")).toBe(false);
    expect(profileModelWriteNeeded({ provider: "openai-codex", model: "gpt-5.6-luna" }, null, "atlas")).toBe(false);
  });
});

describe("servingProvider", () => {
  // Mesuré le 10-09 : profil cloué sur openai-codex, quota Codex épuisé, et
  // l'incident partait sur xai-oauth, banni six heures pour rien.
  test("imputes the failure to the provider the profile actually routes to", () => {
    expect(servingProvider({ provider: "openai-codex" }, "atlas", "xai-oauth")).toBe("openai-codex");
  });

  test("keeps the requested provider outside a profile", () => {
    expect(servingProvider({ provider: "openai-codex" }, null, "xai-oauth")).toBe("xai-oauth");
  });

  test("falls back to the requested provider when the profile block is unreadable", () => {
    expect(servingProvider(null, "atlas", "xai-oauth")).toBe("xai-oauth");
    expect(servingProvider({ provider: "   " }, "atlas", "xai-oauth")).toBe("xai-oauth");
    expect(servingProvider(null, "atlas", null)).toBe(null);
  });
});
