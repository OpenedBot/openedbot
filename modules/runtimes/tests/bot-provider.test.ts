import { describe, expect, test } from "bun:test";
import type { RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { resolveBotProvider } from "../src/domain/runtime/bot-provider";

const provider = (slug: string, model: string): RuntimeModelProviderDto => ({
  slug,
  name: slug,
  isCurrent: false,
  authenticated: true,
  alwaysAuthenticated: false,
  provesInference: false,
  acceptsApiKey: true,
  acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
  warning: null,
  authCommand: null,
  models: [{ id: model, fast: false, reasoning: false, isRuntimeDefault: false, freeTier: null }],
});

const providers = [provider("anthropic", "claude-sonnet"), provider("openai-codex", "gpt-5.4"), provider("moa", "gpt-5.4")];

describe("resolveBotProvider", () => {
  test("privilégie le modèle explicite du bot, comme le worker", () => {
    expect(resolveBotProvider("gpt-5.4", { selectedProvider: "anthropic", selectedModel: "claude-sonnet" }, providers)).toBe("openai-codex");
  });

  test("utilise la sélection runtime seulement lorsqu'un bot n'a pas de modèle", () => {
    expect(resolveBotProvider(null, { selectedProvider: "anthropic", selectedModel: "claude-sonnet" }, providers)).toBe("anthropic");
  });

  test("reproduit le repli du worker sans transformer l'agrégat moa en fournisseur facturé", () => {
    expect(resolveBotProvider(null, { selectedProvider: null, selectedModel: null }, providers)).toBe("anthropic");
    expect(resolveBotProvider("gpt-5.4", { selectedProvider: "moa", selectedModel: "gpt-5.4" }, [providers[2]!])).toBeNull();
  });

  test("ne réattribue pas MoA quand le worker l'aurait résolu en premier", () => {
    const moaFirst = [provider("moa", "gpt-5.4"), provider("openai-codex", "gpt-5.4")];
    expect(resolveBotProvider("gpt-5.4", { selectedProvider: "openai-codex", selectedModel: "gpt-5.4" }, moaFirst)).toBeNull();
    expect(resolveBotProvider(null, { selectedProvider: "moa", selectedModel: "gpt-5.4" }, moaFirst)).toBeNull();
  });
});
