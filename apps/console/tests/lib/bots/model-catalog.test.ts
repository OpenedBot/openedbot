import { describe, expect, test } from "bun:test";
import { automaticRuntimeModel, globalModelIsAutomatic, modelsByRelease, runtimeGlobalModel } from "../../../src/lib/bots/model-catalog";

describe("runtimeGlobalModel : le même « modèle global » que Réglages → Modèles", () => {
  const host = { runtimeDefaultModel: "nemotron-3.5-lightning-free" };

  test("la préférence openedbot prime sur le modèle courant de l'hôte", () => {
    expect(runtimeGlobalModel({ selectedProvider: "openai-codex", selectedModel: "gpt-5.6-luna" }, host)).toBe("gpt-5.6-luna");
  });

  test("sans préférence, Hermes décide : c'est le modèle de l'hôte", () => {
    expect(runtimeGlobalModel({ selectedProvider: null, selectedModel: null }, host)).toBe("nemotron-3.5-lightning-free");
    expect(runtimeGlobalModel(null, host)).toBe("nemotron-3.5-lightning-free");
    expect(runtimeGlobalModel(null, null)).toBeNull();
  });

  test("sans défaut sur l'hôte, c'est le modèle que le worker choisit, pas « Aucun modèle »", () => {
    const noHostDefault = {
      currentProvider: null,
      runtimeDefaultModel: null,
      automaticModel: { provider: "anthropic", model: "claude-sonnet-5-5", source: "openedbot" as const },
    };
    expect(runtimeGlobalModel({ selectedProvider: null, selectedModel: null }, noHostDefault)).toBe("claude-sonnet-5-5");
    expect(runtimeGlobalModel(null, noHostDefault)).toBe("claude-sonnet-5-5");
    expect(automaticRuntimeModel(noHostDefault)).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", chosenBy: "openedbot" });
  });

  test("un défaut d'hôte que plus aucun fournisseur ne sert n'est pas affiché", () => {
    const unusable = { currentProvider: "openai-api", runtimeDefaultModel: "gpt-5.6-luna", automaticModel: null };
    expect(runtimeGlobalModel({ selectedProvider: null, selectedModel: null }, unusable)).toBeNull();
    expect(automaticRuntimeModel(unusable)).toEqual({ provider: null, model: null, chosenBy: "hermes" });
  });

  test("un instantané d'avant le champ retombe sur le défaut de l'hôte", () => {
    expect(automaticRuntimeModel({ currentProvider: "nous", runtimeDefaultModel: "nemotron-3.5-lightning-free" }))
      .toEqual({ provider: "nous", model: "nemotron-3.5-lightning-free", chosenBy: "hermes" });
  });

  test("le modèle global n'est « Auto » que sans aucune préférence openedbot", () => {
    expect(globalModelIsAutomatic({ selectedProvider: null, selectedModel: null })).toBe(true);
    expect(globalModelIsAutomatic(null)).toBe(true);
    expect(globalModelIsAutomatic({ selectedProvider: "anthropic", selectedModel: "claude-sonnet-5-5" })).toBe(false);
    expect(globalModelIsAutomatic({ selectedProvider: "anthropic", selectedModel: null })).toBe(false);
  });

  test("un fournisseur épinglé sans modèle ne retombe pas sur le repli écrit par le worker", () => {
    expect(runtimeGlobalModel({ selectedProvider: "openai-codex", selectedModel: null }, host)).toBeNull();
  });
});

describe("modelsByRelease : les modèles d'un fournisseur, du plus récent au plus ancien", () => {
  const ids = (list: string[]) => modelsByRelease(list.map((id) => ({ id }))).map((model) => model.id);

  test("la version prime sur l'ordre de Hermes, la date départage", () => {
    expect(ids([
      "claude-opus-4-5-20251101",
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "claude-fable-5.1",
      "claude-opus-5-5",
      "claude-opus-4-20250514",
    ])).toEqual([
      "claude-opus-5-5",
      "claude-fable-5.1",
      "claude-opus-5",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-20250514",
    ]);
  });

  test("une mineure à points se lit en décimale et une variante garde l'ordre de Hermes", () => {
    expect(ids(["grok-4.20-0309-reasoning", "gpt-x", "grok-4.3", "grok-4.7"])).toEqual([
      "grok-4.7",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "gpt-x",
    ]);
    expect(ids(["gpt-6-sol", "gpt-6-sol-900k", "gpt-6.1-sol"])).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-sol-900k"]);
  });

  test("deux alias d'un même modèle n'en font qu'un, le choix enregistré reste visible", () => {
    const models = ["claude-fable-5.1", "claude-opus-5-5", "claude-fable-5-1"].map((id) => ({ id }));
    expect(modelsByRelease(models).map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-fable-5.1"]);
    expect(modelsByRelease(models, ["claude-fable-5-1"]).map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
  });
});
